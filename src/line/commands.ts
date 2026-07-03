// LINE チャット操作（message / postback）のコマンド処理（Phase 3 / Wave 1）。
//
// 入口（lineWebhook.ts）は署名検証済みイベントだけをここへ渡す。
// 本モジュールは「requester の解決 → 認可 → DB 操作 → reply メッセージ生成」を担い、
// 実際の送信は LineReply ラッパ（テストでは mock）に委ねる。
//
// セキュリティの要点:
//   - requester は event.source.userId（署名検証済み）→ getUserByLineUserId →
//     active membership があるユーザーのみコマンド可。未連携/未参加は導線案内のみ。
//   - postback の操作対象は data の todoId をサーバ側で再認可（loadVisibleTodo 相当）。
//     見えない / 他人の private は 404 相当（副作用なし）で拒否。
//   - 入力検証は Web API（routes/todos.ts）と同等（空・長さ・制御文字）。
//   - 外部由来テキストは Flex の構造値へ。reply の text もユーザ生入力をそのまま
//     載せるのは確認文言の範囲に限る（JSON は手結合しない）。
import type { UserRow, TodoRow, TodoStatus } from "../types";
import {
  getUserByLineUserId,
  getActiveMembershipForUser,
  listActiveMembers,
} from "../db/households";
import { listTodos, getTodoRow, updateTodo, createTodo } from "../db/todos";
import type { LineMessage, LineReply, LineQuickReply } from "./api";
import { buildTodoListFlex, FLEX_LIST_LIMIT, formatDueJst } from "./flex";

// Web API と同等のタイトル検証上限。
const MAX_TITLE_LENGTH = 120;
// postback data は最大 300文字。encodeURIComponent 後のASCII文字列で制御する。
const MAX_POSTBACK_DATA_LENGTH = 300;
const ADD_POSTBACK_PREFIX = "action=add&title=";

// 制御文字（タブ・改行含む C0/C1 と DEL）を除去し、前後空白を整える。
// Web API は trim のみだが、LINE 入力は1行想定のため制御文字を落として正規化する。
export function sanitizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
}

// ---------- requester 解決 ----------
export interface Requester {
  user: UserRow;
  householdId: string;
}

// LINE userId からコマンド実行可能な requester を解決する。
// 未連携（users に無い）/ 未参加（active membership 無し）は null。
export async function resolveRequester(
  db: D1Database,
  lineUserId: string,
): Promise<Requester | null> {
  const user = await getUserByLineUserId(db, lineUserId);
  if (!user) return null;
  const membership = await getActiveMembershipForUser(db, user.id);
  if (!membership) return null;
  return { user, householdId: membership.household_id };
}

// ---------- 一覧フィルタ ----------
export type ListFilter = "default" | "today" | "overdue" | "all" | "mine";

const FILTER_LABELS: Record<ListFilter, string> = {
  default: "担当タスク",
  today: "きょう",
  overdue: "期限切れ",
  all: "全部",
  mine: "じぶんだけ",
};

function quickReplyForList(): LineQuickReply {
  // 絞り込み切替は postback（action=list&filter=...）。
  const make = (label: string, filter: ListFilter) => ({
    type: "action" as const,
    action: {
      type: "postback" as const,
      label,
      data: `action=list&filter=${filter}`,
      displayText: label,
    },
  });
  return {
    items: [
      make("きょう", "today"),
      make("期限切れ", "overdue"),
      make("全部", "all"),
      make("じぶんだけ", "mine"),
      make("担当", "default"),
    ],
  };
}

