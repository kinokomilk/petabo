// 認可境界・参加・セッションの追加テスト（TESTING §1 認証/参加/認可, §3 認可境界）。
// register の単一スペース制約を避けるため DB 直 seed で household/user を用意し API を叩く。
import { describe, expect, it } from "vitest";
import { call, seedHousehold, seedMember, seedSession } from "./helpers";

describe("認可境界とオーナー限定操作", () => {
  it("作成者以外は shared タスクの公開範囲を変更できない（403）", async () => {
    const { ownerSession, householdId } = await seedHousehold("公開範囲家");
    const member = await seedMember(householdId, "共同編集者");

    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "共有タスク", visibility: "shared" },
      })
    ).json<any>();

    // 共有タスクの通常編集は許可。
    const titlePatch = await call("PATCH", `/api/todos/${todo.id}`, {
      session: member.session,
      body: { title: "共同編集済み" },
    });
    expect(titlePatch.status).toBe(200);

    // 公開範囲の変更は作成者のみ。
    const visibilityPatch = await call("PATCH", `/api/todos/${todo.id}`, {
      session: member.session,
      body: { visibility: "private" },
    });
    expect(visibilityPatch.status).toBe(403);

    const fetched = await (
      await call("GET", `/api/todos/${todo.id}`, { session: ownerSession })
    ).json<any>();
    expect(fetched.visibility).toBe("shared");
  });

  it("非オーナー(member)は招待発行できない（403）", async () => {
    const { householdId } = await seedHousehold("発行家");
    const member = await seedMember(householdId, "メンバーA");
    const res = await call("POST", "/api/invites", { session: member.session });
    expect(res.status).toBe(403);
  });

  it("オーナーは招待発行→失効ができる。member は失効できない（403）", async () => {
    const { ownerSession, householdId } = await seedHousehold("失効家");
    const member = await seedMember(householdId, "メンバーB");

    const created = await call("POST", "/api/invites", { session: ownerSession });
    expect(created.status).toBe(201);
    const inv = await created.json<any>();

    // member は失効不可
    const denied = await call("DELETE", `/api/invites/${inv.token}`, {
      session: member.session,
    });
    expect(denied.status).toBe(403);

    // owner は失効可
    const ok = await call("DELETE", `/api/invites/${inv.token}`, {
      session: ownerSession,
    });
    expect(ok.status).toBe(200);

    // 失効後はトークン検証で 404
    const check = await call("GET", `/api/invites/${inv.token}`);
    expect(check.status).toBe(404);
  });

  it("メンバー削除：member は不可（403）、owner は可。自分自身は削除不可（400）", async () => {
    const { ownerSession, ownerId, householdId } = await seedHousehold("削除家");
    const target = await seedMember(householdId, "削除対象");
    const other = await seedMember(householdId, "別メンバー");

    // 非オーナーは他人を削除できない
    const denied = await call("DELETE", `/api/members/${target.userId}`, {
      session: other.session,
    });
    expect(denied.status).toBe(403);

    // オーナーが自分自身を削除しようとすると 400
    const self = await call("DELETE", `/api/members/${ownerId}`, {
      session: ownerSession,
    });
    expect(self.status).toBe(400);

    // オーナーが対象メンバーを削除（200）
    const ok = await call("DELETE", `/api/members/${target.userId}`, {
      session: ownerSession,
    });
    expect(ok.status).toBe(200);

    // 削除と同時に対象のセッションも破棄するため、旧セッションは 401（失効）になる。
    const afterRemoval = await call("GET", "/api/todos", {
      session: target.session,
    });
    expect(afterRemoval.status).toBe(401);

    // 同じメンバーを再度削除しようとすると active でないので 404
    const again = await call("DELETE", `/api/members/${target.userId}`, {
      session: ownerSession,
    });
    expect(again.status).toBe(404);
  });

  it("存在しないメンバーの削除は 404", async () => {
    const { ownerSession } = await seedHousehold("不在家");
    const res = await call("DELETE", "/api/members/does-not-exist", {
      session: ownerSession,
    });
    expect(res.status).toBe(404);
  });
});

describe("セッション失効・期限切れ", () => {
  it("状態変更APIはクロスサイト Origin を拒否する（403）", async () => {
    const { ownerSession } = await seedHousehold("csrf家");
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "csrf" },
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
  });

  it("期限切れセッションは 401（自動掃除される）", async () => {
    const { householdId } = await seedHousehold("失効session家");
    const member = await seedMember(householdId, "期限切れ太郎");
    // 過去に失効するセッションを別途発行
    const expired = await seedSession(member.userId, -1000);
    const res = await call("GET", "/api/todos", { session: expired });
    expect(res.status).toBe(401);
  });

  it("ログアウト後はセッション無効化され 401", async () => {
    const { ownerSession } = await seedHousehold("logout家");
    // ログアウト前は通る
    const before = await call("GET", "/api/todos", { session: ownerSession });
    expect(before.status).toBe(200);
    // ログアウト
    const out = await call("POST", "/api/auth/logout", { session: ownerSession });
    expect(out.status).toBe(200);
    // ログアウト後は同じトークンで 401
    const after = await call("GET", "/api/todos", { session: ownerSession });
    expect(after.status).toBe(401);
  });

  it("デタラメなセッショントークンは 401", async () => {
    const res = await call("GET", "/api/todos", { session: "bogus-token-xyz" });
    expect(res.status).toBe(401);
  });

  it("認証済みだが未参加（membership なし）ユーザーは 403 not_member", async () => {
    // household を作るが、別 user を membership 無しで作りセッションだけ付与する。
    const { householdId } = await seedHousehold("未参加家");
    const db = (await import("cloudflare:test")).env.DB as any;
    const orphanId = `u_${crypto.randomUUID()}`;
    await db
      .prepare(
        `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
         VALUES (?, '孤児', '#000000', NULL, NULL, 'x', 'y', ?)`,
      )
      .bind(orphanId, new Date().toISOString())
      .run();
    const session = await seedSession(orphanId);
    const res = await call("GET", "/api/todos", { session });
    expect(res.status).toBe(403);
    // /auth/me は authenticated:true / joinState:none を返す
    const me = await call("GET", "/api/auth/me", { session });
    const body = await me.json<any>();
    expect(body.authenticated).toBe(true);
    expect(body.joinState).toBe("none");
    // householdId は未参加判定に使うだけ（参照保持で未使用変数回避）
    expect(householdId).toBeTruthy();
  });
});
