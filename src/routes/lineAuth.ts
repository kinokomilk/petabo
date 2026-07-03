// LINE ログイン（OAuth / OIDC）。SPEC §4：LINE ログインが主。
// start: state/nonce 発行 → 認可 URL へ 302。
// callback: state 照合 → code 交換 → id_token 検証（verify endpoint + self 検証）
//           → ユーザー解決（既存 sub / 既存セッション紐付け / 新規）→ セッション発行。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { getLineLoginConfig } from "../line/config";
import {
  createLineLoginState,
  consumeLineLoginState,
} from "../db/lineLoginStates";
import {
  exchangeCodeForToken,
  getFriendshipStatus,
  verifyIdToken,
} from "../line/api";
import {
  verifyIdTokenLocally,
  IdTokenUnavailableError,
} from "../line/idToken";
import { generateToken, uuid } from "../auth/crypto";
import { setSessionCookie, readSessionCookie } from "../auth/cookie";
import {
  createSession,
  getUserBySession,
  pruneUserSessions,
} from "../db/sessions";
import {
  getUserByLineUserId,
  linkLineToUser,
  createLineUser,
  setLineFollowed,
  getInvite,
  isInviteValid,
  getActiveMembershipForUser,
  ensureActiveMembership,
} from "../db/households";

const LINE_AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
const LINE_ISS = "https://access.line.me";

