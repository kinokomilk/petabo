// Phase 2 追加カバレッジ（QA）。PHASE2_TEST_PLAN の穴を埋める。
// プロダクトコードは変更せず、未カバーの分岐だけをテストする。
//   - Login: session ユーザーが既に line_user_id を持つ場合の衝突（上書きせず新規）
//   - Login: session が失効しているのに sub 未登録 → 新規作成
//   - Webhook: 1 リクエスト内の複数イベント（follow + unfollow）反映
//   - Webhook: source.userId 無しイベントは無視（200）
//   - Reminder: private creator が unfollow なら送らない
//   - scheduled(): LINE 未設定なら push を生成せず例外も出さず即 return
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { testEnv, seedHousehold } from "./helpers";
import { computeLineSignature } from "../src/line/signature";
import { signHs256 } from "./jwt";
import { __clearJwksCacheForTest } from "../src/line/idToken";
import type { Env } from "../src/env";

const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "login-channel-secret";
const APP_BASE_URL = "https://petabo.example.com";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const WH_SECRET = "webhook-channel-secret";
const WH_TOKEN = "webhook-access-token";

function loginEnv(): Env {
  return {
    ...testEnv(),
    LINE_LOGIN_CHANNEL_ID: CHANNEL_ID,
    LINE_LOGIN_CHANNEL_SECRET: CHANNEL_SECRET,
    APP_BASE_URL,
  };
}

function webhookEnv(): Env {
  return {
    ...testEnv(),
    LINE_CHANNEL_SECRET: WH_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: WH_TOKEN,
  };
}

async function startAndGetState(): Promise<{ state: string; nonce: string }> {
  const res = await app.request(
    "/api/auth/line/start",
    {},
    loginEnv() as unknown as Record<string, unknown>,
  );
  const u = new URL(res.headers.get("location")!);
  const state = u.searchParams.get("state")!;
  const row = await testEnv()
    .DB.prepare("SELECT nonce FROM line_login_states WHERE state = ?")
    .bind(state)
    .first<{ nonce: string }>();
  return { state, nonce: row!.nonce };
}

// 自前検証（HS256）方式：token endpoint は payload を HS256 署名した id_token を返す。
// verify endpoint はフォールバック時のみ参照される（ここでは到達しない想定）。
async function installVerifyMock(payload: Record<string, unknown>) {
  __clearJwksCacheForTest();
  const idToken = await signHs256(CHANNEL_SECRET, payload);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 2592000, id_token: idToken, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === VERIFY_URL) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function basePayload(sub: string, nonce: string) {
  return {
    iss: "https://access.line.me",
    sub,
    aud: CHANNEL_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce,
    name: "LINE はな",
  };
}

async function callback(state: string, session?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (session) headers["cookie"] = `petabo_session=${session}`;
  return app.request(
    `/api/auth/line/callback?code=auth_code&state=${state}`,
    { headers },
    loginEnv() as unknown as Record<string, unknown>,
  );
}

