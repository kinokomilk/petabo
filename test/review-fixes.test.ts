// code-reviewer 指摘に対する修正の回帰テスト。
// 1) メンバー削除でセッション破棄 2) assignee 検証 3) tag 409 事前チェック
// 4) login レート制限。
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, seedHousehold, seedMember, seedTag } from "./helpers";
import {
  isRateLimited,
  recordFailure,
  resetAttempts,
  RATE_LIMIT_MAX_ATTEMPTS,
} from "../src/db/loginAttempts";

describe("1) メンバー削除時にセッション破棄", () => {
  it("削除されたメンバーの既存セッションは即座に無効化される（401）", async () => {
    const { ownerSession, householdId } = await seedHousehold("session破棄家");
    const target = await seedMember(householdId, "破棄対象");

    // 削除前は通る
    const before = await call("GET", "/api/todos", { session: target.session });
    expect(before.status).toBe(200);

    // オーナーが削除
    const del = await call("DELETE", `/api/members/${target.userId}`, {
      session: ownerSession,
    });
    expect(del.status).toBe(200);

    // sessions 行が物理削除されている
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?",
    )
      .bind(target.userId)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);

    // 旧セッションでアクセスすると 401（membership 喪失ではなくセッション失効）
    const after = await call("GET", "/api/todos", { session: target.session });
    expect(after.status).toBe(401);
  });
});

describe("2) assignee_id の存在・所属検証", () => {
  it("同 household の active メンバーは担当に設定できる", async () => {
    const { ownerSession, householdId } = await seedHousehold("担当検証家");
    const member = await seedMember(householdId, "正当な担当者");
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "正当な担当", assigneeId: member.userId },
    });
    expect(res.status).toBe(201);
    expect((await res.json<any>()).assignee?.id).toBe(member.userId);
  });

  it("別 household のユーザーを担当に指定すると 400（作成）", async () => {
    const { ownerSession } = await seedHousehold("担当拒否家A");
    const other = await seedHousehold("担当拒否家B");
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "他家の人", assigneeId: other.ownerId },
    });
    expect(res.status).toBe(400);
  });

  it("存在しないユーザーを担当に指定すると 400（更新）", async () => {
    const { ownerSession } = await seedHousehold("担当更新家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "更新対象" },
      })
    ).json<any>();
    const res = await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { assigneeId: "ghost-user" },
    });
    expect(res.status).toBe(400);
  });

  it("removed メンバーは担当に設定できない（400）", async () => {
    const { ownerSession, householdId } = await seedHousehold("removed担当家");
    const member = await seedMember(householdId, "脱退者");
    // membership を removed にする
    await env.DB.prepare(
      "UPDATE memberships SET status = 'removed' WHERE household_id = ? AND user_id = ?",
    )
      .bind(householdId, member.userId)
      .run();
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "脱退者担当", assigneeId: member.userId },
    });
    expect(res.status).toBe(400);
  });

  it("assigneeId=null での担当解除は許可される（更新）", async () => {
    const { ownerSession, ownerId, householdId } = await seedHousehold("解除家");
    void householdId;
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "解除対象", assigneeId: ownerId },
      })
    ).json<any>();
    const res = await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { assigneeId: null },
    });
    expect(res.status).toBe(200);
    expect((await res.json<any>()).assignee).toBeNull();
  });

  it("private タスクは他人担当を剥がす挙動を維持（400 にはならない）", async () => {
    const { ownerSession, householdId } = await seedHousehold("private担当家");
    const member = await seedMember(householdId, "他人");
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: {
        title: "ないしょ",
        visibility: "private",
        assigneeId: member.userId,
      },
    });
    // 他人担当は null に剥がされ、検証も通って 201
    expect(res.status).toBe(201);
    expect((await res.json<any>()).assignee).toBeNull();
  });
});

describe("3) tag 作成の 409 事前チェック", () => {
  it("同名タグ作成は事前チェックで 409", async () => {
    const { ownerSession, householdId } = await seedHousehold("tag409家");
    await seedTag(householdId, "既存タグ");
    const res = await call("POST", "/api/tags", {
      session: ownerSession,
      body: { name: "既存タグ" },
    });
    expect(res.status).toBe(409);
  });

  it("新規名は 201 で作成される", async () => {
    const { ownerSession } = await seedHousehold("tag新規家");
    const res = await call("POST", "/api/tags", {
      session: ownerSession,
      body: { name: "まったく新しいタグ" },
    });
    expect(res.status).toBe(201);
  });

  it("長すぎるタグ名と不正な色は 400", async () => {
    const { ownerSession } = await seedHousehold("tag検証家");
    const longName = "あ".repeat(41);
    const tooLong = await call("POST", "/api/tags", {
      session: ownerSession,
      body: { name: longName },
    });
    expect(tooLong.status).toBe(400);

    const badColor = await call("POST", "/api/tags", {
      session: ownerSession,
      body: { name: "色が不正", color: "url(https://example.test/a)" },
    });
    expect(badColor.status).toBe(400);

    const ok = await call("POST", "/api/tags", {
      session: ownerSession,
      body: { name: "色OK", color: "#12abEF" },
    });
    expect(ok.status).toBe(201);
  });
});