// requester の可視範囲でタスク行を取得し、フィルタを適用する。
// private 隔離は listTodos（viewerId=user.id）が担保する。
async function loadListRows(
  db: D1Database,
  req: Requester,
  filter: ListFilter,
): Promise<TodoRow[]> {
  // default / today / overdue は「自分の担当」を基本にする。
  // all / mine は household 内の見える全タスクを取り、後段で絞る。
  //   all  : 見える全タスク（private は自分のだけ listTodos が返す）。
  //   mine : 自分が creator のタスク（private を含む）→ assignee 縛りを外して creator で絞る。
  const assigneeId =
    filter === "all" || filter === "mine" ? undefined : req.user.id;
  const rows = await listTodos(db, req.householdId, req.user.id, {
    status: undefined,
    assigneeId,
  });

  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let filtered = rows.filter((r) => r.status !== "done");

  if (filter === "today") {
    filtered = filtered.filter((r) => {
      if (!r.due_date) return false;
      const ms = Date.parse(r.due_date);
      return Number.isFinite(ms) && ms <= now + dayMs;
    });
  } else if (filter === "overdue") {
    filtered = filtered.filter((r) => {
      if (!r.due_date) return false;
      const ms = Date.parse(r.due_date);
      return Number.isFinite(ms) && ms <= now;
    });
  } else if (filter === "mine") {
    // 自分が creator のタスクのみ（private を含む）。
    filtered = filtered.filter((r) => r.creator_id === req.user.id);
  }

  return filtered;
}

