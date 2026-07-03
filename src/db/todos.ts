// todos リポジトリ。一覧/取得は assignee/creator/tags/checklist 進捗/comment 数を
// まとめ取り(IN クエリ)で hydrate し N+1 を避ける。
// private 隔離は creator_id によりサーバ側で厳格にフィルタ。
import type {
  TodoRow,
  TodoDTO,
  TodoStatus,
  Visibility,
  UserRow,
  TagRow,
  ChecklistItemRow,
} from "../types";
import {
  nowIso,
  placeholders,
  toUserDTO,
  TODO_LIST_LIMIT,
} from "./util";
import { uuid } from "../auth/crypto";
import { jstStartOfTodayIso } from "../time";

export interface TodoFilter {
  status?: TodoStatus;
  assigneeId?: string;
  tagId?: string;
}

export interface CreateTodoInput {
  householdId: string;
  creatorId: string;
  title: string;
  description: string;
  status: TodoStatus;
  isChecklist: boolean;
  isImportant: boolean;
  visibility: Visibility;
  dueDate: string | null;
  assigneeId: string | null;
}

export async function createTodo(
  db: D1Database,
  input: CreateTodoInput,
): Promise<TodoRow> {
  const id = uuid();
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO todos
       (id, household_id, title, description, status, is_checklist, is_important, visibility, due_date, assignee_id, creator_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.householdId,
      input.title,
      input.description,
      input.status,
      input.isChecklist ? 1 : 0,
      input.isImportant ? 1 : 0,
      input.visibility,
      input.dueDate,
      input.assigneeId,
      input.creatorId,
      ts,
      ts,
    )
    .run();
  return getTodoRow(db, input.householdId, id) as Promise<TodoRow>;
}

// household スコープの単一 todo 行（private 判定は呼び出し側で行う）。
export async function getTodoRow(
  db: D1Database,
  householdId: string,
  id: string,
): Promise<TodoRow | null> {
  return db
    .prepare("SELECT * FROM todos WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .first<TodoRow>();
}

// 認可フィルタ込みの一覧クエリ。
// visibility='private' は creator のみ（viewerId 一致時のみ）に出す。
export async function listTodos(
  db: D1Database,
  householdId: string,
  viewerId: string,
  filter: TodoFilter,
): Promise<TodoRow[]> {
  const clauses: string[] = ["t.household_id = ?"];
  const binds: unknown[] = [householdId];

  // private 隔離：shared か、または自分が作成した private のみ。
  clauses.push("(t.visibility = 'shared' OR t.creator_id = ?)");
  binds.push(viewerId);

  if (filter.status) {
    clauses.push("t.status = ?");
    binds.push(filter.status);
  }
  if (filter.assigneeId) {
    clauses.push("t.assignee_id = ?");
    binds.push(filter.assigneeId);
  }
  if (filter.tagId) {
    clauses.push(
      "t.id IN (SELECT todo_id FROM todo_tags WHERE tag_id = ?)",
    );
    binds.push(filter.tagId);
  }

  // 並び順：due_date 近い順（NULL は後ろ）→ created_at。件数上限あり。
  const sql = `SELECT t.* FROM todos t
     WHERE ${clauses.join(" AND ")}
     ORDER BY (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at ASC
     LIMIT ?`;
  binds.push(TODO_LIST_LIMIT);

  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<TodoRow>();
  return res.results ?? [];
}

export interface UpdateTodoInput {
  title?: string;
  description?: string;
  status?: TodoStatus;
  isChecklist?: boolean;
  isImportant?: boolean;
  visibility?: Visibility;
  dueDate?: string | null;
  assigneeId?: string | null;
}

export async function updateTodo(
  db: D1Database,
  householdId: string,
  id: string,
  patch: UpdateTodoInput,
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    binds.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push("description = ?");
    binds.push(patch.description);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    binds.push(patch.status);
  }
  if (patch.isChecklist !== undefined) {
    sets.push("is_checklist = ?");
    binds.push(patch.isChecklist ? 1 : 0);
  }
  if (patch.isImportant !== undefined) {
    sets.push("is_important = ?");
    binds.push(patch.isImportant ? 1 : 0);
  }
  if (patch.visibility !== undefined) {
    sets.push("visibility = ?");
    binds.push(patch.visibility);
  }
  if (patch.dueDate !== undefined) {
    sets.push("due_date = ?");
    binds.push(patch.dueDate);
  }
  if (patch.assigneeId !== undefined) {
    sets.push("assignee_id = ?");
    binds.push(patch.assigneeId);
  }
  sets.push("updated_at = ?");
  binds.push(nowIso());

  binds.push(id, householdId);
  await db
    .prepare(`UPDATE todos SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`)
    .bind(...binds)
    .run();
}

