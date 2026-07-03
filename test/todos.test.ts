// タスク/チェックリスト/フィルタ/コメントの網羅（TESTING §1）。
import { describe, expect, it } from "vitest";
import { call, seedHousehold, seedMember, seedTag } from "./helpers";

describe("フィルタ（status / assignee / tag）", () => {
  it("assignee フィルタが担当者で絞り込む", async () => {
    const { ownerSession, ownerId, householdId } = await seedHousehold("担当家");
    const member = await seedMember(householdId, "担当者");

    await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "オーナー担当", assigneeId: ownerId },
    });
    await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "メンバー担当", assigneeId: member.userId },
    });

    const mineRes = await call("GET", `/api/todos?assignee=${member.userId}`, {
      session: ownerSession,
    });
    const mine = await mineRes.json<any[]>();
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((t) => t.assignee?.id === member.userId)).toBe(true);
    expect(mine.some((t) => t.title === "オーナー担当")).toBe(false);
  });

  it("tag フィルタが該当タグの todo のみ返す", async () => {
    const { ownerSession, householdId } = await seedHousehold("タグ家");
    const tagA = await seedTag(householdId, "買い物");
    const tagB = await seedTag(householdId, "家事");

    const withA = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "牛乳買う", tagIds: [tagA] },
      })
    ).json<any>();
    await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "掃除", tagIds: [tagB] },
    });

    const res = await call("GET", `/api/todos?tag=${tagA}`, { session: ownerSession });
    const list = await res.json<any[]>();
    expect(list.some((t) => t.id === withA.id)).toBe(true);
    expect(list.every((t) => t.tags.some((tg: any) => tg.id === tagA))).toBe(true);
  });

  it("不正な status フィルタは 400", async () => {
    const { ownerSession } = await seedHousehold("不正status家");
    const res = await call("GET", "/api/todos?status=bogus", { session: ownerSession });
    expect(res.status).toBe(400);
  });
});

describe("TODO 入力検証", () => {
  it("担当未指定で作成すると作成者が担当になり、null 指定なら未担当にできる", async () => {
    const { ownerSession, ownerId } = await seedHousehold("既定担当家");

    const defaultAssigned = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "自分が担当" },
      })
    ).json<any>();
    expect(defaultAssigned.assignee?.id).toBe(ownerId);

    const unassigned = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "未担当", assigneeId: null },
      })
    ).json<any>();
    expect(unassigned.assignee).toBeNull();
  });

  it("作成時の不正 status / dueDate は 400", async () => {
    const { ownerSession } = await seedHousehold("入力検証家");

    const badStatus = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "x", status: "bogus" },
    });
    expect(badStatus.status).toBe(400);

    const badDue = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "x", dueDate: "2026-06-20" },
    });
    expect(badDue.status).toBe(400);
  });

  it("更新時の空 title / 不正 dueDate は 400", async () => {
    const { ownerSession } = await seedHousehold("更新検証家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "更新対象" },
      })
    ).json<any>();

    const emptyTitle = await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { title: "   " },
    });
    expect(emptyTitle.status).toBe(400);

    const badDue = await call("PATCH", `/api/todos/${todo.id}`, {
      session: ownerSession,
      body: { dueDate: "not-a-date" },
    });
    expect(badDue.status).toBe(400);
  });
});

