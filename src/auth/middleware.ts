// 認証ミドルウェア。Cookie→セッション検証→ user/household/membership を ctx に。
// 未認証・未参加（active membership なし）は 401。
import type { Context, MiddlewareHandler } from "hono";
import type { HonoEnv } from "../env";
import { readSessionCookie } from "./cookie";
import { getUserBySession } from "../db/sessions";
import {
  getActiveMembershipForUser,
  getHousehold,
} from "../db/households";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function sameOrigin(c: Context<HonoEnv>, origin: string): boolean {
  try {
    const reqUrl = new URL(c.req.url);
    const originUrl = new URL(origin);
    return reqUrl.protocol === originUrl.protocol && reqUrl.host === originUrl.host;
  } catch {
    return false;
  }
}

// Cookie 認証の状態変更 API 向け CSRF 防御。
// ブラウザが付ける Origin / Fetch Metadata がクロスサイトを示す場合に拒否する。
export const requireSameOriginMutation: MiddlewareHandler<HonoEnv> = async (
  c,
  next,
) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return c.json({ error: "csrf_forbidden" }, 403);
  }

  const origin = c.req.header("origin");
  if (origin && !sameOrigin(c, origin)) {
    return c.json({ error: "csrf_forbidden" }, 403);
  }

  return next();
};

export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const token = readSessionCookie(c);
  if (!token) return c.json({ error: "unauthenticated" }, 401);

  const user = await getUserBySession(c.env.DB, token);
  if (!user) return c.json({ error: "unauthenticated" }, 401);

  const membership = await getActiveMembershipForUser(c.env.DB, user.id);
  if (!membership) {
    // ログイン済だが未参加（招待待ち）。フロントは /api/auth/me で判別する。
    return c.json({ error: "not_member" }, 403);
  }

  const household = await getHousehold(c.env.DB, membership.household_id);
  if (!household) return c.json({ error: "household_not_found" }, 403);

  c.set("user", user);
  c.set("membership", membership);
  c.set("household", household);
  return next();
};

// オーナー限定（招待発行/失効・メンバー削除）。requireAuth の後に使う。
export const requireOwner: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const membership = c.get("membership");
  if (!membership || membership.role !== "owner") {
    return c.json({ error: "forbidden_owner_only" }, 403);
  }
  return next();
};

// requireAuth 通過後に必ず存在する値を取り出すヘルパー。
export function authCtx(c: Context<HonoEnv>) {
  return {
    user: c.get("user")!,
    household: c.get("household")!,
    membership: c.get("membership")!,
  };
}
