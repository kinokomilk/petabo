// LINE Flex メッセージのビルダ（タスク一覧）。
//
// 設計の要点:
//   - 外部由来テキスト（タイトル・担当名）は Flex JSON の構造値（text）に入れる。
//     文字列手結合で JSON を作らない。
//   - 操作は postback。data に action と todoId を入れ、サーバ側で再認可する。
//   - 担当は「テキスト＋イニシャル」で表現する。
//   - 期限は色分け: 期限切れ=赤系 / 24h 以内=オレンジ寄り / それ以外=ミュート。
//   - private は鍵 + 「じぶん」表記（creator だけに出る前提＝呼び出し側でフィルタ済み）。
//
// petabo 配色:
//   accent #FF7A4D / accent-deep #D9622F / ink #2B2622 / ink-2 #7A7164
//   overdue #FF8A80 / lock(violet) #7A5FB0 / line #E9E2D6 / surface-2 #F2ECE3
import type { TodoRow } from "../types";
import type { LineFlexMessage } from "./api";

// Flex に載せる最大件数（小さく制限する。超過分は Web/LIFF へ誘導）。
export const FLEX_LIST_LIMIT = 10;

const COLOR = {
  accent: "#FF7A4D",
  accentDeep: "#D9622F",
  ink: "#2B2622",
  ink2: "#7A7164",
  muted: "#A89E92",
  overdue: "#E0524B", // 期限切れ強調（赤系・テキスト用に濃いめ）
  due: "#D9622F", // 期限間近（オレンジ寄り）
  lock: "#7A5FB0",
  line: "#E9E2D6",
  surface2: "#F2ECE3",
  white: "#FFFFFF",
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// 担当表示用のイニシャル（先頭1文字。空なら「?」）。
function initialOf(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  return t.length > 0 ? t[0] : "?";
}

// JST の短い日時表記（M/D HH:MM）。一覧 Flex と詳細テキストで共通利用。
export function formatDueJst(dueIso: string | null): string | null {
  if (!dueIso) return null;
  const ms = Date.parse(dueIso);
  if (!Number.isFinite(ms)) return null;
  // JST 表記（UTC+9）。曜日や秒は出さず短く。
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  const mm = d.getUTCMonth() + 1;
  const dd = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

// 期限の表示文字列（JST の月日 + 時刻）と色を返す。
// due_date は ISO。now 比較で overdue / due_soon / その他を色分けする。
function dueLabel(
  dueIso: string | null,
  nowMs: number,
): { text: string; color: string } | null {
  const base = formatDueJst(dueIso);
  if (base === null) return null;
  const ms = Date.parse(dueIso as string);
  if (ms <= nowMs) return { text: `期限切れ ${base}`, color: COLOR.overdue };
  if (ms <= nowMs + DAY_MS) return { text: `まもなく ${base}`, color: COLOR.due };
  return { text: base, color: COLOR.ink2 };
}

// 1 タスク = 1 box(vertical)。タイトル / メタ(担当・期限・鍵) / ボタン(postback)。
function todoBubbleBody(
  todo: TodoRow,
  assigneeName: string | null,
  nowMs: number,
): unknown {
  const isPrivate = todo.visibility === "private";
  const due = dueLabel(todo.due_date, nowMs);

  // メタ行（担当イニシャル＋名前 / private は鍵＋じぶん）。
  const metaContents: unknown[] = [];
  // 担当アバター（色つき円 + イニシャル）。画像ではなくテキスト合成。
  metaContents.push({
    type: "box",
    layout: "vertical",
    width: "24px",
    height: "24px",
    cornerRadius: "12px",
    backgroundColor: COLOR.accent,
    justifyContent: "center",
    alignItems: "center",
    contents: [
      {
        type: "text",
        text: initialOf(assigneeName),
        color: COLOR.white,
        size: "xs",
        align: "center",
        weight: "bold",
      },
    ],
  });
  metaContents.push({
    type: "text",
    text: assigneeName ? assigneeName : "未担当",
    size: "sm",
    color: COLOR.ink2,
    gravity: "center",
    flex: 1,
    margin: "sm",
  });
  if (isPrivate) {
    metaContents.push({
      type: "text",
      text: "🔒 じぶん",
      size: "xs",
      color: COLOR.lock,
      gravity: "center",
      align: "end",
    });
  }

  const bodyContents: unknown[] = [
    {
      type: "text",
      text: todo.title,
      weight: "bold",
      size: "md",
      color: COLOR.ink,
      wrap: true,
      maxLines: 2,
    },
    {
      type: "box",
      layout: "horizontal",
      margin: "md",
      spacing: "sm",
      contents: metaContents,
    },
  ];

  if (due) {
    bodyContents.push({
      type: "text",
      text: due.text,
      size: "xs",
      color: due.color,
      margin: "sm",
    });
  }

  return {
    type: "bubble",
    size: "kilo",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "none",
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "horizontal",
      spacing: "sm",
      contents: [
        {
          type: "button",
          style: "primary",
          color: COLOR.accent,
          height: "sm",
          action: {
            type: "postback",
            label: "完了",
            data: `action=done&todoId=${encodeURIComponent(todo.id)}`,
            displayText: "完了にする",
          },
        },
        {
          type: "button",
          style: "secondary",
          height: "sm",
          action: {
            type: "postback",
            label: "詳細",
            data: `action=detail&todoId=${encodeURIComponent(todo.id)}`,
          },
        },
      ],
    },
  };
}

// タスク一覧の Flex（carousel）。担当名は呼び出し側で解決して渡す
// （assigneeId -> 表示名。private 隔離は呼び出し側のクエリで済んでいる前提）。
// rows は最大 FLEX_LIST_LIMIT 件に切り詰める。altText はテキストフォールバック。
export function buildTodoListFlex(
  rows: TodoRow[],
  assigneeNameById: Map<string, string>,
  now: Date,
  altText = "タスク一覧",
): LineFlexMessage {
  const nowMs = now.getTime();
  const limited = rows.slice(0, FLEX_LIST_LIMIT);
  const bubbles = limited.map((t) =>
    todoBubbleBody(
      t,
      t.assignee_id ? assigneeNameById.get(t.assignee_id) ?? null : null,
      nowMs,
    ),
  );
  return {
    type: "flex",
    altText,
    contents: {
      type: "carousel",
      contents: bubbles,
    },
  };
}