describe("チェックリスト項目（連続追加 / 改行一括 / position / done）", () => {
  it("text の改行一括で複数項目が position 連番で追加される", async () => {
    const { ownerSession } = await seedHousehold("改行家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "持ち物", isChecklist: true },
      })
    ).json<any>();

    const created = await (
      await call("POST", `/api/todos/${todo.id}/items`, {
        session: ownerSession,
        body: { text: "傘\nタオル\n\n水筒" }, // 空行は除外される想定
      })
    ).json<any[]>();
    expect(created.length).toBe(3);
    expect(created.map((i) => i.text)).toEqual(["傘", "タオル", "水筒"]);
    expect(created.map((i) => i.position)).toEqual([0, 1, 2]);
  });

  it("連続追加で position が継続し、進捗 n/m が一致する", async () => {
    const { ownerSession } = await seedHousehold("連続家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "段取り", isChecklist: true, items: ["A", "B"] },
      })
    ).json<any>();

    // 追加（連続）
    await call("POST", `/api/todos/${todo.id}/items`, {
      session: ownerSession,
      body: { texts: ["C"] },
    });

    const items = await (
      await call("GET", `/api/todos/${todo.id}/items`, { session: ownerSession })
    ).json<any[]>();
    expect(items.map((i) => i.text)).toEqual(["A", "B", "C"]);
    expect(items.map((i) => i.position)).toEqual([0, 1, 2]);

    // 2 件 done に → 進捗 2/3
    await call("PATCH", `/api/items/${items[0].id}`, {
      session: ownerSession,
      body: { done: true },
    });
    await call("PATCH", `/api/items/${items[1].id}`, {
      session: ownerSession,
      body: { done: true },
    });
    const todoAfter = await (
      await call("GET", `/api/todos/${todo.id}`, { session: ownerSession })
    ).json<any>();
    expect(todoAfter.checklist).toEqual({ done: 2, total: 3 });

    // 全件 done で親タスクも完了になる
    await call("PATCH", `/api/items/${items[2].id}`, {
      session: ownerSession,
      body: { done: true },
    });
    const todoDone = await (
      await call("GET", `/api/todos/${todo.id}`, { session: ownerSession })
    ).json<any>();
    expect(todoDone.checklist).toEqual({ done: 3, total: 3 });
    expect(todoDone.status).toBe("done");

    // done 解除で親タスクも未完了に戻る
    await call("PATCH", `/api/items/${items[0].id}`, {
      session: ownerSession,
      body: { done: false },
    });
    const todoBack = await (
      await call("GET", `/api/todos/${todo.id}`, { session: ownerSession })
    ).json<any>();
    expect(todoBack.checklist).toEqual({ done: 2, total: 3 });
    expect(todoBack.status).toBe("todo");
  });

  it("position 指定で並び順が反映される", async () => {
    const { ownerSession } = await seedHousehold("並び家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "順序", isChecklist: true, items: ["一", "二", "三"] },
      })
    ).json<any>();
    const items = await (
      await call("GET", `/api/todos/${todo.id}/items`, { session: ownerSession })
    ).json<any[]>();
    // 「三」を先頭(position -1)へ
    await call("PATCH", `/api/items/${items[2].id}`, {
      session: ownerSession,
      body: { position: -1 },
    });
    const reordered = await (
      await call("GET", `/api/todos/${todo.id}/items`, { session: ownerSession })
    ).json<any[]>();
    expect(reordered[0].text).toBe("三");
  });

  it("空ボディの items 追加は 400", async () => {
    const { ownerSession } = await seedHousehold("空items家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "x", isChecklist: true },
      })
    ).json<any>();
    const res = await call("POST", `/api/todos/${todo.id}/items`, {
      session: ownerSession,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("空白だけの items 追加は 400", async () => {
    const { ownerSession } = await seedHousehold("空白items家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "x", isChecklist: true },
      })
    ).json<any>();
    const res = await call("POST", `/api/todos/${todo.id}/items`, {
      session: ownerSession,
      body: { texts: ["   ", "\n"] },
    });
    expect(res.status).toBe(400);
  });

  it("項目更新は空文字を拒否し、前後空白を trim する", async () => {
    const { ownerSession } = await seedHousehold("項目更新検証家");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "x", isChecklist: true, items: ["A"] },
      })
    ).json<any>();
    const [item] = await (
      await call("GET", `/api/todos/${todo.id}/items`, { session: ownerSession })
    ).json<any[]>();

    const empty = await call("PATCH", `/api/items/${item.id}`, {
      session: ownerSession,
      body: { text: "   " },
    });
    expect(empty.status).toBe(400);

    const renamed = await (
      await call("PATCH", `/api/items/${item.id}`, {
        session: ownerSession,
        body: { text: "  B  " },
      })
    ).json<any>();
    expect(renamed.text).toBe("B");
  });
});