describe("5) auth 入力長制限", () => {
  it("register は長すぎる名前・パスワードを 400 にする", async () => {
    const longName = "あ".repeat(81);
    const longPassword = "p".repeat(129);

    const badName = await call("POST", "/api/auth/register", {
      body: { householdName: longName, displayName: "owner", password: "secret1" },
    });
    expect(badName.status).toBe(400);

    const badPassword = await call("POST", "/api/auth/register", {
      body: { householdName: "長さ検証家", displayName: "owner", password: longPassword },
    });
    expect(badPassword.status).toBe(400);
  });

  it("join / login も長すぎる入力を 400 にする", async () => {
    const { ownerSession } = await seedHousehold("join長さ家");
    const invite = await (
      await call("POST", "/api/invites", { session: ownerSession })
    ).json<any>();

    const longDisplayName = "あ".repeat(41);
    const join = await call("POST", `/api/join/${invite.token}`, {
      body: { displayName: longDisplayName, password: "secret1" },
    });
    expect(join.status).toBe(400);

    const login = await call("POST", "/api/auth/login", {
      body: { displayName: longDisplayName, password: "secret1" },
    });
    expect(login.status).toBe(400);
  });
});

describe("6) DB trigger によるデータ制約", () => {
  it("enum / boolean / color の不正値を DB 側でも拒否する", async () => {
    const { householdId, ownerId } = await seedHousehold("制約家");
    const db = env.DB;
    const now = new Date().toISOString();

    await expect(
      db
        .prepare(
          `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
           VALUES (?, ?, 'admin', 'active', ?)`,
        )
        .bind(householdId, ownerId, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      db
        .prepare(
          `INSERT INTO todos
           (id, household_id, title, description, status, is_checklist, is_important, visibility, due_date, assignee_id, creator_id, created_at, updated_at)
           VALUES (?, ?, 'bad', '', 'blocked', 0, 0, 'shared', NULL, NULL, ?, ?, ?)`,
        )
        .bind(`todo_bad_${crypto.randomUUID()}`, householdId, ownerId, now, now)
        .run(),
    ).rejects.toThrow();

    await expect(
      db
        .prepare(
          "INSERT INTO tags (id, household_id, name, color, created_at) VALUES (?, ?, 'bad', 'red', ?)",
        )
        .bind(`tag_bad_${crypto.randomUUID()}`, householdId, now)
        .run(),
    ).rejects.toThrow();
  });
});

// login ルートは「最古の household」を単一スペースとして参照する。
// 他テスト（smoke の register/login）が依存するため、ここでは最古 household を
// 作り替えない。ルートの 429 経路は「既存の最古 household の key を上限まで
// 事前 seed して login が 429 を返す」ことで確認し、カウント/リセットの中身は
// loginAttempts ヘルパーの単体テストで検証する。
describe("4) login の軽量レート制限", () => {
  it("ヘルパー：上限超過で isRateLimited=true、成功(reset)で false に戻る", async () => {
    const db = env.DB;
    const key = `rl_unit_${crypto.randomUUID()}`;

    // 上限未満では未制限
    expect(await isRateLimited(db, key)).toBe(false);
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i++) {
      await recordFailure(db, key);
    }
    expect(await isRateLimited(db, key)).toBe(false);

    // 上限到達でブロック
    await recordFailure(db, key);
    expect(await isRateLimited(db, key)).toBe(true);

    // 成功でリセット → 解除
    await resetAttempts(db, key);
    expect(await isRateLimited(db, key)).toBe(false);
    const row = await db
      .prepare("SELECT COUNT(*) AS c FROM login_attempts WHERE key = ?")
      .bind(key)
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("ルート：最古 household の key を上限まで埋めると login が 429 を返す", async () => {
    const db = env.DB;
    // login が対象にする最古 household を取得（他テストが作成済みのはず）。
    const oldest = await db
      .prepare("SELECT id FROM households ORDER BY created_at ASC LIMIT 1")
      .first<{ id: string }>();
    expect(oldest).toBeTruthy();

    // login は displayName 必須なので、存在しないユーザー名でも 401（→通常）になる。
    // その key を上限まで事前 seed しておくと、ユーザー検証前に 429 で弾かれる。
    const displayName = `不在_${crypto.randomUUID().slice(0, 8)}`;
    const key = `${oldest!.id}:${displayName}`;
    for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i++) {
      await recordFailure(db, key);
    }

    const res = await call("POST", "/api/auth/login", {
      body: { displayName, password: "anything" },
    });
    expect(res.status).toBe(429);

    // リセットすれば（存在しないユーザーなので）401 に戻る
    await resetAttempts(db, key);
    const after = await call("POST", "/api/auth/login", {
      body: { displayName, password: "anything" },
    });
    expect(after.status).toBe(401);
  });
});
