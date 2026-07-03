// リマインダー Cron ロジックのテスト。PHASE2_TEST_PLAN「Reminder」準拠。
// push は mock（fetch を呼ばない）。now を注入して overdue/due_soon/future/done・
// 静かな時間帯・宛先選定・重複防止・失敗処理を検証する。
import { describe, expect, it, beforeEach } from "vitest";
import { testEnv, seedHousehold, call } from "./helpers";
import { runReminders, isQuietHourJst } from "../src/line/reminder";
import { LineApiError, type LinePush, type LineMessage } from "../src/line/api";

const db = () => testEnv().DB;

// 呼び出しを記録する mock push。throwStatus を渡すと LineApiError を投げる。
interface PushCall {
  kind: "push" | "multicast";
  to: string[];
  messages: LineMessage[];
}
function mockPush(opts: { throwStatus?: number } = {}): LinePush & { calls: PushCall[] } {
  const calls: PushCall[] = [];
  const maybeThrow = () => {
    if (opts.throwStatus) throw new LineApiError("mock", opts.throwStatus);
  };
  return {
    calls,
    async push(to, messages) {
      calls.push({ kind: "push", to: [to], messages });
      maybeThrow();
    },
    async multicast(to, messages) {
      calls.push({ kind: "multicast", to, messages });
      maybeThrow();
    },
  };
}

// 昼間（JST 12:00 = UTC 03:00）の固定時刻。送信される時間帯。
const NOON_JST = new Date("2026-06-21T03:00:00.000Z");

function rid(p: string): string {
  return `${p}_${crypto.randomUUID()}`;
}

// line 連携済みユーザーを seed（line_user_id + followed=1）。
async function seedLineUser(
  householdId: string,
  opts: {
    lineUserId?: string | null;
    followed?: number;
    removed?: boolean;
  } = {},
): Promise<{ userId: string; lineUserId: string | null }> {
  const userId = rid("u");
  const lineUserId = opts.lineUserId === undefined ? rid("U") : opts.lineUserId;
  const followed = opts.followed ?? 1;
  await db()
    .prepare(
      `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_followed)
       VALUES (?, 'リマインド対象', '#FF7A4D', ?, NULL, NULL, NULL, ?, ?)`,
    )
    .bind(userId, lineUserId, new Date().toISOString(), followed)
    .run();
  await db()
    .prepare(
      `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'member', ?, ?)`,
    )
    .bind(householdId, userId, opts.removed ? "removed" : "active", new Date().toISOString())
    .run();
  return { userId, lineUserId };
}