// 期限変更時のリマインダー・リセット。
// due_date が変わったら当該 todo の todo_reminders 行を削除し、
// 新しい期限で再度（overdue / due_soon を）通知できるようにする。
export async function clearTodoReminders(
  db: D1Database,
  todoId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM todo_reminders WHERE todo_id = ?")
    .bind(todoId)
    .run();
}

export async function deleteTodo(
  db: D1Database,
  householdId: string,
  id: string,
): Promise<void> {
  // 関連（checklist_items/comments/todo_tags）は FK CASCADE で消える。
  await db
    .prepare("DELETE FROM todos WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .run();
}

// --- tag の付け替え ---
export async function setTodoTags(
  db: D1Database,
  householdId: string,
  todoId: string,
  tagIds: string[],
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  statements.push(
    db.prepare("DELETE FROM todo_tags WHERE todo_id = ?").bind(todoId),
  );
  if (tagIds.length > 0) {
    // household に属する tag のみ受け付ける（他 household の tag を弾く）。
    const valid = await db
      .prepare(
        `SELECT id FROM tags WHERE household_id = ? AND id IN (${placeholders(
          tagIds.length,
        )})`,
      )
      .bind(householdId, ...tagIds)
      .all<{ id: string }>();
    const insertStmt = db.prepare(
      "INSERT OR IGNORE INTO todo_tags (todo_id, tag_id) VALUES (?, ?)",
    );
    for (const row of valid.results ?? []) {
      statements.push(insertStmt.bind(todoId, row.id));
    }
  }
  await db.batch(statements);
}

// ---------- hydrate ----------
// 複数 todo をまとめて DTO 化する。関連は IN クエリで一括取得（N+1 回避）。
export async function hydrateTodos(
  db: D1Database,
  rows: TodoRow[],
): Promise<TodoDTO[]> {
  if (rows.length === 0) return [];

  const todoIds = rows.map((r) => r.id);
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.assignee_id) userIds.add(r.assignee_id);
    if (r.creator_id) userIds.add(r.creator_id);
  }

  // users まとめ取り
  const userMap = new Map<string, UserRow>();
  if (userIds.size > 0) {
    const ids = [...userIds];
    const res = await db
      .prepare(`SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`)
      .bind(...ids)
      .all<UserRow>();
    for (const u of res.results ?? []) userMap.set(u.id, u);
  }

  // tags まとめ取り（todo_tags JOIN tags）
  const tagsByTodo = new Map<string, TagRow[]>();
  {
    const res = await db
      .prepare(
        `SELECT tt.todo_id AS todo_id, tg.* FROM todo_tags tt
         JOIN tags tg ON tg.id = tt.tag_id
         WHERE tt.todo_id IN (${placeholders(todoIds.length)})`,
      )
      .bind(...todoIds)
      .all<TagRow & { todo_id: string }>();
    for (const row of res.results ?? []) {
      const list = tagsByTodo.get(row.todo_id) ?? [];
      list.push({
        id: row.id,
        household_id: row.household_id,
        name: row.name,
        color: row.color,
        created_at: row.created_at,
      });
      tagsByTodo.set(row.todo_id, list);
    }
  }

  // checklist 進捗 (done/total) まとめ取り
  const progressByTodo = new Map<string, { done: number; total: number }>();
  const itemsByTodo = new Map<string, ChecklistItemRow[]>();
  {
    const res = await db
      .prepare(
        `SELECT todo_id,
                COUNT(*) AS total,
                SUM(CASE WHEN done = 1 THEN 1 ELSE 0 END) AS done
         FROM checklist_items
         WHERE todo_id IN (${placeholders(todoIds.length)})
         GROUP BY todo_id`,
      )
      .bind(...todoIds)
      .all<{ todo_id: string; total: number; done: number }>();
    for (const row of res.results ?? []) {
      progressByTodo.set(row.todo_id, {
        done: Number(row.done ?? 0),
        total: Number(row.total ?? 0),
      });
    }
  }

  // ホームでも直接操作できるよう、項目本体もまとめて取得する。
  {
    const res = await db
      .prepare(
        `SELECT * FROM checklist_items
         WHERE todo_id IN (${placeholders(todoIds.length)})
         ORDER BY todo_id ASC, position ASC, created_at ASC`,
      )
      .bind(...todoIds)
      .all<ChecklistItemRow>();
    for (const row of res.results ?? []) {
      const list = itemsByTodo.get(row.todo_id) ?? [];
      list.push(row);
      itemsByTodo.set(row.todo_id, list);
    }
  }

  // comment 数まとめ取り
  const commentCountByTodo = new Map<string, number>();
  {
    const res = await db
      .prepare(
        `SELECT todo_id, COUNT(*) AS c FROM comments
         WHERE todo_id IN (${placeholders(todoIds.length)})
         GROUP BY todo_id`,
      )
      .bind(...todoIds)
      .all<{ todo_id: string; c: number }>();
    for (const row of res.results ?? []) {
      commentCountByTodo.set(row.todo_id, Number(row.c ?? 0));
    }
  }

  return rows.map((r) => {
    const assignee = r.assignee_id ? userMap.get(r.assignee_id) : null;
    const creator = r.creator_id ? userMap.get(r.creator_id) : null;
    const progress = progressByTodo.get(r.id) ?? { done: 0, total: 0 };
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      isChecklist: r.is_checklist === 1,
      isImportant: r.is_important === 1,
      visibility: r.visibility,
      dueDate: r.due_date,
      assignee: assignee ? toUserDTO(assignee) : null,
      creator: creator ? toUserDTO(creator) : null,
      tags: (tagsByTodo.get(r.id) ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
      })),
      checklist: progress,
      checklistItems: (itemsByTodo.get(r.id) ?? []).map((item) => ({
        id: item.id,
        todoId: item.todo_id,
        text: item.text,
        done: item.done === 1,
        position: item.position,
      })),
      commentCount: commentCountByTodo.get(r.id) ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export async function hydrateTodo(
  db: D1Database,
  row: TodoRow,
): Promise<TodoDTO> {
  const [dto] = await hydrateTodos(db, [row]);
  return dto;
}

// リマインダー：overdue / due_soon(24h)。private は viewer(creator) のみ。
export async function listReminderRows(
  db: D1Database,
  householdId: string,
  viewerId: string,
): Promise<{ overdue: TodoRow[]; dueSoon: TodoRow[] }> {
  const now = Date.now();
  const soon = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  // overdue は「期限の日付(JST)が今日より前」。今日が期限のものは当日中 overdue にしない。
  const jstStartIso = jstStartOfTodayIso(now);

  const res = await db
    .prepare(
      `SELECT * FROM todos
       WHERE household_id = ?
         AND status != 'done'
         AND due_date IS NOT NULL
         AND due_date <= ?
         AND (visibility = 'shared' OR creator_id = ?)
       ORDER BY due_date ASC
       LIMIT ?`,
    )
    .bind(householdId, soon, viewerId, TODO_LIST_LIMIT)
    .all<TodoRow>();

  const overdue: TodoRow[] = [];
  const dueSoon: TodoRow[] = [];
  for (const r of res.results ?? []) {
    if (r.due_date && r.due_date < jstStartIso) overdue.push(r);
    else dueSoon.push(r);
  }
  return { overdue, dueSoon };
}