describe("共有タスクの共同編集（家族フルオープン）と CRUD バリデーション", () => {
  it("shared タスクは他メンバーが完了・編集・削除できる", async () => {
    const { ownerSession, householdId } = await seedHousehold("共同家");
    const member = await seedMember(householdId, "共同編集者");

    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "共有タスク" },
      })
    ).json<any>();

    // member が status 変更
    const patched = await call("PATCH", `/api/todos/${todo.id}`, {
      session: member.session,
      body: { status: "done" },
    });
    expect(patched.status).toBe(200);
    expect((await patched.json<any>()).status).toBe("done");

    // member が削除
    const del = await call("DELETE", `/api/todos/${todo.id}`, {
      session: member.session,
    });
    expect(del.status).toBe(200);
  });

  it("title 無しの作成は 400", async () => {
    const { ownerSession } = await seedHousehold("title家");
    const res = await call("POST", "/api/todos", {
      session: ownerSession,
      body: { title: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("存在しない todo の取得・更新・削除は 404", async () => {
    const { ownerSession } = await seedHousehold("不在todo家");
    expect(
      (await call("GET", "/api/todos/nope", { session: ownerSession })).status,
    ).toBe(404);
    expect(
      (
        await call("PATCH", "/api/todos/nope", {
          session: ownerSession,
          body: { status: "done" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call("DELETE", "/api/todos/nope", { session: ownerSession })).status,
    ).toBe(404);
  });

  it("コメントは空文字を拒否（400）し、追加で user が hydrate される", async () => {
    const { ownerSession, householdId } = await seedHousehold("コメント家");
    const member = await seedMember(householdId, "コメント主");
    const todo = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "議論" },
      })
    ).json<any>();

    const empty = await call("POST", `/api/todos/${todo.id}/comments`, {
      session: member.session,
      body: { body: "   " },
    });
    expect(empty.status).toBe(400);

    const ok = await call("POST", `/api/todos/${todo.id}/comments`, {
      session: member.session,
      body: { body: "了解です" },
    });
    expect(ok.status).toBe(201);
    const comments = await ok.json<any[]>();
    expect(comments[0].user.id).toBe(member.userId);

    // commentCount が hydrate に反映
    const hydrated = await (
      await call("GET", `/api/todos/${todo.id}`, { session: ownerSession })
    ).json<any>();
    expect(hydrated.commentCount).toBe(1);
  });
});

describe("重要フラグ（isImportant）の永続化", () => {
  it("POST で isImportant=true を保存し、GET で true が返る", async () => {
    const { ownerSession } = await seedHousehold("重要家");
    const created = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "重要タスク", isImportant: true },
      })
    ).json<any>();
    expect(created.isImportant).toBe(true);

    const fetched = await (
      await call("GET", `/api/todos/${created.id}`, { session: ownerSession })
    ).json<any>();
    expect(fetched.isImportant).toBe(true);
  });

  it("isImportant 未指定は既定 false で、PATCH で切替できる", async () => {
    const { ownerSession } = await seedHousehold("既定家");
    const created = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "通常タスク" },
      })
    ).json<any>();
    expect(created.isImportant).toBe(false);

    // false → true
    const on = await (
      await call("PATCH", `/api/todos/${created.id}`, {
        session: ownerSession,
        body: { isImportant: true },
      })
    ).json<any>();
    expect(on.isImportant).toBe(true);

    // true → false
    const off = await (
      await call("PATCH", `/api/todos/${created.id}`, {
        session: ownerSession,
        body: { isImportant: false },
      })
    ).json<any>();
    expect(off.isImportant).toBe(false);
  });
});

describe("チェックリスト化（isChecklist）の PATCH 更新", () => {
  it("通常タスクを PATCH で isChecklist=true に更新し、GET で true が返る", async () => {
    const { ownerSession } = await seedHousehold("チェック家");
    const created = await (
      await call("POST", "/api/todos", {
        session: ownerSession,
        body: { title: "通常タスク" },
      })
    ).json<any>();
    expect(created.isChecklist).toBe(false);

    // 通常 → チェックリスト
    const on = await (
      await call("PATCH", `/api/todos/${created.id}`, {
        session: ownerSession,
        body: { isChecklist: true },
      })
    ).json<any>();
    expect(on.isChecklist).toBe(true);

    const fetched = await (
      await call("GET", `/api/todos/${created.id}`, { session: ownerSession })
    ).json<any>();
    expect(fetched.isChecklist).toBe(true);
  });
});
