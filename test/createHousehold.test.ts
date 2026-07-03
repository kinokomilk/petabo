// 認証済みだが未参加のユーザーが POST /api/households でスペースを作りオーナーになる。
// 注: 同一テストファイル内はテスト間で D1 を共有する（per-test リセット無し）ため、
// 単一スペース制約に関わる検証は1テストにまとめる。
import { describe, it, expect } from "vitest";
import { call, seedSession, testEnv } from "./helpers";

// membership を持たない素のユーザーを直接作る。
async function seedBareUser(name = "ゲスト"): Promise<string> {
  const db = testEnv().DB;
  const id = `u_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
       VALUES (?, ?, '#FF7A4D', NULL, NULL, NULL, NULL, ?)`,
    )
    .bind(id, name, new Date().toISOString())
    .run();
  return id;
}

describe("POST /api/households（未参加ユーザーのスペース作成）", () => {
  it("未参加→作成で 201・オーナー化、以降は単一スペースで 409", async () => {
    const ownerSession = await seedSession(await seedBareUser("おや"));
    const create = await call("POST", "/api/households", {
      body: { householdName: "テスト家" },
      session: ownerSession,
    });
    expect(create.status).toBe(201);

    const me = await call("GET", "/api/auth/me", { session: ownerSession });
    const meJson = (await me.json()) as {
      joinState: string;
      membership: { role: string } | null;
    };
    expect(meJson.joinState).toBe("active");
    expect(meJson.membership?.role).toBe("owner");

    // 同じオーナーが再作成 → 既に参加済みで 409
    const again = await call("POST", "/api/households", {
      body: { householdName: "別の家" },
      session: ownerSession,
    });
    expect(again.status).toBe(409);

    // 別の未参加ユーザーも、既にスペースがあるので 409（単一スペース）
    const other = await seedSession(await seedBareUser("ほか"));
    const otherRes = await call("POST", "/api/households", {
      body: { householdName: "家2" },
      session: other,
    });
    expect(otherRes.status).toBe(409);
  });

  it("未認証は 401", async () => {
    const res = await call("POST", "/api/households", {
      body: { householdName: "x" },
    });
    expect(res.status).toBe(401);
  });

  it("householdName が空なら 400", async () => {
    const session = await seedSession(await seedBareUser("くう"));
    const res = await call("POST", "/api/households", {
      body: { householdName: "   " },
      session,
    });
    expect(res.status).toBe(400);
  });
});
