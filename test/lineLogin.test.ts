// LINE ログイン（OAuth / OIDC）テスト。fetch ラッパ（token/verify）は mock。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { testEnv, seedHousehold } from "./helpers";
import { createInvite } from "../src/db/households";
import type { Env } from "../src/env";
import { signHs256, fakeEs256Token } from "./jwt";
import { __clearJwksCacheForTest } from "../src/line/idToken";

const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "login-channel-secret";
const APP_BASE_URL = "https://petabo.example.com";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const CERTS_URL = "https://api.line.me/oauth2/v2.1/certs";
const FRIENDSHIP_URL = "https://api.line.me/friendship/v1/status";

// LINE Login を設定済みにした env を返す。
function lineEnv(): Env {
  return {
    ...testEnv(),
    LINE_LOGIN_CHANNEL_ID: CHANNEL_ID,
    LINE_LOGIN_CHANNEL_SECRET: CHANNEL_SECRET,
    APP_BASE_URL,
  };
}

async function req(path: string, init: RequestInit & { env?: Env } = {}): Promise<Response> {
  const { env, ...rest } = init;
  return app.request(path, rest, (env ?? lineEnv()) as unknown as Record<string, unknown>);
}

// start を叩いて発行された state を DB から取り出す。
async function startAndGetState(): Promise<string> {
  const res = await req("/api/auth/line/start");
  expect(res.status).toBe(302);
  const loc = res.headers.get("location")!;
  const u = new URL(loc);
  return u.searchParams.get("state")!;
}

// fetch mock: token は固定 id_token、verify は与えた payload を返す。
type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number }
  | { throws: true };
type TokenResult = { ok: true } | { ok: false; status: number } | { throws: true };
type FriendshipResult =
  | { ok: true; friendFlag: boolean }
  | { ok: false; status: number }
  | { throws: true };

