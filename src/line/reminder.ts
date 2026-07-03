// リマインダー（Cron）ロジック。
// 純粋・時刻注入可能：runReminders(db, push, now) の形にし、Vitest で
//   - now を注入して overdue/due_soon/future/done と静かな時間帯を制御
//   - push を mock して multicast/単発の呼び分け・記録/非記録を assert
// できるようにする。LINE secrets 無し（push が無設定）でも呼び出し側で skip する。
//
// 宛先ルール（確定）:
//   shared + assignee あり → 担当者のみ（push 単発）
//   shared + assignee なし → active メンバー全員（multicast。人数分の無料枠を消費する）
//   private              → creator のみ（push 単発）
// 除外: line_user_id NULL / line_followed=0（unfollow・ブロック）/ membership status='removed'。
//
// 重複防止: push 成功後に todo_reminders(todo_id, kind) を記録（kind 別＝per-kind）。
//   PRIMARY KEY (todo_id, kind) を活かし、due_soon と overdue を別々に1回ずつ送る。
//   抽出時に「現在の kind について未送信」の todo だけを対象にする（NOT EXISTS で
//   now から kind を算出して per-kind 除外）。これにより due_soon 送信済みでも
//   期限超過後に overdue が1回送られる。
//   単発 push の 400/403（無効 userId・ブロック）→ 恒久的失敗。当該ユーザーを
//     line_followed=0 に倒し以後対象外（再送しない）。
//   multicast の 403 → 1人のブロックで全員巻き添えにしないため一括 markBlocked せず、
//     todo_reminders にも記録しない（次回 Cron で再評価）。
//   429 / 5xx → 一過性。記録しない（次回 Cron で再試行）。秘密はログに出さない。

import type { TodoRow, UserRow } from "../types";
import {
  LineApiError,
  classifyPushFailure,
  type LinePush,
  type LineMessage,
} from "./api";
import { jstStartOfTodayMs, jstStartOfTodayIso } from "../time";

// 抽出対象の上限（全件走査・無料枠 CPU 抑止）。家族規模では十分。
const REMINDER_SCAN_LIMIT = 500;
// 1 回の Cron 実行で送るメッセージ単位（push=1・multicast=宛先人数）の上限。
// 無料枠（約200通/月）をバースト（例: 静かな時間帯明けに大量の未担当タスク）で
// 一気に使い切らないための安全弁。上限到達分は記録せず次回 Cron に回す（30分後に再評価）。
const REMINDER_MAX_MESSAGES_PER_RUN = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReminderKind = "overdue" | "due_soon";

// JST（UTC+9）での時刻が静かな時間帯（23:00–09:00）かを now から判定する。
// Date を直呼びせず、注入された now だけで算出する（テスト容易性）。
export function isQuietHourJst(now: Date): boolean {
  const jstHour = (now.getUTCHours() + 9) % 24;
  // 23, 0, 1, ..., 8 が静か（9:00 ちょうどは送信可）。
  return jstHour >= 23 || jstHour < 9;
}

// 送信対象になりうるユーザーか（除外条件）。
// line_user_id があり、line_followed=1 のユーザーのみ push 対象。
function isSendable(u: UserRow | undefined | null): u is UserRow {
  return !!u && !!u.line_user_id && u.line_followed === 1;
}

// 期限から kind を判定する（JST 日付ベース）。
// 期限の日付(JST)が今日より前 → overdue / それ以外（今日 or 24h以内）→ due_soon。
// ※今日が期限のタスクは当日中 overdue にしない（時刻超過でも当日は期限内）。
function classifyKind(dueDateIso: string, now: Date): ReminderKind {
  return Date.parse(dueDateIso) < jstStartOfTodayMs(now.getTime())
    ? "overdue"
    : "due_soon";
}

// 通知メッセージ（Phase 2 はテキスト。Flex は Phase 3）。
function buildMessages(todo: TodoRow, kind: ReminderKind): LineMessage[] {
  const text =
    kind === "overdue"
      ? `「${todo.title}」の期限が過ぎています。`
      : `「${todo.title}」の期限が近づいています。`;
  return [{ type: "text", text }];
}