// 担当名解決マップ（assigneeId -> display_name）。private 隔離後の rows のみ対象。
async function assigneeNames(
  db: D1Database,
  householdId: string,
  rows: TodoRow[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const needed = new Set<string>();
  for (const r of rows) if (r.assignee_id) needed.add(r.assignee_id);
  if (needed.size === 0) return map;
  // active メンバーから引く（household 内の表示名）。少人数なので全取得で十分。
  const members = await listActiveMembers(db, householdId);
  for (const m of members) {
    if (needed.has(m.id)) map.set(m.id, m.display_name);
  }
  return map;
}

// 一覧メッセージ（Flex + quickReply）。0 件はテキスト案内。
async function buildListMessages(
  db: D1Database,
  req: Requester,
  filter: ListFilter,
  appBaseUrl: string | null,
): Promise<LineMessage[]> {
  const rows = await loadListRows(db, req, filter);
  const label = FILTER_LABELS[filter];

  if (rows.length === 0) {
    return [
      {
        type: "text",
        text: `「${label}」のタスクはありません。`,
        quickReply: quickReplyForList(),
      },
    ];
  }

  const names = await assigneeNames(db, req.householdId, rows);
  const flex = buildTodoListFlex(rows, names, new Date(), `${label}（${rows.length}件）`);
  flex.quickReply = quickReplyForList();
  const messages: LineMessage[] = [flex];

  // 件数が上限超なら Web へ誘導（LIFF は Wave 2）。
  if (rows.length > FLEX_LIST_LIMIT && appBaseUrl) {
    messages.push({
      type: "text",
      text: `ほかにも ${rows.length - FLEX_LIST_LIMIT} 件あります。すべては ${appBaseUrl} で確認できます。`,
    });
  }
  return messages;
}

// ---------- 案内テキスト（未連携 / 未参加） ----------
function notLinkedMessages(appBaseUrl: string | null): LineMessage[] {
  const url = appBaseUrl ?? "アプリ";
  return [
    {
      type: "text",
      text: `まだ petabo と連携していないようです。${url} からログイン・参加してください。`,
    },
  ];
}

// ---------- メモを貼る（リッチメニュー addprompt） ----------
// リッチメニューからの「メモを貼る」。最小実装として、続けてタイトルを送れば
// 未知文の確認フローに乗る旨を案内する。Web 本体へのリンクも併せて出す。
function addPromptMessages(appBaseUrl: string | null): LineMessage[] {
  const items: LineQuickReply["items"] = [];
  if (appBaseUrl) {
    items.push({
      type: "action",
      action: { type: "uri", label: "アプリで追加", uri: appBaseUrl },
    });
  }
  const msg: LineMessage = {
    type: "text",
    text: "追加したい内容をそのまま送ってください（例:「牛乳を買う」）。確認してから登録します。",
  };
  if (items.length > 0) msg.quickReply = { items };
  return [msg];
}

// ---------- 未知文の追加確認 ----------
// pending state は postback data に安全に載せる（D1 短命テーブルを増やさない最小実装）。
//   方式: data = "action=add&title=<encodeURIComponent(短縮タイトル)>"。
//   日本語は URL エンコード後に大きく膨らむため、文字数ではなくエンコード後の
//   postback data 全体が 300 文字以内になるように切る。
function truncateTitleForAddPostback(rawTitle: string): string {
  let out = "";
  for (const ch of Array.from(rawTitle)) {
    const next = out + ch;
    const data = `${ADD_POSTBACK_PREFIX}${encodeURIComponent(next)}`;
    if (data.length > MAX_POSTBACK_DATA_LENGTH) break;
    out = next;
  }
  return out;
}

function confirmAddMessages(rawText: string): LineMessage[] {
  const title = truncateTitleForAddPostback(sanitizeTitle(rawText));
  // 空（制御文字のみ等）は確認しない。
  if (title.length === 0) {
    return [{ type: "text", text: "テキストを認識できませんでした。" }];
  }
  return [
    {
      type: "text",
      text: `「${title}」を追加しますか?`,
      quickReply: {
        items: [
          {
            type: "action",
            action: {
              type: "postback",
              label: "追加する",
              data: `${ADD_POSTBACK_PREFIX}${encodeURIComponent(title)}`,
              displayText: "追加する",
            },
          },
          {
            type: "action",
            action: {
              type: "postback",
              label: "やめる",
              data: "action=cancel",
              displayText: "やめる",
            },
          },
        ],
      },
    },
  ];
}

// ---------- 追加の実行（shared todo 作成） ----------
async function doAdd(
  db: D1Database,
  req: Requester,
  rawTitle: string,
): Promise<LineMessage[]> {
  const title = sanitizeTitle(rawTitle);
  if (title.length === 0) {
    return [{ type: "text", text: "タイトルを入力してください。" }];
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return [{ type: "text", text: "タイトルが長すぎます（120文字まで）。" }];
  }
  await createTodo(db, {
    householdId: req.householdId,
    creatorId: req.user.id,
    title,
    description: "",
    status: "todo",
    isChecklist: false,
    isImportant: false,
    visibility: "shared", // LINE からの追加は shared（private は Web/LIFF へ）。
    dueDate: null,
    assigneeId: req.user.id,
  });
  return [{ type: "text", text: `「${title}」を追加しました。` }];
}

// ---------- postback: 完了 ----------
async function doDone(
  db: D1Database,
  req: Requester,
  todoId: string,
): Promise<LineMessage[]> {
  // 再認可: household スコープ + private は creator のみ（見えなければ 404 相当）。
  const todo = await loadVisible(db, req, todoId);
  if (!todo) {
    return [{ type: "text", text: "対象のタスクが見つかりませんでした。" }];
  }
  if (todo.status === "done") {
    return [{ type: "text", text: `「${todo.title}」はすでに完了しています。` }];
  }
  await updateTodo(db, req.householdId, todo.id, { status: "done" as TodoStatus });
  return [{ type: "text", text: `「${todo.title}」を完了にしました。` }];
}

// ---------- postback: 詳細（簡易 reply / Web 誘導） ----------
async function doDetail(
  db: D1Database,
  req: Requester,
  todoId: string,
  appBaseUrl: string | null,
): Promise<LineMessage[]> {
  const todo = await loadVisible(db, req, todoId);
  if (!todo) {
    return [{ type: "text", text: "対象のタスクが見つかりませんでした。" }];
  }
  const lines = [`■ ${todo.title}`];
  if (todo.due_date)
    lines.push(`期限: ${formatDueJst(todo.due_date) ?? todo.due_date}（JST）`);
  lines.push(`状態: ${todo.status}`);
  if (todo.visibility === "private") lines.push("公開: じぶんのみ");
  const text = lines.join("\n");
  const messages: LineMessage[] = [{ type: "text", text }];
  if (appBaseUrl) {
    messages[0].quickReply = {
      items: [
        {
          type: "action",
          action: { type: "uri", label: "アプリで開く", uri: appBaseUrl },
        },
      ],
    };
  }
  return messages;
}

// 再認可ヘルパー: household スコープ + private creator 隔離（routes/todos の loadVisibleTodo 相当）。
async function loadVisible(
  db: D1Database,
  req: Requester,
  todoId: string,
): Promise<TodoRow | null> {
  if (!todoId) return null;
  const row = await getTodoRow(db, req.householdId, todoId);
  if (!row) return null;
  if (row.visibility === "private" && row.creator_id !== req.user.id) return null;
  return row;
}

// ---------- イベントディスパッチ ----------
export interface CommandContext {
  db: D1Database;
  reply: LineReply;
  appBaseUrl: string | null;
}

// 受け取るイベント（必要フィールドのみ）。
export interface IncomingMessageEvent {
  type: "message";
  replyToken?: string;
  source?: { userId?: string };
  message?: { type?: string; text?: string };
}
export interface IncomingPostbackEvent {
  type: "postback";
  replyToken?: string;
  source?: { userId?: string };
  postback?: { data?: string };
}

// text コマンドを解釈してメッセージ列を返す（reply はしない・純粋ロジック）。
// requester 未解決時は導線案内、追加は拒否する。
export async function handleTextCommand(
  db: D1Database,
  lineUserId: string,
  text: string,
  appBaseUrl: string | null,
): Promise<LineMessage[]> {
  const req = await resolveRequester(db, lineUserId);
  const trimmed = text.trim();

  // 一覧（未連携でも案内に倒す）。
  if (trimmed === "一覧" || trimmed === "リスト") {
    if (!req) return notLinkedMessages(appBaseUrl);
    return buildListMessages(db, req, "default", appBaseUrl);
  }

  // 追加 <タイトル>
  if (trimmed.startsWith("追加")) {
    if (!req) return notLinkedMessages(appBaseUrl);
    const rest = trimmed.slice("追加".length).trim();
    return doAdd(db, req, rest);
  }

  // 未知文 → 追加確認（未連携なら案内のみ）。
  if (!req) return notLinkedMessages(appBaseUrl);
  return confirmAddMessages(trimmed);
}

// postback data を解釈してメッセージ列を返す（純粋ロジック）。
export async function handlePostback(
  db: D1Database,
  lineUserId: string,
  data: string,
  appBaseUrl: string | null,
): Promise<LineMessage[]> {
  const req = await resolveRequester(db, lineUserId);
  if (!req) return notLinkedMessages(appBaseUrl);

  const params = new URLSearchParams(data);
  const action = params.get("action");

  switch (action) {
    case "list": {
      const f = (params.get("filter") ?? "default") as ListFilter;
      const filter: ListFilter = (
        ["default", "today", "overdue", "all", "mine"] as ListFilter[]
      ).includes(f)
        ? f
        : "default";
      return buildListMessages(db, req, filter, appBaseUrl);
    }
    case "done": {
      const todoId = params.get("todoId") ?? "";
      return doDone(db, req, todoId);
    }
    case "detail": {
      const todoId = params.get("todoId") ?? "";
      return doDetail(db, req, todoId, appBaseUrl);
    }
    case "add": {
      // 未知文確認の確定（title は data に載っている）。
      const title = params.get("title") ?? "";
      return doAdd(db, req, title);
    }
    case "addprompt":
      // リッチメニュー「メモを貼る」: 追加導線を案内（即登録しない）。
      return addPromptMessages(appBaseUrl);
    case "cancel":
      return [{ type: "text", text: "キャンセルしました。" }];
    default:
      return [{ type: "text", text: "操作を認識できませんでした。" }];
  }
}

// イベント1件を処理して reply する（webhook から waitUntil 内で呼ばれる）。
// replyToken が無いイベントは無視。reply 失敗は秘密を出さず握りつぶす（再送しない）。
export async function processEvent(
  ctx: CommandContext,
  ev: IncomingMessageEvent | IncomingPostbackEvent,
): Promise<void> {
  const replyToken = ev.replyToken;
  const lineUserId = ev.source?.userId;
  if (!replyToken || !lineUserId) return;

  let messages: LineMessage[] | null = null;
  if (ev.type === "message" && ev.message?.type === "text") {
    const text = ev.message.text ?? "";
    messages = await handleTextCommand(ctx.db, lineUserId, text, ctx.appBaseUrl);
  } else if (ev.type === "postback") {
    const data = ev.postback?.data ?? "";
    messages = await handlePostback(ctx.db, lineUserId, data, ctx.appBaseUrl);
  }

  if (!messages || messages.length === 0) return;
  try {
    await ctx.reply.reply(replyToken, messages);
  } catch {
    // reply 失敗（期限切れトークン等）は再送しない・秘密はログに出さない。
    // webhook の 200 応答を妨げないため例外は握りつぶす（push へのフォールバックもしない）。
  }
}
