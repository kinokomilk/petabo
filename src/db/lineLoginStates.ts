// LINE Login の OAuth state / nonce を短命保存するリポジトリ（0005 line_login_states）。
// /api/auth/line/start で発行し、/api/auth/line/callback で照合・即削除する。
import type { LineLoginStateRow } from "../types";
import { nowIso } from "./util";

// state の有効期限（10 分）。認可画面の操作時間に十分・かつ短命。
export const LINE_LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

export async function createLineLoginState(
  db: D1Database,
  state: string,
  nonce: string,
  inviteToken: string | null = null,
): Promise<void> {
  const now = new Date();
  const expires = new Date(now.getTime() + LINE_LOGIN_STATE_TTL_MS);
  await db
    .prepare(
      "INSERT INTO line_login_states (state, nonce, created_at, expires_at, invite_token) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(state, nonce, now.toISOString(), expires.toISOString(), inviteToken)
    .run();
}

// state を取得（存在チェックのみ。失効判定は呼び出し側で行う）。
export async function getLineLoginState(
  db: D1Database,
  state: string,
): Promise<LineLoginStateRow | null> {
  return db
    .prepare("SELECT * FROM line_login_states WHERE state = ?")
    .bind(state)
    .first<LineLoginStateRow>();
}

export async function deleteLineLoginState(
  db: D1Database,
  state: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM line_login_states WHERE state = ?")
    .bind(state)
    .run();
}

// state を照合して「一度きり」で消費する。
// 戻り値: 有効なら { nonce, inviteToken }、無効（不存在/失効）なら null。
// 行は存在すれば常に削除する（失効でも再利用させない）。
export async function consumeLineLoginState(
  db: D1Database,
  state: string,
): Promise<{ nonce: string; inviteToken: string | null } | null> {
  const row = await getLineLoginState(db, state);
  if (!row) return null;
  await deleteLineLoginState(db, state);
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { nonce: row.nonce, inviteToken: row.invite_token };
}

// 期限切れ state の掃除（Cron 等から呼ぶ想定）。
export async function purgeExpiredLineLoginStates(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM line_login_states WHERE expires_at < ?")
    .bind(nowIso())
    .run();
}
