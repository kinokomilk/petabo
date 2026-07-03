// 認証・参加フロー。
// オーナー登録(register) と メンバー参加(join) を明確分離。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import type {
  RegisterOwnerBody,
  JoinBody,
  LoginBody,
  MeDTO,
} from "../types";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  uuid,
} from "../auth/crypto";
import {
  setSessionCookie,
  clearSessionCookie,
  readSessionCookie,
} from "../auth/cookie";
import { createSession, deleteSession, getUserBySession } from "../db/sessions";
import {
  isRateLimited,
  recordFailure,
  resetAttempts,
} from "../db/loginAttempts";
import {
  createHousehold,
  createUser,
  addMembership,
  countActiveMembers,
  findActiveUserByName,
  getActiveMembershipForUser,
  getHousehold,
  getInvite,
  isInviteValid,
} from "../db/households";
import { seedInitialTags } from "../db/tags";
import { toUserDTO } from "../db/util";

// アバター色パレット（登録順に割当）。SPEC §10-6。
const AVATAR_COLORS = [
  "#FF7A4D",
  "#4C8DF6",
  "#3AA675",
  "#9B7EDE",
  "#E86FA0",
];
const MAX_HOUSEHOLD_NAME_LENGTH = 80;
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_PASSWORD_LENGTH = 128;

function pickColor(index: number): string {
  return AVATAR_COLORS[index % AVATAR_COLORS.length];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isTooLong(v: string, max: number): boolean {
  return v.trim().length > max;
}

function isPasswordLengthInvalid(password: string): boolean {
  return password.length < 6 || password.length > MAX_PASSWORD_LENGTH;
}

export const authRoutes = new Hono<HonoEnv>();

// オーナー登録：家族スペース名 + 名前 + パスワードで household 作成。
// 単一スペース運用のため、既に household が存在する場合は register を拒否し join を促す。
authRoutes.post("/auth/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as RegisterOwnerBody | null;
  if (
    !body ||
    !isNonEmptyString(body.householdName) ||
    !isNonEmptyString(body.displayName) ||
    !isNonEmptyString(body.password)
  ) {
    return c.json({ error: "householdName, displayName, password は必須です" }, 400);
  }
  if (
    isTooLong(body.householdName, MAX_HOUSEHOLD_NAME_LENGTH) ||
    isTooLong(body.displayName, MAX_DISPLAY_NAME_LENGTH)
  ) {
    return c.json({ error: "名前が長すぎます" }, 400);
  }
  if (isPasswordLengthInvalid(body.password)) {
    return c.json({ error: "パスワードは6文字以上128文字以下にしてください" }, 400);
  }

  // 単一スペース：既存 household があればオーナー登録不可（招待経由で参加）。
  const existing = await c.env.DB.prepare(
    "SELECT id FROM households LIMIT 1",
  ).first<{ id: string }>();
  if (existing) {
    return c.json(
      { error: "既にスペースが存在します。招待リンクから参加してください" },
      409,
    );
  }

  const { hash, salt } = await hashPassword(body.password);
  const userId = uuid();
  const householdId = uuid();

  await createUser(c.env.DB, {
    id: userId,
    displayName: body.displayName.trim(),
    color: pickColor(0),
    passwordHash: hash,
    salt,
  });
  await createHousehold(c.env.DB, householdId, body.householdName.trim(), userId);
  await addMembership(c.env.DB, householdId, userId, "owner");
  await seedInitialTags(c.env.DB, householdId);

  const token = generateToken();
  await createSession(c.env.DB, token, userId);
  setSessionCookie(c, token);

  return c.json({ ok: true, userId, householdId }, 201);
});

// 認証済みだが未参加のユーザーが、新しい家族スペースを作ってオーナーになる。
// LINE ログイン勢など「パスワードを持たない認証ユーザー」が最初のオーナーに
// なる導線（register は名前+パスワードの新規ユーザー作成専用のため別口）。
// 単一スペース運用のため、既に household があれば拒否し招待参加を促す。
authRoutes.post("/households", async (c) => {
  const token = readSessionCookie(c);
  if (!token) return c.json({ error: "unauthenticated" }, 401);
  const user = await getUserBySession(c.env.DB, token);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  // 既にどこかのスペースに参加済みなら作成不可。
  const membership = await getActiveMembershipForUser(c.env.DB, user.id);
  if (membership) {
    return c.json({ error: "既にスペースに参加しています" }, 409);
  }

  const body = (await c.req.json().catch(() => null)) as {
    householdName?: unknown;
  } | null;
  if (!body || !isNonEmptyString(body.householdName)) {
    return c.json({ error: "householdName は必須です" }, 400);
  }
  if (isTooLong(body.householdName, MAX_HOUSEHOLD_NAME_LENGTH)) {
    return c.json({ error: "名前が長すぎます" }, 400);
  }

  // 単一スペース：既存 household があれば作成不可（招待経由で参加）。
  const existing = await c.env.DB.prepare(
    "SELECT id FROM households LIMIT 1",
  ).first<{ id: string }>();
  if (existing) {
    return c.json(
      { error: "既にスペースが存在します。招待リンクから参加してください" },
      409,
    );
  }

  const householdId = uuid();
  await createHousehold(
    c.env.DB,
    householdId,
    body.householdName.trim(),
    user.id,
  );
  await addMembership(c.env.DB, householdId, user.id, "owner");
  await seedInitialTags(c.env.DB, householdId);

  return c.json({ ok: true, householdId }, 201);
});

