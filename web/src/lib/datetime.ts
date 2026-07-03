// 期限の表示・状態判定（in-app の色分けに使う）。
export type DueState = "overdue" | "today" | "soon" | "future" | "none";

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// dueDate(ISO or "YYYY-MM-DD") から状態を求める。
export function dueState(dueDate: string | null, now = new Date()): DueState {
  if (!dueDate) return "none";
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return "none";

  const today = startOfDay(now);
  const dueDay = startOfDay(due);

  if (dueDay < today) return "overdue";
  if (dueDay === today) return "today";

  // 24h 以内（dueSoon）か、それ以降か。
  const diffMs = due.getTime() - now.getTime();
  if (diffMs <= 24 * 60 * 60 * 1000) return "soon";
  if (dueDay === today + 24 * 60 * 60 * 1000) return "soon"; // 明日
  return "future";
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

// 人にやさしい相対表記（今日 / 明日 / 昨日 / M/D）。
export function formatDue(dueDate: string | null, now = new Date()): string {
  if (!dueDate) return "";
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) return "";
  const today = startOfDay(now);
  const dueDay = startOfDay(due);
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((dueDay - today) / dayMs);

  if (diffDays === 0) return "今日";
  if (diffDays === 1) return "明日";
  if (diffDays === -1) return "昨日";
  if (diffDays > 1 && diffDays <= 7) return `${WEEK[due.getDay()]}曜`;
  return `${due.getMonth() + 1}/${due.getDate()}`;
}

// <input type="date"> 用 YYYY-MM-DD。
export function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// date input(YYYY-MM-DD) を ISO（その日の正午, ローカル）へ。null=未設定。
export function fromDateInputValue(v: string): string | null {
  if (!v) return null;
  const d = new Date(`${v}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${m}/${day} ${hh}:${mm}`;
}