// runReminders の集計結果（テスト/ログ用。秘密は含めない）。
export interface ReminderRunResult {
  scanned: number; // 抽出した対象 todo 数
  sent: number; // 送信成功（todo_reminders 記録）した todo 数
  messages: number; // 実際に送ったメッセージ単位数（push=1・multicast=人数）
  skippedQuiet: boolean; // 静かな時間帯で全スキップしたか
  capped: boolean; // 送信上限に達して残りを次回に回したか
}

// 1 回の Cron 実行で行うリマインダー処理。
//   db          : D1
//   push        : LinePush（本番は createLinePush、テストは mock）
//   now         : 現在時刻（実機は new Date()、テストは注入）
//   maxMessages : 1 実行あたりの送信メッセージ単位上限（無料枠保護の安全弁）
export async function runReminders(
  db: D1Database,
  push: LinePush,
  now: Date,
  maxMessages: number = REMINDER_MAX_MESSAGES_PER_RUN,
): Promise<ReminderRunResult> {
  // 静かな時間帯は一切送らない（抽出もしない＝無駄な DB/CPU を避ける）。
  if (isQuietHourJst(now)) {
    return { scanned: 0, sent: 0, messages: 0, skippedQuiet: true, capped: false };
  }

  const nowMs = now.getTime();
  const horizonIso = new Date(nowMs + DAY_MS).toISOString();

  // 対象 todo を抽出（インデックス idx_todos_due_date を利用、全件走査回避）。
  //   status != 'done' かつ due_date があり期限切れ または 24h 以内、
  //   かつ「現在の kind について未送信」（per-kind 除外）。
  // kind は JST 日付ベース: 期限の日付(JST)が今日より前 → 'overdue' / それ以外 → 'due_soon'。
  // 今日が期限のものは当日中 overdue にしない（classifyKind と一致させる）。
  // これにより due_soon 送信済みの todo が翌日 overdue になれば overdue を1回送れる
  // （per-kind に1回ずつ＝最大2回）。同一 kind は再送しない。
  const jstStartIso = jstStartOfTodayIso(nowMs);
  const res = await db
    .prepare(
      `SELECT t.* FROM todos t
       WHERE t.status != 'done'
         AND t.due_date IS NOT NULL
         AND t.due_date <= ?
         AND NOT EXISTS (
           SELECT 1 FROM todo_reminders r
           WHERE r.todo_id = t.id
             AND r.kind = CASE WHEN t.due_date < ? THEN 'overdue' ELSE 'due_soon' END
         )
       ORDER BY t.due_date ASC
       LIMIT ?`,
    )
    .bind(horizonIso, jstStartIso, REMINDER_SCAN_LIMIT)
    .all<TodoRow>();

  const todos = res.results ?? [];
  let sent = 0;
  let messagesSent = 0; // 実際に送ったメッセージ単位数（無料枠保護のカウンタ）
  let capped = false;

  // 送信対象になりうるユーザーをまとめ取りして N+1 を避ける。
  // 必要なのは assignee / creator / 各 household の active メンバー。
  const memberUserCache = new Map<string, UserRow | null>();
  const activeMembersCache = new Map<string, UserRow[]>();

  async function getActiveMemberUser(
    householdId: string,
    userId: string,
  ): Promise<UserRow | null> {
    const key = `${householdId}:${userId}`;
    if (memberUserCache.has(key)) return memberUserCache.get(key) ?? null;
    const u = await db
      .prepare(
        `SELECT u.* FROM users u
         JOIN memberships m ON m.user_id = u.id
         WHERE m.household_id = ? AND m.user_id = ? AND m.status = 'active'
         LIMIT 1`,
      )
      .bind(householdId, userId)
      .first<UserRow>();
    memberUserCache.set(key, u ?? null);
    return u;
  }

  // household の active メンバー（除外: removed は status 条件で除外済み）。
  async function getActiveMembers(householdId: string): Promise<UserRow[]> {
    const cached = activeMembersCache.get(householdId);
    if (cached) return cached;
    const r = await db
      .prepare(
        `SELECT u.* FROM users u
         JOIN memberships m ON m.user_id = u.id
         WHERE m.household_id = ? AND m.status = 'active'`,
      )
      .bind(householdId)
      .all<UserRow>();
    const list = r.results ?? [];
    activeMembersCache.set(householdId, list);
    return list;
  }

  // push 成功後に todo_reminders へ kind を記録（重複防止）。
  async function recordSent(todoId: string, kind: ReminderKind): Promise<void> {
    await db
      .prepare(
        "INSERT OR IGNORE INTO todo_reminders (todo_id, kind, sent_at) VALUES (?, ?, ?)",
      )
      .bind(todoId, kind, now.toISOString())
      .run();
  }

  // 恒久的失敗（400/403）を受けたユーザーを push 不可へ倒す（以後の対象から外す）。
  // line_user_id ではなく受け取った UserRow 自体のフラグを更新し、同一 Cron 内の
  // active member キャッシュも同期する（二重 push を避けるため）。
  async function markBlocked(user: UserRow): Promise<void> {
    await db
      .prepare(
        "UPDATE users SET line_followed = 0, line_unfollowed_at = ? WHERE id = ?",
      )
      .bind(now.toISOString(), user.id)
      .run();
    // 渡されたオブジェクトと各キャッシュを同期。
    user.line_followed = 0;
    for (const cached of memberUserCache.values()) {
      if (cached?.id === user.id) cached.line_followed = 0;
    }
    for (const members of activeMembersCache.values()) {
      for (const cached of members) {
        if (cached.id === user.id) cached.line_followed = 0;
      }
    }
  }

  for (const todo of todos) {
    const kind = classifyKind(todo.due_date as string, now);

    // 宛先選定。
    let recipients: UserRow[] = [];
    let useMulticast = false;

    if (todo.visibility === "private") {
      // private は creator のみ。
      const creator = todo.creator_id
        ? await getActiveMemberUser(todo.household_id, todo.creator_id)
        : null;
      if (isSendable(creator)) recipients = [creator];
    } else if (todo.assignee_id) {
      // shared + assignee あり → 担当者のみ。
      const assignee = await getActiveMemberUser(todo.household_id, todo.assignee_id);
      if (isSendable(assignee)) recipients = [assignee];
    } else {
      // shared + assignee なし → active メンバー全員（multicast）。
      // 注意: multicast は宛先人数分の無料枠（約200通/月）を消費する。
      const members = await getActiveMembers(todo.household_id);
      recipients = members.filter(isSendable);
      useMulticast = recipients.length > 1;
    }

    if (recipients.length === 0) {
      // 送信先なし（未連携 / unfollow / 担当者が removed 等）。記録もしない。
      continue;
    }

    // 無料枠保護：このメッセージ単位（push=1・multicast=人数）を送ると上限を超える場合、
    // 送らずにループを止める（記録しない＝次回 Cron で再評価される）。
    const cost = useMulticast ? recipients.length : 1;
    if (messagesSent + cost > maxMessages) {
      capped = true;
      break;
    }

    const messages = buildMessages(todo, kind);
    const toIds = recipients.map((u) => u.line_user_id as string);

    try {
      if (useMulticast) {
        await push.multicast(toIds, messages);
      } else {
        // 単発（担当者 / creator / メンバー1人）。
        await push.push(toIds[0], messages);
      }
      // 送信成功 → todo 単位で送信済みを記録。
      await recordSent(todo.id, kind);
      sent++;
      messagesSent += cost;
    } catch (e) {
      if (e instanceof LineApiError) {
        const cls = classifyPushFailure(e.status);
        if (useMulticast) {
          // M1: multicast の失敗は宛先を特定できない（1人のブロックでも 403 になる）。
          // 全員を巻き添えで markBlocked すると他メンバーへ push 不能になるため
          // 一括 block しない。todo_reminders にも記録せず次回 Cron で再評価する。
        } else if (cls === "permanent") {
          // M3: 単発 push の 400（無効 userId 等）/ 403（ブロック）は恒久的失敗。
          // 当該ユーザーを push 不可へ倒し以後対象外（再送して無料枠を浪費しない）。
          // 記録はしない（他の宛先が将来現れたら次回再評価される）。
          await markBlocked(recipients[0]);
        }
        // transient（429 / 5xx / 502）は記録せず次回 Cron で再試行。
      }
      // LineApiError 以外も記録しない（次回 Cron で再試行）。秘密はログに出さない。
    }
  }

  return { scanned: todos.length, sent, messages: messagesSent, skippedQuiet: false, capped };
}