// todo を直接 seed。dueOffsetMs: now からの相対（負=overdue）。
async function seedTodo(opts: {
  householdId: string;
  creatorId: string;
  dueIso: string | null;
  status?: string;
  visibility?: "shared" | "private";
  assigneeId?: string | null;
  title?: string;
}): Promise<string> {
  const id = rid("todo");
  const now = new Date().toISOString();
  await db()
    .prepare(
      `INSERT INTO todos
       (id, household_id, title, description, status, is_checklist, is_important, visibility, due_date, assignee_id, creator_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.householdId,
      opts.title ?? "やること",
      opts.status ?? "todo",
      opts.visibility ?? "shared",
      opts.dueIso,
      opts.assigneeId ?? null,
      opts.creatorId,
      now,
      now,
    )
    .run();
  return id;
}

async function reminderRows(todoId: string): Promise<Array<{ kind: string }>> {
  const r = await db()
    .prepare("SELECT kind FROM todo_reminders WHERE todo_id = ?")
    .bind(todoId)
    .all<{ kind: string }>();
  return r.results ?? [];
}

// dueIso ヘルパ（now=NOON_JST 基準）。
const iso = (offsetMs: number) => new Date(NOON_JST.getTime() + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  // 各テスト独立に。reminder/todos/users/memberships/households を空にする。
  const d = db();
  for (const t of ["todo_reminders", "todos", "memberships", "users", "households"]) {
    await d.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("isQuietHourJst", () => {
  it("JST 23:00–08:59 は静か、09:00–22:59 は送信可", () => {
    // UTC 14:00 = JST 23:00 → 静か
    expect(isQuietHourJst(new Date("2026-06-21T14:00:00Z"))).toBe(true);
    // UTC 23:00 = JST 08:00 → 静か
    expect(isQuietHourJst(new Date("2026-06-21T23:00:00Z"))).toBe(true);
    // UTC 00:00 = JST 09:00 → 送信可
    expect(isQuietHourJst(new Date("2026-06-21T00:00:00Z"))).toBe(false);
    // UTC 03:00 = JST 12:00 → 送信可
    expect(isQuietHourJst(new Date("2026-06-21T03:00:00Z"))).toBe(false);
    // UTC 13:59 = JST 22:59 → 送信可
    expect(isQuietHourJst(new Date("2026-06-21T13:59:00Z"))).toBe(false);
  });
});

describe("リマインダー: 分類と時間帯", () => {
  it("overdue / due_soon は送信、future / done は送らない", async () => {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    const member = await seedLineUser(hh, {});

    const overdue = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(-25 * HOUR), // 昨日(JST)＝overdue（当日中は overdue にしない）
    });
    const dueSoon = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(2 * HOUR), // 今日(JST)＝due_soon
    });
    const future = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(48 * HOUR),
    });
    const done = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(-2 * HOUR),
      status: "done",
    });

    const push = mockPush();
    const result = await runReminders(db(), push, NOON_JST);

    expect(result.scanned).toBe(2);
    expect(result.sent).toBe(2);
    expect((await reminderRows(overdue))[0]?.kind).toBe("overdue");
    expect((await reminderRows(dueSoon))[0]?.kind).toBe("due_soon");
    expect(await reminderRows(future)).toHaveLength(0);
    expect(await reminderRows(done)).toHaveLength(0);
  });

  it("静かな時間帯（JST 23:30）は一切送信せず記録もしない", async () => {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    const member = await seedLineUser(hh, {});
    const t = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: new Date("2026-06-21T14:30:00Z").toISOString(), // JST 23:30 基準で overdue でも
    });
    const quiet = new Date("2026-06-21T14:30:00Z"); // JST 23:30
    const push = mockPush();
    const result = await runReminders(db(), push, quiet);
    expect(result.skippedQuiet).toBe(true);
    expect(push.calls).toHaveLength(0);
    expect(await reminderRows(t)).toHaveLength(0);
  });
});

describe("リマインダー: 重複防止と期限変更リセット", () => {
  it("todo_reminders 済みは再送しない", async () => {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    const member = await seedLineUser(hh, {});
    await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(-1 * HOUR),
    });

    const push1 = mockPush();
    await runReminders(db(), push1, NOON_JST);
    expect(push1.calls).toHaveLength(1);

    // 2 回目は記録済みなので送らない。
    const push2 = mockPush();
    const r2 = await runReminders(db(), push2, NOON_JST);
    expect(push2.calls).toHaveLength(0);
    expect(r2.scanned).toBe(0);
  });

  it("PATCH で due_date を変えると reminder がリセットされ再送される", async () => {
    // 認可付き API 経由で due_date 変更 → clearTodoReminders 発火を検証。
    const seeded = await seedHousehold("リマインド家");
    // line 連携済みの assignee を作る。
    const member = await seedLineUser(seeded.householdId, {});
    const todoId = await seedTodo({
      householdId: seeded.householdId,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(-1 * HOUR),
    });

    // 1 回送信して記録を作る。
    const push1 = mockPush();
    await runReminders(db(), push1, NOON_JST);
    expect(await reminderRows(todoId)).toHaveLength(1);

    // owner が due_date を変更（PATCH）。同一 origin。
    const newDue = iso(-3 * HOUR);
    const res = await call("PATCH", `/api/todos/${todoId}`, {
      session: seeded.ownerSession,
      origin: "http://localhost",
      body: { dueDate: newDue },
    });
    expect(res.status).toBe(200);
    expect(await reminderRows(todoId)).toHaveLength(0); // リセットされた

    // 再送される。
    const push2 = mockPush();
    await runReminders(db(), push2, NOON_JST);
    expect(push2.calls).toHaveLength(1);
    expect(await reminderRows(todoId)).toHaveLength(1);
  });
});

describe("リマインダー: 宛先選定", () => {
  async function household(): Promise<string> {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    return hh;
  }

  it("shared + assignee あり → 担当者のみ（単発 push）", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, {});
    const other = await seedLineUser(hh, {});
    await seedTodo({
      householdId: hh,
      creatorId: other.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].kind).toBe("push");
    expect(push.calls[0].to).toEqual([assignee.lineUserId]);
  });

  it("shared + assignee なし → active メンバー全員（multicast）", async () => {
    const hh = await household();
    const a = await seedLineUser(hh, {});
    const b = await seedLineUser(hh, {});
    await seedTodo({
      householdId: hh,
      creatorId: a.userId,
      assigneeId: null,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].kind).toBe("multicast");
    expect(push.calls[0].to.sort()).toEqual([a.lineUserId, b.lineUserId].sort());
  });

  it("private → creator のみ（単発 push）", async () => {
    const hh = await household();
    const creator = await seedLineUser(hh, {});
    await seedLineUser(hh, {}); // 別メンバー（private には送られないことを確認）
    await seedTodo({
      householdId: hh,
      creatorId: creator.userId,
      assigneeId: null,
      visibility: "private",
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].kind).toBe("push");
    expect(push.calls[0].to).toEqual([creator.lineUserId]);
  });

  it("shared + assignee なしで送信可能が1人なら単発 push", async () => {
    const hh = await household();
    const a = await seedLineUser(hh, {}); // 連携済み
    await seedLineUser(hh, { lineUserId: null }); // 未連携 → 除外
    await seedTodo({
      householdId: hh,
      creatorId: a.userId,
      assigneeId: null,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].kind).toBe("push");
    expect(push.calls[0].to).toEqual([a.lineUserId]);
  });
});

describe("リマインダー: 除外条件", () => {
  async function household(): Promise<string> {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    return hh;
  }

  it("line_user_id NULL の担当者には送らない（記録もしない）", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, { lineUserId: null });
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(0);
    expect(await reminderRows(todoId)).toHaveLength(0);
  });

  it("line_followed=0（unfollow/ブロック）には送らない", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, { followed: 0 });
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(0);
    expect(await reminderRows(todoId)).toHaveLength(0);
  });

  it("removed member は multicast 対象外", async () => {
    const hh = await household();
    const active = await seedLineUser(hh, {});
    const removed = await seedLineUser(hh, { removed: true });
    await seedTodo({
      householdId: hh,
      creatorId: active.userId,
      assigneeId: null,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    // active 1 人のみ → 単発 push、removed は含まれない。
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0].to).toEqual([active.lineUserId]);
    expect(push.calls[0].to).not.toContain(removed.lineUserId);
  });

  it("removed member が担当者として残っていても送らない（記録もしない）", async () => {
    const hh = await household();
    const creator = await seedLineUser(hh, {});
    const removed = await seedLineUser(hh, { removed: true });
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: creator.userId,
      assigneeId: removed.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    await runReminders(db(), push, NOON_JST);
    expect(push.calls).toHaveLength(0);
    expect(await reminderRows(todoId)).toHaveLength(0);
  });
});

describe("リマインダー: push 失敗処理", () => {
  async function household(): Promise<string> {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    return hh;
  }

  it("429 / 5xx は未記録（次回再送可）", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, {});
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push429 = mockPush({ throwStatus: 429 });
    await runReminders(db(), push429, NOON_JST);
    expect(await reminderRows(todoId)).toHaveLength(0); // 未記録

    const push503 = mockPush({ throwStatus: 503 });
    await runReminders(db(), push503, NOON_JST);
    expect(await reminderRows(todoId)).toHaveLength(0);

    // 復旧後は送信される。
    const ok = mockPush();
    await runReminders(db(), ok, NOON_JST);
    expect(ok.calls).toHaveLength(1);
    expect(await reminderRows(todoId)).toHaveLength(1);
  });

  it("単発 403 は line_followed=0 に倒し、以後は対象外", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, {});
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push403 = mockPush({ throwStatus: 403 });
    await runReminders(db(), push403, NOON_JST);
    // 記録されない（送れていない）。
    expect(await reminderRows(todoId)).toHaveLength(0);
    // ユーザーは line_followed=0 に倒れている。
    const u = await db()
      .prepare("SELECT line_followed FROM users WHERE id = ?")
      .bind(assignee.userId)
      .first<{ line_followed: number }>();
    expect(u?.line_followed).toBe(0);

    // 次回は除外され、push されない。
    const next = mockPush();
    await runReminders(db(), next, NOON_JST);
    expect(next.calls).toHaveLength(0);
  });

  it("M3: 単発 400（無効 userId 等）は再送せず以後対象外（無料枠浪費しない）", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, {});
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push400 = mockPush({ throwStatus: 400 });
    await runReminders(db(), push400, NOON_JST);
    expect(await reminderRows(todoId)).toHaveLength(0); // 記録なし（送れていない）
    // 恒久的失敗として line_followed=0 に倒れ、以後対象外。
    const u = await db()
      .prepare("SELECT line_followed FROM users WHERE id = ?")
      .bind(assignee.userId)
      .first<{ line_followed: number }>();
    expect(u?.line_followed).toBe(0);

    // 次回 Cron では再送されない。
    const next = mockPush();
    await runReminders(db(), next, NOON_JST);
    expect(next.calls).toHaveLength(0);
  });

  it("M1: multicast 403 は全員を blocked にしない（次回再評価）", async () => {
    const hh = await household();
    const a = await seedLineUser(hh, {});
    const b = await seedLineUser(hh, {});
    await seedTodo({
      householdId: hh,
      creatorId: a.userId,
      assigneeId: null, // 未担当 → active 全員へ multicast
      dueIso: iso(-1 * HOUR),
    });
    const push403 = mockPush({ throwStatus: 403 });
    await runReminders(db(), push403, NOON_JST);
    expect(push403.calls[0]?.kind).toBe("multicast");

    // どちらも line_followed=1 のまま（巻き添え block されない）。
    for (const u of [a, b]) {
      const row = await db()
        .prepare("SELECT line_followed FROM users WHERE id = ?")
        .bind(u.userId)
        .first<{ line_followed: number }>();
      expect(row?.line_followed).toBe(1);
    }

    // 復旧後は両者へ送られる。
    const ok = mockPush();
    await runReminders(db(), ok, NOON_JST);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0].kind).toBe("multicast");
    expect(ok.calls[0].to.sort()).toEqual([a.lineUserId, b.lineUserId].sort());
  });

  it("M2: 同一 Cron 内で同ユーザーへ二重 push されない（単発 403 後）", async () => {
    const hh = await household();
    const assignee = await seedLineUser(hh, {});
    // 同一担当者に2件の overdue todo。1件目で 403 → block されれば2件目は送られない。
    await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-2 * HOUR),
    });
    await seedTodo({
      householdId: hh,
      creatorId: assignee.userId,
      assigneeId: assignee.userId,
      dueIso: iso(-1 * HOUR),
    });
    const push403 = mockPush({ throwStatus: 403 });
    await runReminders(db(), push403, NOON_JST);
    // 1件目だけ push 試行され、2件目はキャッシュ同期で除外される。
    expect(push403.calls).toHaveLength(1);
  });
});

describe("リマインダー: per-kind 重複防止（H2）", () => {
  async function household(): Promise<string> {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    return hh;
  }

  it("due_soon 送信済みでも overdue になれば overdue を1回送る", async () => {
    const hh = await household();
    const member = await seedLineUser(hh, {});
    // 期限を「2時間後」に設定（due_soon の時刻 = NOON_JST）。
    const dueIso = iso(2 * HOUR);
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso,
    });

    // 1回目: now=NOON → due_soon を送信・記録。
    const push1 = mockPush();
    await runReminders(db(), push1, NOON_JST);
    expect(push1.calls).toHaveLength(1);
    let rows = await reminderRows(todoId);
    expect(rows.map((r) => r.kind)).toEqual(["due_soon"]);

    // 同時刻で再実行 → 同一 kind(due_soon) は再送しない。
    const pushSame = mockPush();
    await runReminders(db(), pushSame, NOON_JST);
    expect(pushSame.calls).toHaveLength(0);

    // 翌日に実行 → 期限の日付(JST)が今日より前になり overdue を1回送る。
    // （当日中は overdue にしないので、日付が変わる翌日まで進める）。
    const afterDue = new Date(Date.parse(dueIso) + 24 * HOUR);
    const push2 = mockPush();
    await runReminders(db(), push2, afterDue);
    expect(push2.calls).toHaveLength(1);
    rows = await reminderRows(todoId);
    expect(rows.map((r) => r.kind).sort()).toEqual(["due_soon", "overdue"]);
  });

  it("同一 kind は再送されない（overdue 2回目は送らない）", async () => {
    const hh = await household();
    const member = await seedLineUser(hh, {});
    const todoId = await seedTodo({
      householdId: hh,
      creatorId: member.userId,
      assigneeId: member.userId,
      dueIso: iso(-25 * HOUR), // 昨日(JST)＝overdue
    });
    const push1 = mockPush();
    await runReminders(db(), push1, NOON_JST);
    expect(push1.calls).toHaveLength(1);

    const push2 = mockPush();
    const r2 = await runReminders(db(), push2, NOON_JST);
    expect(push2.calls).toHaveLength(0);
    expect(r2.scanned).toBe(0);
    expect((await reminderRows(todoId)).map((r) => r.kind)).toEqual(["overdue"]);
  });
});

describe("リマインダー: 送信キャップ（無料枠保護）", () => {
  async function household(): Promise<string> {
    const hh = rid("hh");
    await db()
      .prepare("INSERT INTO households (id, name, owner_id, created_at) VALUES (?, '家', NULL, ?)")
      .bind(hh, new Date().toISOString())
      .run();
    return hh;
  }

  it("maxMessages に達したら残りは送らず capped=true（次回に回す）", async () => {
    const hh = await household();
    const creator = await seedLineUser(hh, {});
    // 担当者ありの overdue todo を 3 件（単発 push＝各 cost 1）。
    for (let i = 0; i < 3; i++) {
      const assignee = await seedLineUser(hh, {});
      await seedTodo({
        householdId: hh,
        creatorId: creator.userId,
        assigneeId: assignee.userId,
        dueIso: iso(-(i + 1) * HOUR),
      });
    }
    const push = mockPush();
    const r = await runReminders(db(), push, NOON_JST, 2); // 上限 2

    expect(push.calls).toHaveLength(2); // 2 件だけ送る
    expect(r.sent).toBe(2);
    expect(r.messages).toBe(2);
    expect(r.capped).toBe(true);
    // 記録は 2 件のみ（3 件目は次回 Cron で再評価）。
    const total = await db()
      .prepare("SELECT COUNT(*) AS c FROM todo_reminders")
      .first<{ c: number }>();
    expect(total?.c).toBe(2);
  });

  it("multicast は宛先人数で加算され、超過する todo は送らない", async () => {
    const hh = await household();
    const creator = await seedLineUser(hh, {});
    // 送信可能なメンバーを 3 人（うち1人は creator）にして、未担当 shared todo を作る。
    await seedLineUser(hh, {});
    await seedLineUser(hh, {});
    await seedTodo({
      householdId: hh,
      creatorId: creator.userId,
      assigneeId: null, // 未担当 → multicast（cost = 宛先人数）
      dueIso: iso(-1 * HOUR),
    });
    const push = mockPush();
    const r = await runReminders(db(), push, NOON_JST, 2); // 上限 2（宛先 3 > 2）

    expect(push.calls).toHaveLength(0); // multicast(cost 3) は上限超で送らない
    expect(r.sent).toBe(0);
    expect(r.capped).toBe(true);
  });
});
