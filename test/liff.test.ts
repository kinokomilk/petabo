// LIFF（Phase 3 / Wave 2-b）テスト。
// - GET /api/liff/config: LIFF_ID 設定/未設定で正しい値・秘密非露出。
// - POST /api/auth/liff: verify mock で検証失敗/ユーザー解決/未設定 503。
// verify ラッパ（globalThis.fetch）は mock する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { testEnv, seedHousehold } from "./helpers";
import type { Env } from "../src/env";
import { pruneUserSessions } from "../src/db/sessions";
import {
  generateEs256Key,
  jwksDocument,
  signEs256,
  tamperSignature,
  type Es256TestKey,
} from "./jwt";
import { __clearJwksCacheForTest } from "../src/line/idToken";

const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "login-channel-secret";
const APP_BASE_URL = "https://petabo.example.com";
const LIFF_ID = "1234567890-abcdefgh";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";
const CERTS_URL = "https://api.line.me/oauth2/v2.1/certs";

// LIFF は ES256。テスト用キーペアを使い、実 JWT を自前署名する。
let liffKey: Es256TestKey;

// LINE Login + LIFF を設定済みにした env。
function liffEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...testEnv(),
    LINE_LOGIN_CHANNEL_ID: CHANNEL_ID,
    LINE_LOGIN_CHANNEL_SECRET: CHANNEL_SECRET,
    APP_BASE_URL,
    LIFF_ID,
    ...overrides,
  };
}

async function req(
  path: string,
  init: RequestInit & { env?: Env } = {},
): Promise<Response> {
  const { env, ...rest } = init;
  return app.request(
    path,
    rest,
    (env ?? liffEnv()) as unknown as Record<string, unknown>,
  );
}

// /certs（JWKS）+ verify endpoint の mock。
// - certs: 'ok' なら JWKS を返す（ローカル ES256 検証成功）/ 'fail' なら 503（実行不能→fallback）。
// - verify: フォールバック時のみ参照。
type CertsMode = "ok" | "fail";
type VerifyResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; status: number }
  | { throws: true };

