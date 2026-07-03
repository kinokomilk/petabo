// private 隔離の網羅（TESTING §3 private 隔離 / §1 visibility 切替）。
import { describe, expect, it } from "vitest";
import { call, seedHousehold, seedMember } from "./helpers";

describe("private タスクの隔離", () => {
  it("private は作成者のみ：一覧/直取得/items/comments/reminders すべてで他人に 404・非表示", async () => {
    const { ownerSession, householdId } = await seedHousehold("ないしょ家");
    const member = await seedMember(householdId, "他人");

    // overdue にするため前日（当日中は overdue 扱いにしない仕様）。
    const past = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const create = await call("POST", "/api/todos", {
      session: ownerSession,
      body: {
        title: "私的メモ",
        visibility: "private",
        isChecklist: true,
        items: ["秘密1", "秘密2"],
        dueDate: past,
      },
    });
    expect(create.status).toBe(201);
    const priv = await create.json<any>();

    // 一覧（他人）に出ない
    const list = await (
      await call("GET", "/api/todos", { session: member.session })
    ).json<any[]>();
    expect(list.some((t) => t.id === priv.id)).toBe(false);

    // 直取得 404
    expect(
      (await call("GET", `/api/todos/${priv.id}`, { session: member.session })).status,
    ).toBe(404);

    // items 取得 404
    expect(
      (await call("GET", `/api/todos/${priv.id}/items`, { session: member.session }))
        .status,
    ).toBe(404);

    // items 追加 404
    expect(
      (
        await call("POST", `/api/todos/${priv.id}/items`, {
          session: member.session,
          body: { text: "横入り" },
        })
      ).status,
    ).toBe(404);

    // comments 取得 404
    expect(
      (await call("GET", `/api/todos/${priv.id}/comments`, { session: member.session }))
        .status,
    ).toBe(404);

    // comments 追加 404
    expect(
      (
        await call("POST", `/api/todos/${priv.id}/comments`, {
          session: member.session,
          body: { body: "見えるはず無い" },
        })
      ).status,
    ).toBe(404);

    // PATCH / DELETE も 404
    expect(
      (
        await call("PATCH", `/api/todos/${priv.id}`, {
          session: member.session,
          body: { status: "done" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/todos/${priv.id}`, { session: member.session }))
        .status,
    ).toBe(404);

    // reminders（他人視点）に private の overdue が出ない
    const memReminders = await (
      await call("GET", "/api/todos/reminders", { session: member.session })
    ).json<any>();
    expect(memReminders.overdue.some((t: any) => t.id === priv.id)).toBe(false);

    // 作成者本人の reminders には出る
    const ownReminders = await (
      await call("GET", "/api/todos/reminders", { session: ownerSession })
    ).json<any>();
    expect(ownReminders.overdue.some((t: any) => t.id === priv.id)).toBe(true);
  });

  it("private の item は親経由で他人に触れない（item ID 直打ちでも 404）", async () => {
    const { ownerSession, householdId } = await seedHousehold("item隔離家");
    const member = await seedMember(householdId, "侵入者");

    const create = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "p", visibility: "private", isChecklist: true, items: ["x"] },
    });
    const priv = await create.json<any>();
    const items = await (
      await call("GET", `/api/todos/${priv.id}/items`, { session: ownerSession })
    ).json<any[]>();
    const itemId = items[0].id;

    // 他人が item を ID 直打ちで PATCH/DELETE → 404
    expect(
      (
        await call("PATCH", `/api/items/${itemId}`, {
          session: member.session,
          body: { done: true },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", `/api/items/${itemId}`, { session: member.session })).status,
    ).toBe(404);
  });

  it("private→shared 切替で即座に他メンバーから見えるようになる", async () => {
    const { ownerSession, householdId } = await seedHousehold("切替家");
    const member = await seedMember(householdId, "観測者");

    const create = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "あとで共有する", visibility: "private" },
    });
    const todo = await create.json<any>();

    // 切替前は見えない
    let list = await (
      await call("GET", "/api/todos", { session: member.session })
    ).json<any[]>();
    expect(list.some((t) => t.id === todo.id)).toBe(false);

    // shared へ切替
    const patch = await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { visibility: "shared" },
    });
    expect(patch.status).toBe(200);

    // 即座に見える
    list = await (
      await call("GET", "/api/todos", { session: member.session })
    ).json<any[]>();
    expect(list.some((t) => t.id === todo.id)).toBe(true);

    // shared→private に戻すと再び見えなくなる
    await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { visibility: "private" },
    });
    list = await (
      await call("GET", "/api/todos", { session: member.session })
    ).json<any[]>();
    expect(list.some((t) => t.id === todo.id)).toBe(false);
  });

  it("private は他人を担当に設定できない（作成時・更新時とも assignee が剥がれる）", async () => {
    const { ownerSession, householdId } = await seedHousehold("自分専用家");
    const member = await seedMember(householdId, "担当候補");

    // 作成時に他人を担当指定 → 無視される
    const create = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "自分専用", visibility: "private", assigneeId: member.userId },
    });
    const todo = await create.json<any>();
    expect(todo.assignee).toBeNull();

    // shared で作って他人担当 → OK、その後 private へ切替で担当が剥がれる
    const shared = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "共有→自分専用", visibility: "shared", assigneeId: member.userId },
    });
    const sharedTodo = await shared.json<any>();
    expect(sharedTodo.assignee?.id).toBe(member.userId);

    const patched = await (
      await call("PATCH", `/api/todos/${sharedTodo.id}`, {
        session: ownerSession,
        body: { visibility: "private", assigneeId: member.userId },
      })
    ).json<any>();
    expect(patched.visibility).toBe("private");
    expect(patched.assignee).toBeNull();
  });
});