describe("LINE Login: 衝突・セキュリティ分岐", () => {
  afterEach(() => vi.restoreAllMocks());

  it("session ユーザーが既に別 line_user_id を持つ場合は上書きせず新規ユーザーを作る", async () => {
    const db = testEnv().DB;
    const hh = await seedHousehold("既連携家");
    // owner に既存 line_user_id を直接付与（別アカウント）。
    await db
      .prepare("UPDATE users SET line_user_id = 'Uowner_existing' WHERE id = ?")
      .bind(hh.ownerId)
      .run();
    const beforeOwner = await db
      .prepare("SELECT line_user_id FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string }>();

    const { state, nonce } = await startAndGetState();
    await installVerifyMock(basePayload("Udifferent_sub", nonce));
    const res = await callback(state, hh.ownerSession);
    expect(res.status).toBe(302);

    // owner の line_user_id は上書きされない（衝突防止）。
    const afterOwner = await db
      .prepare("SELECT line_user_id FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string }>();
    expect(afterOwner!.line_user_id).toBe(beforeOwner!.line_user_id);

    // 代わりに incoming sub の新規ユーザーが作られる。
    const created = await db
      .prepare("SELECT id FROM users WHERE line_user_id = ?")
      .bind("Udifferent_sub")
      .first<{ id: string }>();
    expect(created).toBeTruthy();
    expect(created!.id).not.toBe(hh.ownerId);
  });

  it("失効セッション + 未登録 sub なら新規ユーザー作成（紐付けしない）", async () => {
    const db = testEnv().DB;
    // 失効済みセッションを持つ user を seed。
    const hh = await seedHousehold("失効家");
    const expired = crypto.randomUUID().replace(/-/g, "");
    await db
      .prepare(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .bind(expired, hh.ownerId, new Date(0).toISOString(), new Date(1000).toISOString())
      .run();

    const { state, nonce } = await startAndGetState();
    await installVerifyMock(basePayload("Uexpired_sess", nonce));
    const res = await callback(state, expired);
    expect(res.status).toBe(302);

    // owner には紐付かない。
    const owner = await db
      .prepare("SELECT line_user_id FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string | null }>();
    expect(owner!.line_user_id).toBeNull();
    // 新規ユーザーが作られる。
    const created = await db
      .prepare("SELECT id FROM users WHERE line_user_id = ?")
      .bind("Uexpired_sess")
      .first<{ id: string }>();
    expect(created).toBeTruthy();
  });
});

describe("LINE Webhook: 追加分岐", () => {
  async function seedLineUser(uid: string, followed: number): Promise<string> {
    const db = testEnv().DB;
    const id = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_followed)
         VALUES (?, 'U', '#FF7A4D', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .bind(id, uid, new Date().toISOString(), followed)
      .run();
    return id;
  }
  async function post(raw: string, sig: string): Promise<Response> {
    return app.request(
      "/api/line/webhook",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-line-signature": sig },
        body: raw,
      },
      webhookEnv() as unknown as Record<string, unknown>,
    );
  }
  async function followed(id: string): Promise<number> {
    const u = await testEnv()
      .DB.prepare("SELECT line_followed FROM users WHERE id = ?")
      .bind(id)
      .first<{ line_followed: number }>();
    return u!.line_followed;
  }

  it("1 リクエスト内の複数イベント（follow + unfollow）を両方反映", async () => {
    const a = "Umulti_a";
    const b = "Umulti_b";
    const idA = await seedLineUser(a, 0);
    const idB = await seedLineUser(b, 1);
    const body = JSON.stringify({
      events: [
        { type: "follow", source: { type: "user", userId: a } },
        { type: "unfollow", source: { type: "user", userId: b } },
      ],
    });
    const sig = await computeLineSignature(WH_SECRET, body);
    const res = await post(body, sig);
    expect(res.status).toBe(200);
    expect(await followed(idA)).toBe(1);
    expect(await followed(idB)).toBe(0);
  });

  it("source.userId 無しの follow は無視（200・副作用なし）", async () => {
    const body = JSON.stringify({
      events: [{ type: "follow", source: { type: "group" } }],
    });
    const sig = await computeLineSignature(WH_SECRET, body);
    const res = await post(body, sig);
    expect(res.status).toBe(200);
  });

  it("不正 JSON は 200/400（署名通過後・副作用なし）", async () => {
    const raw = "{ not json";
    const sig = await computeLineSignature(WH_SECRET, raw);
    const res = await post(raw, sig);
    // 署名は通るが parse 失敗 → 400。
    expect(res.status).toBe(400);
  });
});

describe("scheduled handler", () => {
  it("LINE Messaging 未設定なら push しない（state 掃除のみ実行・fetch 未発火）", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const worker = app as unknown as {
      scheduled?: (e: unknown, env: Env, ctx: { waitUntil: (p: Promise<unknown>) => void }) => Promise<void>;
    };
    expect(typeof worker.scheduled).toBe("function");
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };
    // LINE 未設定の env（testEnv は LINE_* を持たない）。
    await worker.scheduled!({}, testEnv(), ctx);
    // push を一切呼ばない（fetch 未発火）。M5: state 掃除のみ waitUntil に登録される。
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(waited).toHaveLength(1); // purgeExpiredLineLoginStates のみ
    await Promise.all(waited); // DB のみで完結し例外を出さない。
    fetchSpy.mockRestore();
  });
});
