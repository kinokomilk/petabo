import { describe, expect, it } from "vitest";
import type { TodoDTO, UserDTO } from "../src/types";
import { buildHomeLists, getHomeVisibility } from "../web/src/screens/homeModel";

const owner: UserDTO = {
  id: "user-owner",
  displayName: "ゆず",
  color: "#FF7A4D",
  avatarUrl: null,
};

const member: UserDTO = {
  id: "user-member",
  displayName: "あおい",
  color: "#4C8DF6",
  avatarUrl: null,
};

function todo(overrides: Partial<TodoDTO> & Pick<TodoDTO, "id" | "title">): TodoDTO {
  return {
    description: "",
    status: "todo",
    isChecklist: false,
    isImportant: false,
    visibility: "shared",
    dueDate: null,
    assignee: owner,
    creator: owner,
    tags: [],
    checklist: { done: 0, total: 0 },
    checklistItems: [],
    commentCount: 0,
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
    ...overrides,
    id: overrides.id,
    title: overrides.title,
  };
}

describe("homeModel", () => {
  it("今日/これからに分け、重要タスクを各セクションの先頭へ出す", () => {
    const today = new Date().toISOString();
    const active = [
      todo({ id: "today-normal", title: "通常", dueDate: today }),
      todo({ id: "today-important", title: "重要", dueDate: today, isImportant: true }),
      todo({ id: "upcoming", title: "期限なし" }),
    ];

    const lists = buildHomeLists(active, [], {
      onlyMine: false,
      importantOnly: false,
      viewerId: owner.id,
    });

    expect(lists.todayList.map((t) => t.id)).toEqual([
      "today-important",
      "today-normal",
    ]);
    expect(lists.upcomingList.map((t) => t.id)).toEqual(["upcoming"]);
    expect(lists.allList.map((t) => t.id)).toEqual([
      "today-normal",
      "today-important",
      "upcoming",
    ]);
  });

  it("じぶんだけは自分が作成した private タスクだけに絞る", () => {
    const active = [
      todo({ id: "shared", title: "共有" }),
      todo({
        id: "my-private",
        title: "自分だけ",
        visibility: "private",
        creator: owner,
      }),
      todo({
        id: "other-private",
        title: "他人だけ",
        visibility: "private",
        creator: member,
      }),
    ];

    const lists = buildHomeLists(active, [], {
      onlyMine: true,
      importantOnly: false,
      viewerId: owner.id,
    });

    expect(lists.upcomingList.map((t) => t.id)).toEqual(["my-private"]);
    expect(lists.allList.map((t) => t.id)).toEqual(["my-private"]);
  });

  it("タブごとの表示対象と件数を返す", () => {
    const lists = {
      todayList: [todo({ id: "today", title: "今日" })],
      upcomingList: [todo({ id: "next", title: "これから" })],
      allList: [],
      doneList: [todo({ id: "done", title: "完了", status: "done" })],
    };

    expect(getHomeVisibility("all", lists)).toMatchObject({
      showDone: false,
      showToday: true,
      showUpcoming: true,
      visibleCount: 2,
    });
    expect(getHomeVisibility("done", lists)).toMatchObject({
      showDone: true,
      showToday: false,
      showUpcoming: false,
      visibleCount: 1,
    });
  });
});
