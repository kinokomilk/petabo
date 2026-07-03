// テスト共通ヘルパー：Cookie 付き fetch。
// マイグレーションは test/apply-migrations.ts(setupFile) が適用する。
import { env } from "cloudflare:test";
import app from "../src/index";
import type { Env } from "../src/env";

export function testEnv(): Env {
  return env as unknown as Env;
}

// ---- DB 直挿入のセットアップ（実行順非依存のシナリオ用） ----
// register は単一スペース制約があり 1 回しか通らない。追加テストでは
// household / user / membership / session を DB に直接作り、API を叩く。
function rid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export interface SeededHousehold {
  householdId: string;
  ownerId: string;
  ownerSession: string;
}

export interface SeededUser {
  userId: string;
  session: string;
}

// seed する household の created_at を「未来」にずらすためのカウンタ。
// smoke.test.ts の login/register は「最古の household」を単一スペースとして
// 参照するため、seed 由来の household が最古にならないようにして衝突を避ける。
let seedClock = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1年後を起点
function futureIso(): string {
  seedClock += 1000;
  return new Date(seedClock).toISOString();
}

// 任意名の household を作り、owner を 1 人入れてセッションを返す。
export async function seedHousehold(name = "テスト家"): Promise<SeededHousehold> {
  const db = testEnv().DB;
  const householdId = rid("hh");
  const ownerId = rid("u");
  const now = futureIso();
  await db.batch([
    db
      .prepare(
        "INSERT INTO households (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .bind(householdId, name, ownerId, now),
    db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
         VALUES (?, ?, ?, NULL, NULL, 'x', 'y', ?)`,
      )
      .bind(ownerId, `${name}-owner`, "#FF7A4D", now),
    db
      .prepare(
        `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
         VALUES (?, ?, 'owner', 'active', ?)`,
      )
      .bind(householdId, ownerId, now),
  ]);
  const ownerSession = await seedSession(ownerId);
  return { householdId, ownerId, ownerSession };
}

// 既存 household に active member を追加し、セッションを返す。
export async function seedMember(
  householdId: string,
  displayName: string,
  role: "owner" | "member" = "member",
): Promise<SeededUser> {
  const db = testEnv().DB;
  const userId = rid("u");
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
         VALUES (?, ?, ?, NULL, NULL, 'x', 'y', ?)`,
      )
      .bind(userId, displayName, "#4C8DF6", now),
    db
      .prepare(
        `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
         VALUES (?, ?, ?, 'active', ?)`,
      )
      .bind(householdId, userId, role, now),
  ]);
  const session = await seedSession(userId);
  return { userId, session };
}

// 指定ユーザーのセッションを作る（期限を ttlMs 後に設定。過去にすると失効）。
export async function seedSession(
  userId: string,
  ttlMs = 30 * 24 * 60 * 60 * 1000,
): Promise<string> {
  const db = testEnv().DB;
  const token = crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + ttlMs);
  await db
    .prepare(
      "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(token, userId, now.toISOString(), expires.toISOString())
    .run();
  return token;
}

// テスト用タグを 1 件作り tagId を返す。
export async function seedTag(
  householdId: string,
  name = "テストタグ",
): Promise<string> {
  const db = testEnv().DB;
  const id = rid("tag");
  await db
    .prepare(
      "INSERT INTO tags (id, household_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, householdId, name, "#3AA675", new Date().toISOString())
    .run();
  return id;
}

// Set-Cookie から petabo_session を抜き出す。
export function extractSession(res: Response): string | null {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return null;
  const m = setCookie.match(/petabo_session=([^;]+)/);
  return m ? m[1] : null;
}

// app.request のラッパー。cookie を付けられる。
export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; session?: string | null; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.session) headers["cookie"] = `petabo_session=${opts.session}`;
  if (opts.origin) headers["origin"] = opts.origin;
  return app.request(
    path,
    {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
    testEnv(),
  );
}
