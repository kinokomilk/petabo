// セッション Cookie の発行/読取/削除。HttpOnly / SameSite=Lax、本番(HTTPS)は Secure。
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SESSION_TTL_MS } from "../db/sessions";

export const SESSION_COOKIE = "petabo_session";

function isSecureRequest(c: Context): boolean {
  // 本番は https。ローカル wrangler dev は http なので Secure を外す。
  const proto =
    c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return proto === "https";
}

export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(c),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
