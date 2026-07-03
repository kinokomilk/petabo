// 各テストファイルの前にマイグレーションを適用する setup。
// マイグレーション本体は vitest.config.ts が TEST_MIGRATIONS バインディングで注入する。
import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

// 単一ランタイム・共有 D1（singleWorker）で全ファイルが同じ保存域を使うため、
// 各テストファイルの開始時に全テーブルを空にして実行順への依存を断つ。
// 特に register は「単一スペース（household が無いこと）」を前提とするため、
// 他ファイルの seed が残っていると 409 で連鎖失敗する。これを防ぐ。
const TABLES = [
  "line_login_states",
  "todo_reminders",
  "comments",
  "todo_tags",
  "checklist_items",
  "todos",
  "tags",
  "login_attempts",
  "sessions",
  "invite_tokens",
  "memberships",
  "users",
  "households",
];

beforeAll(async () => {
  const db = (env as any).DB;
  await applyD1Migrations(db, (env as any).TEST_MIGRATIONS);
  // FK 制約順を避けるため子テーブルから削除（D1 はデフォルト FK 緩めだが安全側）。
  for (const t of TABLES) {
    await db.prepare(`DELETE FROM ${t}`).run();
  }
});
