// LINE チャット操作（message / postback）のテスト。
// PHASE3_PRE_REVIEW acceptance 準拠:
//   - 不正署名 webhook は副作用ゼロ（lineWebhook.test.ts で網羅済み・ここでも reply 不発を確認）
//   - 一覧が requester の可視範囲だけ（他人の private が出ない）
//   - postback 完了が正しい todoId だけに作用 / 見えない・他人 private の todoId は拒否
//   - 追加 <タイトル> が未参加で拒否 / 連携 member で shared 作成 / タイトル検証
//   - 未知文は即登録しない → postback で登録
// reply は mock（fetch を呼ばない）。署名は固定 secret + raw body の実 HMAC。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import app from "../src/index";
import { testEnv, seedHousehold, seedMember } from "./helpers";
import { computeLineSignature } from "../src/line/signature";
import { __setReplyFactoryForTest } from "../src/routes/lineWebhook";
import type { LineMessage, LineReply } from "../src/line/api";
import type { Env } from "../src/env";

const CHANNEL_SECRET = "cmd-channel-secret";
const CHANNEL_ACCESS_TOKEN = "cmd-access-token";
const APP_BASE_URL = "https://petabo.example";

function lineEnv(): Env {
  return {
    ...testEnv(),
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: CHANNEL_ACCESS_TOKEN,
    APP_BASE_URL,
  };
}

// reply を捕捉する mock。最後の reply 呼び出し（replyToken, messages）を保持。
interface Captured {
  calls: { replyToken: string; messages: LineMessage[] }[];
}
let captured: Captured;
let restore: () => void;

function mockReply(): LineReply {
  return {
    async reply(replyToken, messages) {
      captured.calls.push({ replyToken, messages });
    },
  };
}

beforeEach(() => {
  captured = { calls: [] };
  restore = __setReplyFactoryForTest(() => mockReply());
});
afterEach(() => {
  restore();
});

// 署名付きで webhook を叩き、reply の処理完了を待つ（waitUntil 無し環境では同期実行）。
async function postEvents(events: unknown[]): Promise<Response> {
  const body = JSON.stringify({ destination: "Udest", events });
  const sig = await computeLineSignature(CHANNEL_SECRET, body);
  return app.request(
    "/api/line/webhook",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": sig },
      body,
    },
    lineEnv() as unknown as Record<string, unknown>,
  );
}

// seedMember が作るユーザーに line_user_id / line_followed を付与する。
async function linkLine(userId: string, lineUserId: string): Promise<void> {
  await testEnv()
    .DB.prepare(
      "UPDATE users SET line_user_id = ?, line_followed = 1 WHERE id = ?",
    )
    .bind(lineUserId, userId)
    .run();
}

// 直接 todo を seed（API を介さず creator/visibility/assignee を制御）。
async function seedTodo(opts: {
  householdId: string;
  creatorId: string;
  title: string;
  visibility?: "shared" | "private";
  assigneeId?: string | null;
  status?: "todo" | "doing" | "done";
  dueDate?: string | null;
}): Promise<string> {
  const id = `t_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await testEnv()
    .DB.prepare(
      `INSERT INTO todos
       (id, household_id, title, description, status, is_checklist, is_important, visibility, due_date, assignee_id, creator_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      opts.householdId,
      opts.title,
      opts.status ?? "todo",
      opts.visibility ?? "shared",
      opts.dueDate ?? null,
      opts.assigneeId ?? null,
      opts.creatorId,
      now,
      now,
    )
    .run();
  return id;
}

function msgEvent(lineUserId: string, text: string, replyToken = "rt1") {
  return {
    type: "message",
    replyToken,
    source: { type: "user", userId: lineUserId },
    message: { type: "text", text },
  };
}
function postbackEvent(lineUserId: string, data: string, replyToken = "rt1") {
  return {
    type: "postback",
    replyToken,
    source: { type: "user", userId: lineUserId },
    postback: { data },
  };
}

function allText(): string {
  return JSON.stringify(captured.calls);
}

async function getTodo(id: string): Promise<{ status: string } | null> {
  return testEnv()
    .DB.prepare("SELECT status FROM todos WHERE id = ?")
    .bind(id)
    .first<{ status: string }>();
}

