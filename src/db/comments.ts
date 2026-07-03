// comments リポジトリ。一覧は user を hydrate（IN クエリでまとめ取り）。
import type { CommentRow, CommentDTO, UserRow } from "../types";
import { nowIso, placeholders, toUserDTO, COMMENT_LIST_LIMIT } from "./util";
import { uuid } from "../auth/crypto";

export async function listComments(
  db: D1Database,
  todoId: string,
): Promise<CommentDTO[]> {
  const res = await db
    .prepare(
      "SELECT * FROM comments WHERE todo_id = ? ORDER BY created_at ASC LIMIT ?",
    )
    .bind(todoId, COMMENT_LIST_LIMIT)
    .all<CommentRow>();
  const rows = res.results ?? [];
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.filter((r) => r.user_id).map((r) => r.user_id!))];
  const userMap = new Map<string, UserRow>();
  if (userIds.length > 0) {
    const users = await db
      .prepare(`SELECT * FROM users WHERE id IN (${placeholders(userIds.length)})`)
      .bind(...userIds)
      .all<UserRow>();
    for (const u of users.results ?? []) userMap.set(u.id, u);
  }

  return rows.map((r) => ({
    id: r.id,
    todoId: r.todo_id,
    body: r.body,
    user: r.user_id && userMap.get(r.user_id) ? toUserDTO(userMap.get(r.user_id)!) : null,
    createdAt: r.created_at,
  }));
}

export async function addComment(
  db: D1Database,
  todoId: string,
  userId: string,
  body: string,
): Promise<CommentRow> {
  const id = uuid();
  const createdAt = nowIso();
  await db
    .prepare(
      "INSERT INTO comments (id, todo_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, todoId, userId, body, createdAt)
    .run();
  return { id, todo_id: todoId, user_id: userId, body, created_at: createdAt };
}