// 新規 LINE ユーザーのアバター色（パレットから決定的に選ぶ）。
const AVATAR_COLORS = ["#FF7A4D", "#4C8DF6", "#3AA675", "#9B7EDE", "#E86FA0"];
function pickColorForLineUser(sub: string): string {
  let h = 0;
  for (let i = 0; i < sub.length; i++) h = (h * 31 + sub.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

const MAX_DISPLAY_NAME_LENGTH = 40;
function safeDisplayName(name: string | undefined | null): string {
  const n = (name ?? "").trim();
  if (!n) return "LINE ユーザー";
  return n.length > MAX_DISPLAY_NAME_LENGTH ? n.slice(0, MAX_DISPLAY_NAME_LENGTH) : n;
}

export const lineAuthRoutes = new Hono<HonoEnv>();

// GET /api/auth/line/start
lineAuthRoutes.get("/auth/line/start", async (c) => {
  const cfg = getLineLoginConfig(c.env);
  if (!cfg) {
    return c.json({ error: "LINE ログインは未設定です" }, 503);
  }

  // 招待リンク経由（/join/<token> の「LINEで参加」）なら token を state に紐付け、
  // callback で household の membership 作成に使う。長さ上限で異常値を弾く。
  const inviteRaw = (c.req.query("invite") ?? "").trim();
  const inviteToken = inviteRaw && inviteRaw.length <= 200 ? inviteRaw : null;

  const state = generateToken();
  const nonce = generateToken();
  await createLineLoginState(c.env.DB, state, nonce, inviteToken);

  const redirectUri = `${cfg.appBaseUrl}/api/auth/line/callback`;
  const url = new URL(LINE_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.channelId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("nonce", nonce);
  // 友だち追加を促す（同一プロバイダーで通知先を自動紐付け）。
  url.searchParams.set("bot_prompt", "aggressive");

  return c.redirect(url.toString(), 302);
});

// GET /api/auth/line/callback?code=&state=
lineAuthRoutes.get("/auth/line/callback", async (c) => {
  const cfg = getLineLoginConfig(c.env);
  if (!cfg) {
    return c.json({ error: "LINE ログインは未設定です" }, 503);
  }

  // ブラウザのリダイレクト先なので、検証失敗時は JSON ではなくトップへ 302。
  // クエリには安全な短いコードのみ載せる（秘密・詳細は出さない）。
  const failRedirect = () =>
    c.redirect(`${cfg.appBaseUrl}/?error=line_login`, 302);

  const code = c.req.query("code");
  const state = c.req.query("state");
  // ユーザーが認可をキャンセルした場合など。
  const oauthError = c.req.query("error");
  if (oauthError) {
    return failRedirect();
  }
  if (!code || !state) {
    return failRedirect();
  }

  // state 照合（存在＆未失効）→ 一度きりで削除。不一致/失効はトップへ。
  const consumed = await consumeLineLoginState(c.env.DB, state);
  if (!consumed) {
    return failRedirect();
  }
  const expectedNonce = consumed.nonce;
  const inviteToken = consumed.inviteToken;

  const redirectUri = `${cfg.appBaseUrl}/api/auth/line/callback`;

  // code をトークン交換。外部 4xx/5xx は安全に扱う（秘密非ログ）。
  let idToken: string;
  let accessToken: string;
  try {
    const token = await exchangeCodeForToken({
      code,
      redirectUri,
      channelId: cfg.channelId,
      channelSecret: cfg.channelSecret,
    });
    idToken = token.id_token;
    accessToken = token.access_token;
  } catch {
    // 4xx（コード不正等）/5xx・到達不能いずれも内部詳細・秘密は返さない。
    // ブラウザ遷移なのでトップへリダイレクト（安全なコードのみ）。
    return failRedirect();
  }

  // id_token を自前検証（HS256=channel secret / ES256=JWKS）。
  // 実行不能（JWKS 取得失敗・kid 不一致・未対応 alg）に限り verify endpoint へフォールバック。
  // 署名不一致・claims 不正は確定拒否（フォールバックしない＝改ざんを通さない）。
  let payload;
  try {
    payload = await verifyIdTokenLocally({
      idToken,
      channelId: cfg.channelId,
      channelSecret: cfg.channelSecret,
      nonce: expectedNonce,
    });
  } catch (e) {
    if (e instanceof IdTokenUnavailableError) {
      // ローカル検証が実行不能 → 既存の verify endpoint にフォールバック。
      try {
        payload = await verifyIdToken({
          idToken,
          channelId: cfg.channelId,
          nonce: expectedNonce,
        });
      } catch {
        return failRedirect();
      }
    } else {
      // 署名不一致 / claims 不正 / 形式不正 → 確定拒否。
      return failRedirect();
    }
  }

  // 自側でも検証（多層防御）。いずれの失敗もトップへリダイレクト。
  if (payload.iss !== LINE_ISS) {
    return failRedirect();
  }
  if (payload.aud !== cfg.channelId) {
    return failRedirect();
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return failRedirect();
  }
  if (expectedNonce && payload.nonce !== expectedNonce) {
    return failRedirect();
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return failRedirect();
  }

  const sub = payload.sub;
  let friendFlag: boolean | null = null;
  try {
    friendFlag = await getFriendshipStatus(accessToken);
  } catch {
    // 友だち状態APIの一時失敗でログイン自体は止めない。
    // 新規ユーザーは既定値 line_followed=0、既存ユーザーは現在値を維持する。
    friendFlag = null;
  }

  // ユーザー解決。
  // ① line_user_id = sub の既存ユーザー → そのユーザーでログイン。
  const existingByLine = await getUserByLineUserId(c.env.DB, sub);
  let userId: string;
  if (existingByLine) {
    userId = existingByLine.id;
  } else {
    // ② 有効な既存セッションがあればそのユーザーへ紐付け。
    const sessionToken = readSessionCookie(c);
    const sessionUser = sessionToken
      ? await getUserBySession(c.env.DB, sessionToken)
      : null;
    if (sessionUser && sessionUser.line_user_id === null) {
      await linkLineToUser(c.env.DB, sessionUser.id, sub);
      userId = sessionUser.id;
    } else {
      // ③ 新規ユーザー作成（membership 無し＝未参加 / joinState none）。
      const newId = uuid();
      await createLineUser(c.env.DB, {
        id: newId,
        displayName: safeDisplayName(payload.name),
        color: pickColorForLineUser(sub),
        lineUserId: sub,
        avatarUrl: payload.picture ?? null,
      });
      userId = newId;
    }
  }
  if (friendFlag !== null) {
    await setLineFollowed(c.env.DB, sub, friendFlag);
  }

  // 招待リンク経由なら household に参加させる（LINE を主とした参加導線）。
  // 既に active メンバーなら何もしない（冪等）。無効/失効した招待は黙って無視し、
  // ログイン自体は通す（未参加なら UnjoinedScreen に着地する）。
  if (inviteToken) {
    const invite = await getInvite(c.env.DB, inviteToken);
    if (isInviteValid(invite)) {
      // 既に active メンバー（別 household 含む単一スペース運用）なら触らない。
      const already = await getActiveMembershipForUser(c.env.DB, userId);
      if (!already) {
        await ensureActiveMembership(c.env.DB, invite.household_id, userId, "member");
      }
    }
  }

  // セッション発行 → トップへ 302。
  const newSession = generateToken();
  await createSession(c.env.DB, newSession, userId);
  setSessionCookie(c, newSession);
  // 量産対策：ユーザーあたりのセッション数を上限内に剪定する。
  await pruneUserSessions(c.env.DB, userId);
  return c.redirect(`${cfg.appBaseUrl}/`, 302);
});