describe("LINE message: 一覧", () => {
  it("requester の可視範囲だけ返す（他人の private が出ない）", async () => {
    const hh = await seedHousehold("一覧家");
    const alice = await seedMember(hh.householdId, "アリス");
    const bob = await seedMember(hh.householdId, "ボブ");
    await linkLine(alice.userId, "Ualice_list");
    await linkLine(bob.userId, "Ubob_list");

    // alice の shared / private、bob の private。
    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      title: "アリス共有タスク",
    });
    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      visibility: "private",
      title: "アリス秘密",
    });
    await seedTodo({
      householdId: hh.householdId,
      creatorId: bob.userId,
      assigneeId: bob.userId,
      visibility: "private",
      title: "ボブ秘密",
    });

    const res = await postEvents([msgEvent("Ualice_list", "一覧")]);
    expect(res.status).toBe(200);

    const dump = allText();
    expect(dump).toContain("アリス共有タスク");
    // alice の一覧（default = 自分の担当）には自分の private は creator なので listTodos が返すが
    // 既定の担当フィルタには出る（assignee=alice）。ボブの秘密は絶対に出ない。
    expect(dump).not.toContain("ボブ秘密");
  });

  it("じぶんだけ（mine）は自分が creator の private を含み、他人の private は出ない", async () => {
    const hh = await seedHousehold("mine家");
    const alice = await seedMember(hh.householdId, "アリス");
    const bob = await seedMember(hh.householdId, "ボブ");
    await linkLine(alice.userId, "Ualice_mine");
    await linkLine(bob.userId, "Ubob_mine");

    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      visibility: "private",
      title: "アリスのメモ",
    });
    await seedTodo({
      householdId: hh.householdId,
      creatorId: bob.userId,
      visibility: "private",
      title: "ボブのメモ",
    });

    await postEvents([postbackEvent("Ualice_mine", "action=list&filter=mine")]);
    const dump = allText();
    expect(dump).toContain("アリスのメモ");
    expect(dump).not.toContain("ボブのメモ");
  });
});

describe("LINE postback: 完了の再認可", () => {
  it("自分の見えるタスクは done に切り替わる", async () => {
    const hh = await seedHousehold("完了家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_done");
    const id = await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      title: "やること",
    });

    const res = await postEvents([
      postbackEvent("Ualice_done", `action=done&todoId=${id}`),
    ]);
    expect(res.status).toBe(200);
    expect((await getTodo(id))?.status).toBe("done");
    expect(allText()).toContain("完了にしました");
  });

  it("他人の private todo の todoId を postback しても拒否（副作用なし）", async () => {
    const hh = await seedHousehold("越境家");
    const alice = await seedMember(hh.householdId, "アリス");
    const bob = await seedMember(hh.householdId, "ボブ");
    await linkLine(alice.userId, "Ualice_x");
    await linkLine(bob.userId, "Ubob_x");

    // bob の private タスク。alice はその todoId を知っていても完了できない。
    const bobPrivate = await seedTodo({
      householdId: hh.householdId,
      creatorId: bob.userId,
      assigneeId: bob.userId,
      visibility: "private",
      title: "ボブの私用",
    });

    const res = await postEvents([
      postbackEvent("Ualice_x", `action=done&todoId=${bobPrivate}`),
    ]);
    expect(res.status).toBe(200);
    // 状態は変わらない（拒否）。
    expect((await getTodo(bobPrivate))?.status).toBe("todo");
    expect(allText()).toContain("見つかりませんでした");
  });

  it("存在しない todoId は拒否（404 相当・副作用なし）", async () => {
    const hh = await seedHousehold("存在しない家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_404");
    await postEvents([
      postbackEvent("Ualice_404", "action=done&todoId=t_does_not_exist"),
    ]);
    expect(allText()).toContain("見つかりませんでした");
  });
});

describe("LINE message: 追加", () => {
  it("連携 member は shared todo を作成し確認 reply", async () => {
    const hh = await seedHousehold("追加家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_add");

    const res = await postEvents([msgEvent("Ualice_add", "追加 牛乳を買う")]);
    expect(res.status).toBe(200);
    expect(allText()).toContain("追加しました");

    const row = await testEnv()
      .DB.prepare(
        "SELECT * FROM todos WHERE household_id = ? AND title = ?",
      )
      .bind(hh.householdId, "牛乳を買う")
      .first<{ visibility: string; creator_id: string; assignee_id: string | null }>();
    expect(row).toBeTruthy();
    expect(row?.visibility).toBe("shared");
    expect(row?.creator_id).toBe(alice.userId);
    expect(row?.assignee_id).toBe(alice.userId);
  });

  it("未参加（未連携）ユーザーは追加できず導線案内", async () => {
    // line_user_id を持たない LINE userId からの追加。
    const res = await postEvents([msgEvent("Uunlinked_add", "追加 勝手に追加")]);
    expect(res.status).toBe(200);
    expect(allText()).toContain("連携");
    const row = await testEnv()
      .DB.prepare("SELECT id FROM todos WHERE title = ?")
      .bind("勝手に追加")
      .first();
    expect(row).toBeFalsy();
  });

  it("空タイトルは作成しない", async () => {
    const hh = await seedHousehold("空家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_empty");
    await postEvents([msgEvent("Ualice_empty", "追加   ")]);
    expect(allText()).toContain("タイトルを入力");
  });

  it("長すぎるタイトルは拒否", async () => {
    const hh = await seedHousehold("長家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_long");
    const longTitle = "あ".repeat(121);
    await postEvents([msgEvent("Ualice_long", `追加 ${longTitle}`)]);
    expect(allText()).toContain("長すぎます");
    const row = await testEnv()
      .DB.prepare("SELECT id FROM todos WHERE title = ?")
      .bind(longTitle)
      .first();
    expect(row).toBeFalsy();
  });
});