function installMock(opts: { certs?: CertsMode; verify?: VerifyResult } = {}) {
  const certs = opts.certs ?? "ok";
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === CERTS_URL) {
        if (certs === "fail") return new Response("err", { status: 503 });
        return new Response(JSON.stringify(jwksDocument([liffKey])), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === VERIFY_URL) {
        const verify = opts.verify;
        if (!verify) throw new Error("verify endpoint not expected");
        if ("throws" in verify) throw new Error("network");
        if (!verify.ok) return new Response("err", { status: verify.status });
        return new Response(JSON.stringify(verify.payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
}

// self 検証を通す有効 payload。
function validPayload(sub: string): Record<string, unknown> {
  return {
    iss: "https://access.line.me",
    sub,
    aud: CHANNEL_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "LIFF たろう",
    picture: "https://example.com/p.jpg",
  };
}

// claims を ES256 で署名した実 id_token を作る（ローカル検証が通る）。
async function signedToken(claims: Record<string, unknown>): Promise<string> {
  return signEs256(liffKey, claims);
}

async function liffLogin(
  idToken: string,
  init: { session?: string; env?: Env; friendFlag?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.session) headers["cookie"] = `petabo_session=${init.session}`;
  return req("/api/auth/liff", {
    method: "POST",
    headers,
    body: JSON.stringify({
      idToken,
      ...(typeof init.friendFlag === "boolean"
        ? { friendFlag: init.friendFlag }
        : {}),
    }),
    env: init.env,
  });
}

describe("GET /api/liff/config", () => {
  afterEach(() => vi.restoreAllMocks());

  it("LIFF_ID 設定済みなら liffId を返す", async () => {
    const res = await req("/api/liff/config");
    expect(res.status).toBe(200);
    const body = await res.json<{ liffId: string | null }>();
    expect(body.liffId).toBe(LIFF_ID);
  });

  it("LIFF_ID 未設定なら liffId は null", async () => {
    const res = await req("/api/liff/config", { env: testEnv() });
    expect(res.status).toBe(200);
    const body = await res.json<{ liffId: string | null }>();
    expect(body.liffId).toBeNull();
  });

  it("秘密値（channel secret / access token）を露出しない", async () => {
    const res = await req("/api/liff/config");
    const text = await res.text();
    expect(text).not.toContain(CHANNEL_SECRET);
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("channelSecret");
  });
});

describe("POST /api/auth/liff", () => {
  beforeEach(async () => {
    __clearJwksCacheForTest();
    liffKey = await generateEs256Key("liff-kid");
  });
  afterEach(() => vi.restoreAllMocks());

  it("LINE Login 未設定なら 503", async () => {
    // LIFF_ID はあっても Login channel が無ければ検証できない。
    const env = { ...testEnv(), LIFF_ID } as Env;
    const res = await liffLogin("h.p.s", { env });
    expect(res.status).toBe(503);
  });

  it("idToken が無ければ 400", async () => {
    const res = await req("/api/auth/liff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("aud 不正は 401（ローカル検証で claims 拒否）", async () => {
    installMock();
    const token = await signedToken({ ...validPayload("Uaud"), aud: "other-channel" });
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("iss 不正は 401", async () => {
    installMock();
    const token = await signedToken({ ...validPayload("Uiss"), iss: "https://evil.example" });
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("exp 切れは 401", async () => {
    installMock();
    const token = await signedToken({
      ...validPayload("Uexp"),
      exp: Math.floor(Date.now() / 1000) - 10,
    });
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("sub 空は 401", async () => {
    installMock();
    const token = await signedToken({ ...validPayload(""), sub: "" });
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("署名改ざんは verify endpoint にフォールバックせず 401（即拒否）", async () => {
    // verify endpoint が ok でも、改ざん署名は使われない。
    installMock({ verify: { ok: true, payload: validPayload("Utamper") } });
    const token = tamperSignature(await signedToken(validPayload("Utamper")));
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("ローカル実行不能（/certs 503）→ verify endpoint の 4xx は 401", async () => {
    installMock({ certs: "fail", verify: { ok: false, status: 400 } });
    const token = await signedToken(validPayload("Ufb1"));
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
  });

  it("ローカル実行不能（/certs 503）→ verify endpoint 到達不能（throw）は 502", async () => {
    installMock({ certs: "fail", verify: { throws: true } });
    const token = await signedToken(validPayload("Ufb2"));
    const res = await liffLogin(token);
    expect(res.status).toBe(502);
  });

  it("ローカル実行不能（/certs 503）→ verify endpoint 成功でログインできる", async () => {
    installMock({ certs: "fail", verify: { ok: true, payload: validPayload("UfbOk") } });
    const token = await signedToken(validPayload("UfbOk"));
    const res = await liffLogin(token);
    expect(res.status).toBe(200);
  });

  it("既存 line_user_id=sub はそのユーザーでログイン（新規作成しない）", async () => {
    const db = testEnv().DB;
    const existingId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
         VALUES (?, '既存さん', '#FF7A4D', ?, NULL, NULL, NULL, ?)`,
      )
      .bind(existingId, "UliffExisting", new Date().toISOString())
      .run();
    const before = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();

    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffExisting")));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie")!;
    const token = setCookie.match(/petabo_session=([^;]+)/)![1];
    const sess = await db
      .prepare("SELECT user_id FROM sessions WHERE token = ?")
      .bind(token)
      .first<{ user_id: string }>();
    expect(sess!.user_id).toBe(existingId);

    const after = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("未登録 sub + 既存セッションありで紐付け（上書きしない・新規作成しない）", async () => {
    const db = testEnv().DB;
    const hh = await seedHousehold("LIFF紐付け家");
    const before = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();

    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffLink")), {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; joinState: string }>();
    // owner は active membership 済み → joinState=active。
    expect(body.joinState).toBe("active");

    const owner = await db
      .prepare("SELECT line_user_id, line_linked_at, line_followed FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string; line_linked_at: string; line_followed: number }>();
    expect(owner!.line_user_id).toBe("UliffLink");
    expect(owner!.line_linked_at).toBeTruthy();
    // friendFlag 未指定なら既存状態（既定 0）を維持する。
    expect(owner!.line_followed).toBe(0);

    const after = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("未登録 sub + セッションありでも既存連携を上書きしない（別 sub のセッションユーザー）", async () => {
    const db = testEnv().DB;
    // 既に LINE 連携済みの owner（line_user_id 設定済み）のセッションで来る。
    const hh = await seedHousehold("LIFF既連携家");
    await db
      .prepare("UPDATE users SET line_user_id = ? WHERE id = ?")
      .bind("UalreadyLinked", hh.ownerId)
      .run();

    // 別の未登録 sub で LIFF ログイン。既存行は上書きされず、新規ユーザーが作られる。
    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffOtherSub")), {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);

    // owner の line_user_id は据え置き。
    const owner = await db
      .prepare("SELECT line_user_id FROM users WHERE id = ?")
      .bind(hh.ownerId)
      .first<{ line_user_id: string }>();
    expect(owner!.line_user_id).toBe("UalreadyLinked");

    // 新規ユーザーが UliffOtherSub で作られる。
    const created = await db
      .prepare("SELECT id FROM users WHERE line_user_id = ?")
      .bind("UliffOtherSub")
      .first<{ id: string }>();
    expect(created).toBeTruthy();
  });

  it("未登録 sub + セッションなしで新規ユーザー作成（未参加 / joinState none）", async () => {
    const db = testEnv().DB;
    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffNew")));
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; joinState: string }>();
    expect(body.ok).toBe(true);
    expect(body.joinState).toBe("none");

    const created = await db
      .prepare("SELECT * FROM users WHERE line_user_id = ?")
      .bind("UliffNew")
      .first<any>();
    expect(created).toBeTruthy();
    expect(created.display_name).toBe("LIFF たろう");
    expect(created.avatar_url).toBe("https://example.com/p.jpg");
    expect(created.line_followed).toBe(0);

    const m = await db
      .prepare("SELECT COUNT(*) c FROM memberships WHERE user_id = ?")
      .bind(created.id)
      .first<{ c: number }>();
    expect(m!.c).toBe(0);
  });

  it("検証失敗時は副作用を起こさない（ユーザーを作らない）", async () => {
    const db = testEnv().DB;
    const before = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();
    installMock();
    // 改ざん署名 → ローカル検証で即拒否（フォールバックしない）。
    const token = tamperSignature(await signedToken(validPayload("UliffNoSideEffect")));
    const res = await liffLogin(token);
    expect(res.status).toBe(401);
    const after = await db
      .prepare("SELECT COUNT(*) c FROM users")
      .first<{ c: number }>();
    expect(after!.c).toBe(before!.c);
  });

  it("LINE WebView からのクロスオリジン呼び出しでも CSRF で弾かれない", async () => {
    // sec-fetch-site: cross-site / 別 origin を付けても 403 にならない（id_token で確定）。
    installMock();
    const token = await signedToken(validPayload("UliffCors"));
    const res = await req("/api/auth/liff", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
        origin: "https://liff.line.me",
      },
      body: JSON.stringify({ idToken: token }),
    });
    expect(res.status).toBe(200);
  });

  it("friendFlag=true を検証後に line_followed=1 として同期する", async () => {
    const db = testEnv().DB;
    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffFriend")), {
      friendFlag: true,
    });
    expect(res.status).toBe(200);
    const created = await db
      .prepare("SELECT line_followed, line_unfollowed_at FROM users WHERE line_user_id = ?")
      .bind("UliffFriend")
      .first<{ line_followed: number; line_unfollowed_at: string | null }>();
    expect(created?.line_followed).toBe(1);
    expect(created?.line_unfollowed_at).toBeNull();
  });

  it("friendFlag=false を検証後に line_followed=0 として同期する", async () => {
    const db = testEnv().DB;
    const existingId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_followed)
         VALUES (?, '既存さん', '#FF7A4D', ?, NULL, NULL, NULL, ?, 1)`,
      )
      .bind(existingId, "UliffNotFriend", new Date().toISOString())
      .run();

    installMock();
    const res = await liffLogin(await signedToken(validPayload("UliffNotFriend")), {
      friendFlag: false,
    });
    expect(res.status).toBe(200);
    const existing = await db
      .prepare("SELECT line_followed, line_unfollowed_at FROM users WHERE id = ?")
      .bind(existingId)
      .first<{ line_followed: number; line_unfollowed_at: string | null }>();
    expect(existing?.line_followed).toBe(0);
    expect(existing?.line_unfollowed_at).toBeTruthy();
  });
});

describe("pruneUserSessions（セッション量産対策）", () => {
  it("ユーザーあたり最近 N 件だけ残す（古いものを剪定）", async () => {
    const db = testEnv().DB;
    const userId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO users (id, display_name, color, created_at) VALUES (?, 'x', '#FF7A4D', ?)",
      )
      .bind(userId, new Date().toISOString())
      .run();
    // created_at 昇順で 15 セッションを作る（tok_0 が最古、tok_14 が最新）。
    const base = Date.now();
    const future = new Date(base + 99 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 15; i++) {
      await db
        .prepare(
          "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        )
        .bind(`tok_${i}`, userId, new Date(base + i * 1000).toISOString(), future)
        .run();
    }

    await pruneUserSessions(db, userId, 10);

    const c = await db
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?")
      .bind(userId)
      .first<{ c: number }>();
    expect(c?.c).toBe(10);
    // 最古は剪定され、最新は残る。
    const oldest = await db
      .prepare("SELECT token FROM sessions WHERE token = 'tok_0'")
      .first();
    expect(oldest).toBeNull();
    const newest = await db
      .prepare("SELECT token FROM sessions WHERE token = 'tok_14'")
      .first();
    expect(newest).toBeTruthy();
  });
});
