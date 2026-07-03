// ログイン失敗の軽量レート制限（スライディングウィンドウ）。
// TESTING §3「総当り対策（緩いレート制限でよい）」要求の最小実装。
// 1 key = 1 行。重い分散カウンタや KV は使わず D1 の小テーブルで完結させる。
import { nowIso } from "./util";

// 判断に迷う閾値はここで明示する（緩めに設定）。
// 15 分のウィンドウで 10 回失敗したらブロックする。誤ロックを避けるため緩め。
export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15分
export const RATE_LIMIT_MAX_ATTEMPTS = 10; // この回数「失敗」を超えたら 429

interface LoginAttemptRow {
  key: string;
  window_start: string;
  count: number;
}

// 現在この key がレート制限に達しているか判定する（副作用なし・読み取りのみ）。
// 期限切れウィンドウは未達扱い（次回 record 時に作り直す）。
export async function isRateLimited(
  db: D1Database,
  key: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT * FROM login_attempts WHERE key = ?")
    .bind(key)
    .first<LoginAttemptRow>();
  if (!row) return false;
  const windowAge = Date.now() - new Date(row.window_start).getTime();
  if (windowAge >= RATE_LIMIT_WINDOW_MS) return false; // 旧ウィンドウは無効
  return row.count >= RATE_LIMIT_MAX_ATTEMPTS;
}

// ログイン失敗を 1 件記録する。ウィンドウが切れていれば新ウィンドウで数え直す。
export async function recordFailure(db: D1Database, key: string): Promise<void> {
  const now = Date.now();
  const row = await db
    .prepare("SELECT * FROM login_attempts WHERE key = ?")
    .bind(key)
    .first<LoginAttemptRow>();
  if (!row || now - new Date(row.window_start).getTime() >= RATE_LIMIT_WINDOW_MS) {
    // 新規 or ウィンドウ切れ：window_start を now にして count=1 で開始。
    await db
      .prepare(
        `INSERT INTO login_attempts (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1`,
      )
      .bind(key, nowIso())
      .run();
    return;
  }
  // 現ウィンドウ内：count を加算。
  await db
    .prepare("UPDATE login_attempts SET count = count + 1 WHERE key = ?")
    .bind(key)
    .run();
}

// ログイン成功時に当該 key をリセット（行ごと削除）。
export async function resetAttempts(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}