// 自前検証（HS256）方式に対応した mock。
// - token endpoint: verify.payload を HS256（CHANNEL_SECRET）で署名した id_token を返す
//   （opts.idToken 明示時はそれを優先＝署名不正・形式不正のテスト用）。
//   payload が無い場合（{}）でも署名はする（claims 検証で弾かれる挙動を再現）。
// - /certs: localVerifyMode='unavailable' なら 503（ローカル検証を実行不能にして verify
//   endpoint フォールバックを誘発）。それ以外では呼ばれない想定。
// - verify endpoint: フォールバック時のみ呼ばれる。opts.verify を返す。
async function installFetchMock(opts: {
  token?: TokenResult;
  verify?: VerifyResult;
  friendship?: FriendshipResult;
  idToken?: string;
  // 'local'（既定）= HS256 ローカル検証が通る / 'unavailable' = /certs 503 で
  //   ローカル検証を実行不能にし verify endpoint へフォールバックさせる。
  mode?: "local" | "unavailable";
}) {
  const token = opts.token ?? { ok: true };
  const friendship = opts.friendship ?? { ok: true, friendFlag: true };
  const mode = opts.mode ?? "local";

  // id_token を決める。明示があればそれ（不正トークンテスト用）。
  // 無ければ verify.payload を HS256 署名（ローカル検証が claims を評価できる）。
  let idToken = opts.idToken;
  if (idToken === undefined) {
    const v = opts.verify;
    const claims =
      v && "ok" in v && v.ok ? (v.payload as Record<string, unknown>) : {};
    idToken =
      mode === "unavailable"
        ? // ES256（kid 付き）だが /certs が 503 → ローカル検証は実行不能になる。
          fakeEs256Token(claims)
        : await signHs256(CHANNEL_SECRET, claims);
  }

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === TOKEN_URL) {
      if ("throws" in token) throw new Error("network");
      if (!token.ok) return new Response("err", { status: token.status });
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 2592000, id_token: idToken, token_type: "Bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === CERTS_URL) {
      // ローカル ES256 検証を実行不能にする（unavailable モード）。
      return new Response("err", { status: 503 });
    }
    if (url === VERIFY_URL) {
      const v = opts.verify ?? { ok: true, payload: {} };
      if ("throws" in v) throw new Error("network");
      if (!v.ok) return new Response("err", { status: v.status });
      return new Response(JSON.stringify(v.payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === FRIENDSHIP_URL) {
      if ("throws" in friendship) throw new Error("network");
      if (!friendship.ok) return new Response("err", { status: friendship.status });
      return new Response(JSON.stringify({ friendFlag: friendship.friendFlag }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

// 有効な payload を作る（self 検証を通す）。
function validPayload(sub: string, nonceFromVerify = true) {
  return {
    iss: "https://access.line.me",
    sub,
    aud: CHANNEL_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: nonceFromVerify ? "__will_be_replaced__" : undefined,
    name: "LINE たろう",
    picture: "https://example.com/p.jpg",
  };
}

// callback を叩く。verify payload の nonce を「DB に保存された nonce」に合わせるため、
// 事前に start → state を取り、line_login_states から nonce を読む。
async function callback(
  state: string,
  init: { session?: string; env?: Env } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.session) headers["cookie"] = `petabo_session=${init.session}`;
  return req(`/api/auth/line/callback?code=auth_code&state=${state}`, {
    headers,
    env: init.env,
  });
}

describe("LINE Login: start", () => {
  afterEach(() => vi.restoreAllMocks());

  it("未設定なら 503", async () => {
    const res = await req("/api/auth/line/start", { env: testEnv() });
    expect(res.status).toBe(503);
  });

  it("認可 URL へ 302（state/nonce/scope/bot_prompt を含む）", async () => {
    const res = await req("/api/auth/line/start");
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get("location")!);
    expect(u.origin + u.pathname).toBe("https://access.line.me/oauth2/v2.1/authorize");
    expect(u.searchParams.get("client_id")).toBe(CHANNEL_ID);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("scope")).toBe("openid profile");
    expect(u.searchParams.get("bot_prompt")).toBe("aggressive");
    expect(u.searchParams.get("state")).toBeTruthy();
    expect(u.searchParams.get("nonce")).toBeTruthy();
    expect(u.searchParams.get("redirect_uri")).toBe(`${APP_BASE_URL}/api/auth/line/callback`);
  });
});

describe("LINE Login: callback", () => {
  // 各テストで JWKS キャッシュを消し、テスト間の鍵/503 結果が混ざらないようにする。
  beforeEach(() => __clearJwksCacheForTest());
  afterEach(() => vi.restoreAllMocks());

  async function freshState(): Promise<{ state: string; nonce: string }> {
    const state = await startAndGetState();
    const row = await testEnv()
      .DB.prepare("SELECT nonce FROM line_login_states WHERE state = ?")
      .bind(state)
      .first<{ nonce: string }>();
    return { state, nonce: row!.nonce };
  }

  // 検証失敗はブラウザ向けに JSON ではなく APP_BASE_URL/?error=line_login へ 302。
  // 秘密・詳細はクエリに出さない（安全なコードのみ）。
  function expectFailRedirect(res: Response) {
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toBe(`${APP_BASE_URL}/?error=line_login`);
    // 秘密・詳細がクエリに漏れない（error=line_login のみ）。
    const u = new URL(loc);
    expect([...u.searchParams.keys()]).toEqual(["error"]);
    expect(u.searchParams.get("error")).toBe("line_login");
  }

  it("state 不一致はトップへ 302（DB 未保存の state・副作用なし）", async () => {
    await installFetchMock({ verify: { ok: true, payload: validPayload("Uxxx") } });
    const res = await callback("nonexistent_state");
    expectFailRedirect(res);
    // 副作用ゼロ: セッション Cookie を発行しない。
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("nonce 不一致はトップへ 302（verify payload の nonce が保存値と違う）", async () => {
    const { state } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload("Unonce"), nonce: "WRONG" } },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("aud 不正はトップへ 302", async () => {
    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload("Uaud"), aud: "other-channel", nonce } },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("iss 不正はトップへ 302", async () => {
    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload("Uiss"), iss: "https://evil.example", nonce } },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("exp 切れはトップへ 302", async () => {
    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: {
        ok: true,
        payload: { ...validPayload("Uexp"), exp: Math.floor(Date.now() / 1000) - 10, nonce },
      },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("sub 空はトップへ 302", async () => {
    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload(""), sub: "", nonce } },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("既存 line_user_id=sub はそのユーザーでログイン（新規作成しない）", async () => {
    const db = testEnv().DB;
    // 既存ユーザーに line_user_id を直挿入。
    const existingId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
         VALUES (?, '既存さん', '#FF7A4D', ?, NULL, NULL, NULL, ?)`,
      )
      .bind(existingId, "Uexisting", new Date().toISOString())
      .run();
    const before = await db.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();

    const { state, nonce } = await freshState();
    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Uexisting"), nonce } } });
    const res = await callback(state);
    expect(res.status).toBe(302);
    // 成功時はトップへ（error 無し）。
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/`);
    // セッションが existing ユーザーに発行される。
    const setCookie = res.headers.get("set-cookie")!;
    const token = setCookie.match(/petabo_session=([^;]+)/)![1];
    const sess = await db
      .prepare("SELECT user_id FROM sessions WHERE token = ?")
      .bind(token)
      .first<{ user_id: string }>();
    expect(sess!.user_id).toBe(existingId);
    // 新規作成されていない。
    const after = await db.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("未登録 sub + 既存セッションありで紐付け（新規作成しない）", async () => {
    const db = testEnv().DB;
    const hh = await seedHousehold("LINE紐付け家");
    const before = await db.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();

    const { state, nonce } = await freshState();
    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Ulink"), nonce } } });
    const res = await callback(state, { session: hh.ownerSession });
    expect(res.status).toBe(302);

    // owner に line_user_id が紐付く。
    const owner = await db
      .prepare("SELECT line_user_id, line_linked_at, line_followed FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string; line_linked_at: string; line_followed: number }>();
    expect(owner!.line_user_id).toBe("Ulink");
    expect(owner!.line_linked_at).toBeTruthy();
    expect(owner!.line_followed).toBe(1);
    const after = await db.prepare("SELECT COUNT(*) c FROM users").first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("未登録 sub + セッションなしで新規ユーザー作成（未参加）", async () => {
    const db = testEnv().DB;
    const { state, nonce } = await freshState();
    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Unew"), nonce } } });
    const res = await callback(state);
    expect(res.status).toBe(302);
    const created = await db
      .prepare("SELECT * FROM users WHERE line_user_id = ?")
      .bind("Unew")
      .first<any>();
    expect(created).toBeTruthy();
    expect(created.display_name).toBe("LINE たろう");
    expect(created.avatar_url).toBe("https://example.com/p.jpg");
    expect(created.line_followed).toBe(1);
    // membership は無い（未参加）。
    const m = await db
      .prepare("SELECT COUNT(*) c FROM memberships WHERE user_id = ?")
      .bind(created.id)
      .first<{ c: number }>();
    expect(m!.c).toBe(0);
  });

  it("招待トークン付き start → 新規 LINE ユーザーが household に参加（membership active）", async () => {
    const db = testEnv().DB;
    const hh = await seedHousehold("LINE招待家");
    const token = `inv_${crypto.randomUUID()}`;
    await createInvite(db, token, hh.householdId, hh.ownerId, null);

    // start に invite を付けて state に紐付ける。
    const startRes = await req(`/api/auth/line/start?invite=${token}`);
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const nonce = (
      await db
        .prepare("SELECT nonce FROM line_login_states WHERE state = ?")
        .bind(state)
        .first<{ nonce: string }>()
    )!.nonce;

    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Uinvite"), nonce } } });
    const res = await callback(state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/`);

    const created = await db
      .prepare("SELECT id FROM users WHERE line_user_id = ?")
      .bind("Uinvite")
      .first<{ id: string }>();
    const m = await db
      .prepare("SELECT status FROM memberships WHERE household_id = ? AND user_id = ?")
      .bind(hh.householdId, created!.id)
      .first<{ status: string }>();
    expect(m?.status).toBe("active");
  });

  it("無効な招待トークンは無視してログインのみ（未参加のまま）", async () => {
    const db = testEnv().DB;
    const startRes = await req(`/api/auth/line/start?invite=does_not_exist`);
    const state = new URL(startRes.headers.get("location")!).searchParams.get("state")!;
    const nonce = (
      await db
        .prepare("SELECT nonce FROM line_login_states WHERE state = ?")
        .bind(state)
        .first<{ nonce: string }>()
    )!.nonce;

    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Ubadinv"), nonce } } });
    const res = await callback(state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/`);
    const created = await db
      .prepare("SELECT id FROM users WHERE line_user_id = ?")
      .bind("Ubadinv")
      .first<{ id: string }>();
    const m = await db
      .prepare("SELECT COUNT(*) c FROM memberships WHERE user_id = ?")
      .bind(created!.id)
      .first<{ c: number }>();
    expect(m!.c).toBe(0);
  });

  it("state は一度きり（同じ state での再利用は 400）", async () => {
    const { state, nonce } = await freshState();
    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Uonce"), nonce } } });
    const first = await callback(state);
    expect(first.status).toBe(302);
    // 成功時は素直にトップへ（error 無し）。
    expect(first.headers.get("location")).toBe(`${APP_BASE_URL}/`);
    // 同じ state を再使用 → state 消費済みなので失敗リダイレクト。
    await installFetchMock({ verify: { ok: true, payload: { ...validPayload("Uonce"), nonce } } });
    const second = await callback(state);
    expectFailRedirect(second);
  });

  it("token endpoint の 4xx を安全に処理（トップへ 302・クエリに秘密を出さない）", async () => {
    const { state } = await freshState();
    await installFetchMock({ token: { ok: false, status: 400 } });
    const res = await callback(state);
    expectFailRedirect(res);
    // 内部詳細・秘密（auth_code 等）を Location に出さない。
    expect(res.headers.get("location")).not.toContain("auth_code");
  });

  it("ローカル検証が実行不能（/certs 503）→ verify endpoint フォールバックで成功", async () => {
    const { state, nonce } = await freshState();
    // ES256 だが /certs 503 でローカル検証は実行不能 → verify endpoint で成功。
    await installFetchMock({
      mode: "unavailable",
      verify: { ok: true, payload: { ...validPayload("Ufallback"), nonce } },
    });
    const res = await callback(state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_BASE_URL}/`);
  });

  it("ローカル実行不能 → verify endpoint の 4xx（署名不正等）はトップへ 302", async () => {
    const { state } = await freshState();
    await installFetchMock({ mode: "unavailable", verify: { ok: false, status: 400 } });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("ローカル実行不能 → verify endpoint が到達不能（throw）でもトップへ 302", async () => {
    const { state } = await freshState();
    await installFetchMock({ mode: "unavailable", verify: { throws: true } });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("署名改ざん（HS256）は verify endpoint にフォールバックせず即トップへ 302", async () => {
    const { state, nonce } = await freshState();
    // 正しい署名を作ってから末尾を壊す。verify endpoint が ok を返しても使われない。
    const { signHs256: _s } = await import("./jwt");
    const good = await _s(CHANNEL_SECRET, { ...validPayload("Utamper"), nonce });
    const tampered = good.slice(0, -1) + (good.slice(-1) === "A" ? "B" : "A");
    await installFetchMock({
      idToken: tampered,
      verify: { ok: true, payload: { ...validPayload("Utamper"), nonce } },
    });
    const res = await callback(state);
    expectFailRedirect(res);
  });

  it("friendship status が false なら line_followed=0 のまま通知対象にしない", async () => {
    const db = testEnv().DB;
    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload("Unotfriend"), nonce } },
      friendship: { ok: true, friendFlag: false },
    });
    const res = await callback(state);
    expect(res.status).toBe(302);
    const created = await db
      .prepare("SELECT line_followed FROM users WHERE line_user_id = ?")
      .bind("Unotfriend")
      .first<{ line_followed: number }>();
    expect(created?.line_followed).toBe(0);
  });

  it("friendship status API が一時失敗してもログインは継続し、既存状態を維持する", async () => {
    const db = testEnv().DB;
    const existingId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_followed)
         VALUES (?, '既存さん', '#FF7A4D', ?, NULL, NULL, NULL, ?, 1)`,
      )
      .bind(existingId, "UfriendshipDown", new Date().toISOString())
      .run();

    const { state, nonce } = await freshState();
    await installFetchMock({
      verify: { ok: true, payload: { ...validPayload("UfriendshipDown"), nonce } },
      friendship: { throws: true },
    });
    const res = await callback(state);
    expect(res.status).toBe(302);
    const existing = await db
      .prepare("SELECT line_followed FROM users WHERE id = ?")
      .bind(existingId)
      .first<{ line_followed: number }>();
    expect(existing?.line_followed).toBe(1);
  });
});
