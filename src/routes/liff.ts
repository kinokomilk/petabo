// LIFF（Phase 3 / Wave 2-b）。LINE 内で Web 本体を開くための入口。
// - GET /api/liff/config: 公開設定 { liffId } を返す（秘密は返さない）。
// - POST /api/auth/liff: LIFF が取得した id_token をサーバで検証し、
//   ユーザー解決（Web OAuth と同方針）→ HttpOnly Cookie セッションを発行する。
//
// 設計（docs/PHASE3_PRE_REVIEW.md「LIFF」節 / line-integration SKILL）:
// - LIFF_ID は公開設定。channel secret / access token はフロント/LIFF に渡さない。
// - id_token の検証はサーバ側で行う（client_id = LINE_LOGIN_CHANNEL_ID）。
//   verify endpoint（既存 verifyIdToken）を再利用し、iss/aud/exp/sub を自側でも再検証。
//   ※ nonce は LIFF 経路では roundtrip が無く比較値を持たないため検証を省略する
//     （= LIFF SDK 既定の id_token には nonce が無い／こちらに保存した期待値も無い）。
// - Cookie 発行はサーバ側（既存 setSessionCookie）。private 隔離は API 側で担保。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { getLiffConfig, getLineLoginConfig } from "../line/config";
import { verifyIdToken, LineApiError } from "../line/api";
import {
  verifyIdTokenLocally,
  IdTokenUnavailableError,
} from "../line/idToken";
import { uuid, generateToken } from "../auth/crypto";
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
  getActiveMembershipForUser,
  setLineFollowed,
} from "../db/households";

const LINE_ISS = "https://access.line.me";

// 新規 LINE ユーザーのアバター色（lineAuth と同じパレット・決定的選択）。
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
  return n.length > MAX_DISPLAY_NAME_LENGTH
    ? n.slice(0, MAX_DISPLAY_NAME_LENGTH)
    : n;
}

export const liffRoutes = new Hono<HonoEnv>();

// GET /api/liff/config
// 公開設定のみ返す。LIFF_ID 未設定なら { liffId: null }。秘密値は一切含めない。
liffRoutes.get("/liff/config", (c) => {
  return c.json(getLiffConfig(c.env));
});

// POST /api/auth/liff  body: { idToken: string, friendFlag?: boolean }
// LIFF 内で liff.getIDToken() した id_token を受け取り、サーバ側で検証してログインさせる。
// CSRF: この経路は Cookie ではなく id_token 提示でユーザーを確定する（LINE WebView から
//       クロスオリジンで呼ばれうるため、同一オリジン CSRF ミドルウェアの対象外に置く＝
//       index.ts で api（requireSameOriginMutation 配下）より前にマウントする）。
//       未検証の id_token では副作用を起こさない（検証通過まで DB を触らない）。
liffRoutes.post("/auth/liff", async (c) => {
  // LINE Login 未設定なら検証できない → 503。
  const login = getLineLoginConfig(c.env);
  if (!login) {
    return c.json({ error: "LINE ログインは未設定です" }, 503);
  }

  let body: { idToken?: unknown; friendFlag?: unknown } | null;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const idToken =
    body && typeof body.idToken === "string" ? body.idToken : "";
  if (!idToken) {
    return c.json({ error: "idToken が必要です" }, 400);
  }
  const friendFlag =
    typeof body?.friendFlag === "boolean" ? body.friendFlag : null;

  // id_token を自前検証（LIFF は ES256=JWKS。HS256 も両対応）。aud = LINE_LOGIN_CHANNEL_ID。
  // nonce は LIFF 経路では期待値を持たないため検証しない。
  // 実行不能（JWKS 取得失敗・kid 不一致・未対応 alg）に限り verify endpoint へフォールバック。
  // 署名不一致・claims 不正は確定拒否（フォールバックしない＝改ざんを通さない）。
  let payload;
  try {
    payload = await verifyIdTokenLocally({
      idToken,
      channelId: login.channelId,
      channelSecret: login.channelSecret,
    });
  } catch (e) {
    if (e instanceof IdTokenUnavailableError) {
      // ローカル検証が実行不能 → 既存の verify endpoint にフォールバック。
      try {
        payload = await verifyIdToken({
          idToken,
          channelId: login.channelId,
        });
      } catch (fe) {
        // verify が拒否（署名/aud 不正）→ 401。到達不能等（5xx）→ 502。
        const status = fe instanceof LineApiError ? fe.status : 401;
        return c.json(
          { error: "ID トークンの検証に失敗しました" },
          status >= 500 ? 502 : 401,
        );
      }
    } else {
      // 署名不一致 / claims 不正 / 形式不正 → 確定拒否（401）。
      return c.json(
        { error: "ID トークンの検証に失敗しました" },
        401,
      );
    }
  }

  // 自側でも再検証（多層防御）。nonce は LIFF 経路では検証しない（上記コメント参照）。
  if (payload.iss !== LINE_ISS) {
    return c.json({ error: "iss が不正です" }, 401);
  }
  if (payload.aud !== login.channelId) {
    return c.json({ error: "aud が不正です" }, 401);
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    return c.json({ error: "ID トークンの有効期限が切れています" }, 401);
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return c.json({ error: "sub が空です" }, 401);
  }

  const sub = payload.sub;

  // ユーザー解決（Web OAuth と同方針／既存連携を上書きしない）。
  // ① line_user_id = sub の既存ユーザー → そのユーザーでログイン。
  const existingByLine = await getUserByLineUserId(c.env.DB, sub);
  let userId: string;
  if (existingByLine) {
    userId = existingByLine.id;
  } else {
    // ② 未登録 sub + 有効な既存セッション → line_user_id IS NULL の行のみ紐付け。
    const sessionToken = readSessionCookie(c);
    const sessionUser = sessionToken
      ? await getUserBySession(c.env.DB, sessionToken)
      : null;
    if (sessionUser && sessionUser.line_user_id === null) {
      await linkLineToUser(c.env.DB, sessionUser.id, sub);
      userId = sessionUser.id;
    } else {
      // ③ 新規 LINE ユーザー作成（membership 無し＝未参加 / joinState none）。
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

  // セッション発行（HttpOnly Cookie）。Web セッションと同じ機構なので衝突しない。
  const newSession = generateToken();
  await createSession(c.env.DB, newSession, userId);
  setSessionCookie(c, newSession);
  // 量産対策：id_token 経路は呼ぶたびにセッションを発行するため、ユーザーあたりの
  // セッション数を上限内に剪定する（最近 MAX_SESSIONS_PER_USER 件のみ残す）。
  await pruneUserSessions(c.env.DB, userId);

  // joinState を返してフロントが遷移できるようにする（リダイレクトでなく JSON）。
  const membership = await getActiveMembershipForUser(c.env.DB, userId);
  const joinState = membership ? "active" : "none";
  return c.json({ ok: true, joinState });
});
