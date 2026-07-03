// セッションリポジトリ。トークンは sessions テーブルに保存し Cookie で送る。
import type { SessionRow, UserRow } from "../types";
import { nowIso } from "./util";

// セッション有効期限（30日）。
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// 1 ユーザーが保持できるセッション数の上限（端末・ブラウザ・LIFF 等を考慮し余裕を持たせる）。
export const MAX_SESSIONS_PER_USER = 10;

export async function createSession(
  db: D1Database,
  token: string,
  userId: string,
): Promise<void> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SESSION_TTL_MS);
  await db
    .prepare(
      "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token, userId, createdAt.toISOString(), expiresAt.toISOString())
    .run();
}

// トークンから user を引く（期限切れは無効扱いし、ついでに掃除）。
export async function getUserBySession(
  db: D1Database,
  token: string,
): Promise<UserRow | null> {
  const session = await db
    .prepare("SELECT * FROM sessions WHERE token = ?")
    .bind(token)
    .first<SessionRow>();
  if (!session) return null;
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    await deleteSession(db, token);
    return null;
  }
  return db
    .prepare("SELECT * FROM users WHERE id = ?")
    .bind(session.user_id)
    .first<UserRow>();
}

export async function deleteSession(
  db: D1Database,
  token: string,
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

// 指定ユーザーの全セッションを破棄（メンバー削除時の即時失効に使う）。
export async function deleteSessionsForUser(
  db: D1Database,
  userId: string,
): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

// ユーザーあたりのセッション数を上限内に保つ（最近 keepRecent 件だけ残す）。
// LINE id_token 経路（LIFF / OAuth callback）は呼ぶたびセッションを発行するため、
// 同一ユーザーのセッション行が無制限に積み上がらないよう、発行後に剪定する。
export async function pruneUserSessions(
  db: D1Database,
  userId: string,
  keepRecent: number = MAX_SESSIONS_PER_USER,
): Promise<void> {
  await db
    .prepare(
      `DELETE FROM sessions
       WHERE user_id = ?
         AND token NOT IN (
           SELECT token FROM sessions WHERE user_id = ?
           ORDER BY created_at DESC LIMIT ?
         )`,
    )
    .bind(userId, userId, keepRecent)
    .run();
}

// 期限切れセッションの一括削除（Phase 2 の Cron 等から呼ぶ想定）。
export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM sessions WHERE expires_at IS NOT NULL AND expires_at < ?")
    .bind(nowIso())
    .run();
}