// メンバー参加：招待トークン検証 → user 作成 → active membership 追加。
authRoutes.post("/join/:token", async (c) => {
  const token = c.req.param("token");
  const body = (await c.req.json().catch(() => null)) as JoinBody | null;
  if (!body || !isNonEmptyString(body.displayName) || !isNonEmptyString(body.password)) {
    return c.json({ error: "displayName, password は必須です" }, 400);
  }
  if (isTooLong(body.displayName, MAX_DISPLAY_NAME_LENGTH)) {
    return c.json({ error: "名前が長すぎます" }, 400);
  }
  if (isPasswordLengthInvalid(body.password)) {
    return c.json({ error: "パスワードは6文字以上128文字以下にしてください" }, 400);
  }

  const invite = await getInvite(c.env.DB, token);
  if (!isInviteValid(invite)) {
    return c.json({ error: "招待リンクが無効か期限切れです" }, 404);
  }
  const householdId = invite.household_id;

  // 同名の active メンバーがいれば拒否（ログインと取り違え防止）。
  const dup = await findActiveUserByName(c.env.DB, householdId, body.displayName.trim());
  if (dup) {
    return c.json({ error: "同じ名前のメンバーが既にいます" }, 409);
  }

  const memberIndex = await countActiveMembers(c.env.DB, householdId);
  const { hash, salt } = await hashPassword(body.password);
  const userId = uuid();

  await createUser(c.env.DB, {
    id: userId,
    displayName: body.displayName.trim(),
    color: pickColor(memberIndex),
    passwordHash: hash,
    salt,
  });
  await addMembership(c.env.DB, householdId, userId, "member");

  const sessionToken = generateToken();
  await createSession(c.env.DB, sessionToken, userId);
  setSessionCookie(c, sessionToken);

  return c.json({ ok: true, userId, householdId }, 201);
});

// ログイン：household 内の active メンバーから display_name で引き、パスワード検証。
authRoutes.post("/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => null)) as LoginBody | null;
  if (!body || !isNonEmptyString(body.displayName) || !isNonEmptyString(body.password)) {
    return c.json({ error: "displayName, password は必須です" }, 400);
  }
  if (isTooLong(body.displayName, MAX_DISPLAY_NAME_LENGTH)) {
    return c.json({ error: "名前が長すぎます" }, 400);
  }
  if (body.password.length > MAX_PASSWORD_LENGTH) {
    return c.json({ error: "パスワードは128文字以下にしてください" }, 400);
  }

  // 単一スペース：最初の household を対象。
  const household = await c.env.DB.prepare(
    "SELECT * FROM households ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  if (!household) {
    return c.json({ error: "スペースがまだありません" }, 404);
  }

  const displayName = body.displayName.trim();
  // レート制限キー：household 内 display_name を優先、無ければ接続元 IP。
  // （display_name を使うことで「特定アカウントへの総当り」を直接抑える）
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown-ip";
  const rateKey = `${household.id}:${displayName || ip}`;
  if (await isRateLimited(c.env.DB, rateKey)) {
    return c.json(
      { error: "ログイン試行が多すぎます。しばらくして再試行してください" },
      429,
    );
  }

  const user = await findActiveUserByName(
    c.env.DB,
    household.id,
    displayName,
  );
  // user が無くても verifyPassword を呼びタイミング差を抑える。
  const ok = await verifyPassword(body.password, {
    hash: user?.password_hash ?? null,
    salt: user?.salt ?? null,
  });
  if (!user || !ok) {
    // 失敗を記録（緩いスロットル）。成功でリセットされる。
    await recordFailure(c.env.DB, rateKey);
    return c.json({ error: "名前またはパスワードが違います" }, 401);
  }

  // 成功：当該キーの失敗カウントをリセット。
  await resetAttempts(c.env.DB, rateKey);
  const token = generateToken();
  await createSession(c.env.DB, token, user.id);
  setSessionCookie(c, token);
  return c.json({ ok: true, userId: user.id });
});

authRoutes.post("/auth/logout", async (c) => {
  const token = readSessionCookie(c);
  if (token) await deleteSession(c.env.DB, token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// 現在ユーザー＋参加状態＋household。未参加/未認証も判別できる形で返す。
authRoutes.get("/auth/me", async (c) => {
  const token = readSessionCookie(c);
  const guest: MeDTO = {
    authenticated: false,
    user: null,
    membership: null,
    household: null,
    joinState: "none",
    lineLinked: false,
  };
  if (!token) return c.json(guest);

  const user = await getUserBySession(c.env.DB, token);
  if (!user) return c.json(guest);

  const membership = await getActiveMembershipForUser(c.env.DB, user.id);
  if (!membership) {
    // 認証済だが未参加（招待待ち）。
    return c.json<MeDTO>({
      authenticated: true,
      user: toUserDTO(user),
      membership: null,
      household: null,
      joinState: "none",
      lineLinked: user.line_user_id !== null,
    });
  }
  const household = await getHousehold(c.env.DB, membership.household_id);
  return c.json<MeDTO>({
    authenticated: true,
    user: toUserDTO(user),
    membership: { role: membership.role, status: membership.status },
    household: household
      ? { id: household.id, name: household.name, ownerId: household.owner_id }
      : null,
    joinState: "active",
    lineLinked: user.line_user_id !== null,
  });
});
