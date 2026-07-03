// LINE Webhook テスト。固定 secret + raw body で実署名を生成して検証する。
import { describe, expect, it } from "vitest";
import app from "../src/index";
import { testEnv } from "./helpers";
import { computeLineSignature } from "../src/line/signature";
import type { Env } from "../src/env";

const CHANNEL_SECRET = "webhook-channel-secret";
const CHANNEL_ACCESS_TOKEN = "webhook-access-token";

function lineEnv(): Env {
  return {
    ...testEnv(),
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: CHANNEL_ACCESS_TOKEN,
  };
}

// raw body と署名で webhook を叩く。
async function postWebhook(
  rawBody: string,
  signature: string | null,
  env: Env = lineEnv(),
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-line-signature"] = signature;
  return app.request(
    "/api/line/webhook",
    { method: "POST", headers, body: rawBody },
    env as unknown as Record<string, unknown>,
  );
}

// line_user_id を持つユーザーを seed。
async function seedLineUser(lineUserId: string, followed = 0): Promise<string> {
  const db = testEnv().DB;
  const id = `u_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_followed)
       VALUES (?, 'LINEユーザー', '#FF7A4D', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(id, lineUserId, new Date().toISOString(), followed)
    .run();
  return id;
}

async function getUser(id: string): Promise<any> {
  return testEnv().DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<any>();
}

function followBody(userId: string): string {
  return JSON.stringify({
    destination: "Udest",
    events: [{ type: "follow", source: { type: "user", userId } }],
  });
}

describe("LINE Webhook: 署名検証", () => {
  it("未設定（channel secret 無し）は 503", async () => {
    const res = await postWebhook("{}", "sig", testEnv());
    expect(res.status).toBe(503);
  });

  it("署名なしは 401（副作用ゼロ）", async () => {
    const uid = "Unosig";
    const id = await seedLineUser(uid, 0);
    const res = await postWebhook(followBody(uid), null);
    expect(res.status).toBe(401);
    expect((await getUser(id)).line_followed).toBe(0);
  });

  it("不正署名は 401（副作用ゼロ）", async () => {
    const uid = "Ubadsig";
    const id = await seedLineUser(uid, 0);
    const res = await postWebhook(followBody(uid), "AAAABBBBCCCC");
    expect(res.status).toBe(401);
    expect((await getUser(id)).line_followed).toBe(0);
  });

  it("body 改変は 401（署名は元 body 基準・DB 不変）", async () => {
    const uid = "Utamper";
    const id = await seedLineUser(uid, 0);
    const original = followBody(uid);
    const sig = await computeLineSignature(CHANNEL_SECRET, original);
    // 署名は original のものだが、送る body を改変する。
    const tampered = followBody(uid).replace("follow", "follow ");
    const res = await postWebhook(tampered, sig);
    expect(res.status).toBe(401);
    expect((await getUser(id)).line_followed).toBe(0);
  });
});

describe("LINE Webhook: イベント処理", () => {
  it("正署名の follow で line_followed=1", async () => {
    const uid = "Ufollow";
    const id = await seedLineUser(uid, 0);
    const body = followBody(uid);
    const sig = await computeLineSignature(CHANNEL_SECRET, body);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
    const u = await getUser(id);
    expect(u.line_followed).toBe(1);
    expect(u.line_unfollowed_at).toBeNull();
  });

  it("正署名の unfollow で line_followed=0 + unfollowed_at 記録", async () => {
    const uid = "Uunfollow";
    const id = await seedLineUser(uid, 1);
    const body = JSON.stringify({
      events: [{ type: "unfollow", source: { type: "user", userId: uid } }],
    });
    const sig = await computeLineSignature(CHANNEL_SECRET, body);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
    const u = await getUser(id);
    expect(u.line_followed).toBe(0);
    expect(u.line_unfollowed_at).toBeTruthy();
  });

  it("未知 line_user_id の follow は no-op（200・他行不変）", async () => {
    const body = followBody("Uunknown_nobody");
    const sig = await computeLineSignature(CHANNEL_SECRET, body);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
  });

  it("未知イベント（message）は 200 で無視", async () => {
    const uid = "Umessage";
    const id = await seedLineUser(uid, 0);
    const body = JSON.stringify({
      events: [
        {
          type: "message",
          source: { type: "user", userId: uid },
          message: { type: "text", text: "やあ" },
        },
      ],
    });
    const sig = await computeLineSignature(CHANNEL_SECRET, body);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
    // follow 状態は変えない。
    expect((await getUser(id)).line_followed).toBe(0);
  });

  it("空 events は 200", async () => {
    const body = JSON.stringify({ events: [] });
    const sig = await computeLineSignature(CHANNEL_SECRET, body);
    const res = await postWebhook(body, sig);
    expect(res.status).toBe(200);
  });
});
