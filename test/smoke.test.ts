// スモークテスト：マイグレーション + 認証/参加 + todos CRUD + private 隔離。
import { describe, expect, it } from "vitest";
import { call, extractSession } from "./helpers";

describe("petabo API smoke", () => {
  let ownerSession: string;
  let memberSession: string;
  let inviteToken: string;
  let sharedTodoId: string;

  it("オーナー登録で household 作成・セッション発行", async () => {
    const res = await call("POST", "/api/auth/register", {
      body: { householdName: "サンプル家", displayName: "ゆず", password: "secret1" },
    });
    expect(res.status).toBe(201);
    const session = extractSession(res);
    expect(session).toBeTruthy();
    ownerSession = session!;
  });

  it("2人目の register は 409（招待経由を強制）", async () => {
    const res = await call("POST", "/api/auth/register", {
      body: { householdName: "べつ家", displayName: "だれか", password: "secret1" },
    });
    expect(res.status).toBe(409);
  });

  it("/auth/me がオーナーの参加状態を返す", async () => {
    const res = await call("GET", "/api/auth/me", { session: ownerSession });
    const me = await res.json<any>();
    expect(me.authenticated).toBe(true);
    expect(me.joinState).toBe("active");
    expect(me.membership.role).toBe("owner");
    expect(me.household.name).toBe("サンプル家");
  });

  it("初期タグが5件投入されている", async () => {
    const res = await call("GET", "/api/tags", { session: ownerSession });
    const tags = await res.json<any[]>();
    expect(tags.length).toBe(5);
    expect(tags.map((t) => t.name)).toContain("買い物");
  });

  it("オーナーが招待を発行できる", async () => {
    const res = await call("POST", "/api/invites", { session: ownerSession });
    expect(res.status).toBe(201);
    const inv = await res.json<any>();
    inviteToken = inv.token;
    expect(inv.joinPath).toBe(`/join/${inviteToken}`);
  });

  it("招待検証エンドポイントが valid を返す", async () => {
    const res = await call("GET", `/api/invites/${inviteToken}`);
    const body = await res.json<any>();
    expect(body.valid).toBe(true);
  });

  it("メンバーが /join/:token で参加できる", async () => {
    const res = await call("POST", `/api/join/${inviteToken}`, {
      body: { displayName: "あおい", password: "secret2" },
    });
    expect(res.status).toBe(201);
    memberSession = extractSession(res)!;
    expect(memberSession).toBeTruthy();
  });

  it("無効トークンの join は 404", async () => {
    const res = await call("POST", "/api/join/bogus", {
      body: { displayName: "x", password: "secret2" },
    });
    expect(res.status).toBe(404);
  });

  it("login（正しいパスワード）が通り、誤りは 401", async () => {
    const ok = await call("POST", "/api/auth/login", {
      body: { displayName: "あおい", password: "secret2" },
    });
    expect(ok.status).toBe(200);
    const ng = await call("POST", "/api/auth/login", {
      body: { displayName: "あおい", password: "wrong" },
    });
    expect(ng.status).toBe(401);
  });

  it("未認証は 401", async () => {
    const res = await call("GET", "/api/todos");
    expect(res.status).toBe(401);
  });

  it("/api/users が active メンバー2名を返す", async () => {
    const res = await call("GET", "/api/users", { session: ownerSession });
    const users = await res.json<any[]>();
    expect(users.length).toBe(2);
  });

  it("shared todo を tags + items 同時作成し hydrate される", async () => {
    const tagsRes = await call("GET", "/api/tags", { session: ownerSession });
    const tags = await tagsRes.json<any[]>();
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: {
        title: "週末の買い物",
        isChecklist: true,
        visibility: "shared",
        tagIds: [tags[1].id],
        items: ["牛乳", "卵", "パン"],
      },
    });
    expect(res.status).toBe(201);
    const todo = await res.json<any>();
    sharedTodoId = todo.id;
    expect(todo.checklist.total).toBe(3);
    expect(todo.checklist.done).toBe(0);
    expect(todo.checklistItems.map((item: { text: string }) => item.text)).toEqual([
      "牛乳",
      "卵",
      "パン",
    ]);
    expect(todo.tags.length).toBe(1);
    expect(todo.creator.displayName).toBe("ゆず");
  });

  it("メンバーも shared todo を一覧で見られる", async () => {
    const res = await call("GET", "/api/todos", { session: memberSession });
    const todos = await res.json<any[]>();
    expect(todos.some((t) => t.id === sharedTodoId)).toBe(true);
    expect(todos.find((t) => t.id === sharedTodoId)?.checklistItems).toHaveLength(3);
  });

  it("checklist 項目の done 切替で進捗が反映", async () => {
    const itemsRes = await call("GET", `/api/todos/${sharedTodoId}/items`, {
      session: ownerSession,
    });
    const items = await itemsRes.json<any[]>();
    await call("PATCH", `/api/items/${items[0].id}`, {
      session: ownerSession,
      body: { done: true },
    });
    const res = await call("GET", `/api/todos/${sharedTodoId}`, { session: ownerSession });
    const todo = await res.json<any>();
    expect(todo.checklist.done).toBe(1);
  });

  it("コメントの追加と取得", async () => {
    const res = await call("POST", `/api/todos/${sharedTodoId}/comments`, {
      session: memberSession,
      body: { body: "卵は10個入りで" },
    });
    expect(res.status).toBe(201);
    const comments = await res.json<any[]>();
    expect(comments[0].body).toBe("卵は10個入りで");
    expect(comments[0].user.displayName).toBe("あおい");
  });

  it("status フィルタ：done に更新すると todo フィルタから外れる", async () => {
    await call("PATCH", `/api/todos/${sharedTodoId}`, {
      session: ownerSession,
      body: { status: "done" },
    });
    const todoOnly = await call("GET", "/api/todos?status=todo", { session: ownerSession });
    const list = await todoOnly.json<any[]>();
    expect(list.some((t) => t.id === sharedTodoId)).toBe(false);
    const doneOnly = await call("GET", "/api/todos?status=done", { session: ownerSession });
    const doneList = await doneOnly.json<any[]>();
    expect(doneList.some((t) => t.id === sharedTodoId)).toBe(true);
  });

  it("private 隔離：作成者以外には一覧・直取得で見えない（404）", async () => {
    const create = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "ないしょのメモ", visibility: "private" },
    });
    const priv = await create.json<any>();

    // 一覧（メンバー視点）に出ない
    const memberList = await call("GET", "/api/todos", { session: memberSession });
    const list = await memberList.json<any[]>();
    expect(list.some((t) => t.id === priv.id)).toBe(false);

    // ID 直打ちも 404
    const direct = await call("GET", `/api/todos/${priv.id}`, { session: memberSession });
    expect(direct.status).toBe(404);

    // 作成者本人は見える
    const owner = await call("GET", `/api/todos/${priv.id}`, { session: ownerSession });
    expect(owner.status).toBe(200);
  });

  it("メンバーはオーナー専用操作（招待発行）ができない（403）", async () => {
    const res = await call("POST", "/api/invites", { session: memberSession });
    expect(res.status).toBe(403);
  });

  it("reminders：overdue / dueSoon を分類して返す", async () => {
    // 期限切れ＝期限の「日付(JST)」が今日より前。当日中は overdue にしないので前日にする。
    const past = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "期限切れタスク", dueDate: past },
    });
    await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "もうすぐタスク", dueDate: soon },
    });
    const res = await call("GET", "/api/todos/reminders", { session: ownerSession });
    const rem = await res.json<any>();
    expect(rem.overdue.some((t: any) => t.title === "期限切れタスク")).toBe(true);
    expect(rem.dueSoon.some((t: any) => t.title === "もうすぐタスク")).toBe(true);
  });

  it("todo のハード削除（CASCADE）", async () => {
    const del = await call("DELETE", `/api/todos/${sharedTodoId}`, {
      session: ownerSession,
    });
    expect(del.status).toBe(200);
    const get = await call("GET", `/api/todos/${sharedTodoId}`, { session: ownerSession });
    expect(get.status).toBe(404);
  });
});