describe("LINE message: 未知文の確認フロー", () => {
  it("未知文は即登録せず確認、postback で初めて登録", async () => {
    const hh = await seedHousehold("未知家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_unknown");

    // 1) 未知文 → 確認のみ（登録なし）。
    await postEvents([msgEvent("Ualice_unknown", "ゴミ出し")]);
    expect(allText()).toContain("追加しますか");
    let row = await testEnv()
      .DB.prepare("SELECT id FROM todos WHERE title = ?")
      .bind("ゴミ出し")
      .first();
    expect(row).toBeFalsy();

    // 2) 確認 postback（data に title） → 登録される。
    captured = { calls: [] };
    await postEvents([
      postbackEvent(
        "Ualice_unknown",
        `action=add&title=${encodeURIComponent("ゴミ出し")}`,
      ),
    ]);
    expect(allText()).toContain("追加しました");
    row = await testEnv()
      .DB.prepare("SELECT id FROM todos WHERE title = ?")
      .bind("ゴミ出し")
      .first();
    expect(row).toBeTruthy();
  });

  it("未知文確認の postback data は日本語長文でも300文字以内に収める", async () => {
    const hh = await seedHousehold("長文確認家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_long_unknown");

    await postEvents([msgEvent("Ualice_long_unknown", "あ".repeat(60))]);
    const message = captured.calls[0].messages[0];
    expect(message.type).toBe("text");
    const item = message.quickReply?.items[0];
    expect(item?.action.type).toBe("postback");
    if (item?.action.type !== "postback") throw new Error("missing postback");
    expect(item.action.data.length).toBeLessThanOrEqual(300);
    expect(new TextEncoder().encode(item.action.data).byteLength).toBeLessThanOrEqual(300);
  });

  it("やめる postback は登録しない", async () => {
    const hh = await seedHousehold("やめ家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_cancel");
    await postEvents([postbackEvent("Ualice_cancel", "action=cancel")]);
    expect(allText()).toContain("キャンセル");
  });
});

describe("LINE リッチメニュー postback の連携（Wave 2-a）", () => {
  it("action=list（一覧領域）が requester の可視一覧に繋がる", async () => {
    const hh = await seedHousehold("rm一覧家");
    const alice = await seedMember(hh.householdId, "アリス");
    const bob = await seedMember(hh.householdId, "ボブ");
    await linkLine(alice.userId, "Ualice_rmlist");
    await linkLine(bob.userId, "Ubob_rmlist");
    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      title: "アリスの担当タスク",
    });
    await seedTodo({
      householdId: hh.householdId,
      creatorId: bob.userId,
      assigneeId: bob.userId,
      visibility: "private",
      title: "ボブの秘密タスク",
    });

    const res = await postEvents([
      postbackEvent("Ualice_rmlist", "action=list"),
    ]);
    expect(res.status).toBe(200);
    const dump = allText();
    expect(dump).toContain("アリスの担当タスク");
    // private 隔離は listTodos 経由（他人の private は出ない）。
    expect(dump).not.toContain("ボブの秘密タスク");
  });

  it("action=list&filter=today（きょう領域）が today フィルタに繋がる", async () => {
    const hh = await seedHousehold("rmきょう家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_rmtoday");
    // 期限なし（today に出ない）。
    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      title: "期限なしタスク",
    });
    // 期限が直近（today に出る）。
    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await seedTodo({
      householdId: hh.householdId,
      creatorId: alice.userId,
      assigneeId: alice.userId,
      title: "きょう締切タスク",
      dueDate: soon,
    });

    await postEvents([
      postbackEvent("Ualice_rmtoday", "action=list&filter=today"),
    ]);
    const dump = allText();
    expect(dump).toContain("きょう締切タスク");
    expect(dump).not.toContain("期限なしタスク");
  });

  it("action=addprompt（メモを貼る領域）は即登録せず追加導線を案内", async () => {
    const hh = await seedHousehold("rmメモ家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_rmadd");
    await postEvents([postbackEvent("Ualice_rmadd", "action=addprompt")]);
    const dump = allText();
    // 追加導線（送ってください）の案内が返る。登録は発生しない。
    expect(dump).toContain("送ってください");
    const row = await testEnv()
      .DB.prepare("SELECT id FROM todos WHERE household_id = ?")
      .bind(hh.householdId)
      .first();
    expect(row).toBeFalsy();
  });

  it("未連携ユーザーの addprompt は導線案内（連携を促す）", async () => {
    const res = await postEvents([
      postbackEvent("Uunlinked_rm", "action=addprompt"),
    ]);
    expect(res.status).toBe(200);
    expect(allText()).toContain("連携");
  });
});

describe("LINE webhook: 不正署名は reply 不発", () => {
  it("不正署名では reply ラッパが呼ばれない（副作用ゼロ）", async () => {
    const hh = await seedHousehold("署名家");
    const alice = await seedMember(hh.householdId, "アリス");
    await linkLine(alice.userId, "Ualice_sig");
    const body = JSON.stringify({
      events: [msgEvent("Ualice_sig", "一覧")],
    });
    const res = await app.request(
      "/api/line/webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-line-signature": "INVALIDSIG",
        },
        body,
      },
      lineEnv() as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(401);
    expect(captured.calls.length).toBe(0);
  });
});
