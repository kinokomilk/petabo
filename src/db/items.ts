// checklist_items リポジトリ。
import type { ChecklistItemRow, ChecklistItemDTO } from "../types";
import { nowIso, ITEM_LIST_LIMIT } from "./util";
import { uuid } from "../auth/crypto";

export function toItemDTO(r: ChecklistItemRow): ChecklistItemDTO {
  return {
    id: r.id,
    todoId: r.todo_id,
    text: r.text,
    done: r.done === 1,
    position: r.position,
  };
}

export async function listItems(
  db: D1Database,
  todoId: string,
): Promise<ChecklistItemRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM checklist_items WHERE todo_id = ? ORDER BY position ASC, created_at ASC LIMIT ?",
    )
    .bind(todoId, ITEM_LIST_LIMIT)
    .all<ChecklistItemRow>();
  return res.results ?? [];
}

async function maxPosition(db: D1Database, todoId: string): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) AS p FROM checklist_items WHERE todo_id = ?",
    )
    .bind(todoId)
    .first<{ p: number }>();
  return row?.p ?? -1;
}

// 複数 text を一括追加（改行一括/連続追加対応）。空行は除外。
export async function addItems(
  db: D1Database,
  todoId: string,
  texts: string[],
): Promise<ChecklistItemRow[]> {
  const cleaned = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (cleaned.length === 0) return [];

  let pos = await maxPosition(db, todoId);
  const ts = nowIso();
  const rows: ChecklistItemRow[] = [];
  const stmt = db.prepare(
    "INSERT INTO checklist_items (id, todo_id, text, done, position, created_at) VALUES (?, ?, ?, 0, ?, ?)",
  );
  const batch = cleaned.map((text) => {
    pos += 1;
    const id = uuid();
    rows.push({
      id,
      todo_id: todoId,
      text,
      done: 0,
      position: pos,
      created_at: ts,
    });
    return stmt.bind(id, todoId, text, pos, ts);
  });
  await db.batch(batch);
  return rows;
}

export async function getItem(
  db: D1Database,
  id: string,
): Promise<ChecklistItemRow | null> {
  return db
    .prepare("SELECT * FROM checklist_items WHERE id = ?")
    .bind(id)
    .first<ChecklistItemRow>();
}

export async function updateItem(
  db: D1Database,
  id: string,
  patch: { text?: string; done?: boolean; position?: number },
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.text !== undefined) {
    sets.push("text = ?");
    binds.push(patch.text);
  }
  if (patch.done !== undefined) {
    sets.push("done = ?");
    binds.push(patch.done ? 1 : 0);
  }
  if (patch.position !== undefined) {
    sets.push("position = ?");
    binds.push(patch.position);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db
    .prepare(`UPDATE checklist_items SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

export async function deleteItem(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("DELETE FROM checklist_items WHERE id = ?")
    .bind(id)
    .run();
}

// 子項目を正として親タスクの完了状態を同期する。
// 全項目完了なら done、未完了または項目なしなら done から todo に戻す。
export async function syncTodoStatusFromItems(
  db: D1Database,
  todoId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE todos
       SET status = CASE
         WHEN EXISTS (
           SELECT 1 FROM checklist_items WHERE todo_id = ?
         ) AND NOT EXISTS (
           SELECT 1 FROM checklist_items WHERE todo_id = ? AND done = 0
         ) THEN 'done'
         WHEN status = 'done' THEN 'todo'
         ELSE status
       END,
       updated_at = ?
       WHERE id = ?`,
    )
    .bind(todoId, todoId, nowIso(), todoId)
    .run();
}
