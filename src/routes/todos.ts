// todos / checklist items / comments / reminders。
// 認可：アクティブ membership で shared 読み書き可。private は creator 厳格隔離。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import type {
  CreateTodoBody,
  UpdateTodoBody,
  CreateItemsBody,
  UpdateItemBody,
  CreateCommentBody,
  TodoRow,
} from "../types";
import { requireAuth, authCtx } from "../auth/middleware";
import {
  createTodo,
  getTodoRow,
  listTodos,
  updateTodo,
  deleteTodo,
  setTodoTags,
  hydrateTodo,
  hydrateTodos,
  clearTodoReminders,
  type TodoFilter,
} from "../db/todos";
import {
  addItems,
  listItems,
  getItem,
  updateItem,
  deleteItem,
  syncTodoStatusFromItems,
  toItemDTO,
} from "../db/items";
import { listComments, addComment } from "../db/comments";
import { listActiveMembers } from "../db/households";
import {
  assigneeForCreate,
  assigneeForUpdate,
  cleanItemTexts,
  validateCreateTodoBody,
  validateStatusQuery,
  validateUpdateTodoBody,
} from "./todoInput";

export const todoRoutes = new Hono<HonoEnv>();

const MAX_COMMENT_LENGTH = 1000;
const MAX_ITEM_TEXT_LENGTH = 300;

// private 隔離の中核：household 内かつ、shared か自分の private のみ可視。
// 見えない場合は 404（存在を隠す）。
async function loadVisibleTodo(
  db: D1Database,
  householdId: string,
  viewerId: string,
  todoId: string,
): Promise<TodoRow | null> {
  const row = await getTodoRow(db, householdId, todoId);
  if (!row) return null;
  if (row.visibility === "private" && row.creator_id !== viewerId) return null;
  return row;
}

// assignee が同 household の active メンバーかを検証する。
async function isActiveMember(
  db: D1Database,
  householdId: string,
  userId: string,
): Promise<boolean> {
  const members = await listActiveMembers(db, householdId);
  return members.some((m) => m.id === userId);
}

// ---------- 一覧 ----------
todoRoutes.get("/todos", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const statusParam = c.req.query("status");
  const filter: TodoFilter = {};
  const status = validateStatusQuery(statusParam);
  if (!status.ok) return c.json({ error: status.error }, 400);
  if (status.value) filter.status = status.value;
  const assignee = c.req.query("assignee");
  if (assignee) filter.assigneeId = assignee;
  const tag = c.req.query("tag");
  if (tag) filter.tagId = tag;

  const rows = await listTodos(c.env.DB, household.id, user.id, filter);
  const dtos = await hydrateTodos(c.env.DB, rows);
  return c.json(dtos);
});

// ---------- 作成 ----------
todoRoutes.post("/todos", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const body = (await c.req.json().catch(() => null)) as CreateTodoBody | null;
  const valid = validateCreateTodoBody(body);
  if (!valid.ok) return c.json({ error: valid.error }, 400);
  const input = valid.value;

  // 未指定なら作成者を担当にする。null は明示的な未担当として扱う。
  // private は自分専用：他人を担当に設定しない。
  const assigneeId = assigneeForCreate(input.raw, input.visibility, user.id);
  // 担当者が指定された場合、同 household の active メンバーであることを検証。
  if (assigneeId && !(await isActiveMember(c.env.DB, household.id, assigneeId))) {
    return c.json({ error: "不正な担当者です" }, 400);
  }

  const row = await createTodo(c.env.DB, {
    householdId: household.id,
    creatorId: user.id,
    title: input.title,
    description: input.description,
    status: input.status,
    isChecklist: input.isChecklist,
    isImportant: input.isImportant,
    visibility: input.visibility,
    dueDate: input.dueDate,
    assigneeId,
  });

  if (Array.isArray(input.tagIds) && input.tagIds.length > 0) {
    await setTodoTags(c.env.DB, household.id, row.id, input.tagIds);
  }
  if (input.initialItems.length > 0) {
    await addItems(c.env.DB, row.id, input.initialItems);
  }

  const fresh = (await getTodoRow(c.env.DB, household.id, row.id))!;
  return c.json(await hydrateTodo(c.env.DB, fresh), 201);
});

// ---------- 取得 ----------
todoRoutes.get("/todos/:id", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(await hydrateTodo(c.env.DB, row));
});

// ---------- 更新 ----------
todoRoutes.patch("/todos/:id", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const id = c.req.param("id");
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as UpdateTodoBody | null;
  const valid = validateUpdateTodoBody(body);
  if (!valid.ok) return c.json({ error: valid.error }, 400);
  const input = valid.value;

  if (input.visibility !== undefined && row.creator_id !== user.id) {
    return c.json({ error: "公開範囲の変更は作成者のみ可能です" }, 403);
  }

  // 結果として private になる場合、他人担当は剥がす（自分専用）。
  const assigneeId = assigneeForUpdate(input, row, user.id);
  // 担当者が指定された場合、同 household の active メンバーであることを検証。
  // （undefined は未指定で変更なし、null は担当解除なので検証対象外）
  if (
    assigneeId !== undefined &&
    assigneeId &&
    !(await isActiveMember(c.env.DB, household.id, assigneeId))
  ) {
    return c.json({ error: "不正な担当者です" }, 400);
  }

  await updateTodo(c.env.DB, household.id, id, {
    title: input.title?.trim(),
    description: input.description,
    status: input.status,
    isChecklist: input.isChecklist,
    isImportant: input.isImportant,
    visibility: input.visibility,
    dueDate: input.dueDate,
    assigneeId,
  });
  if (input.tagIds !== undefined) {
    await setTodoTags(c.env.DB, household.id, id, input.tagIds ?? []);
  }

  // 期限が変わったらリマインダーをリセット（新しい期限で再通知できるように）。
  // body.dueDate が指定され、かつ実際に値が変化した場合のみ削除する。
  if (
    input.dueDate !== undefined &&
    (input.dueDate ?? null) !== (row.due_date ?? null)
  ) {
    await clearTodoReminders(c.env.DB, id);
  }

  const fresh = (await getTodoRow(c.env.DB, household.id, id))!;
  return c.json(await hydrateTodo(c.env.DB, fresh));
});

// ---------- 削除（ハード, CASCADE） ----------
todoRoutes.delete("/todos/:id", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const id = c.req.param("id");
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  await deleteTodo(c.env.DB, household.id, id);
  return c.json({ ok: true });
});

// ---------- checklist items ----------
todoRoutes.get("/todos/:id/items", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const items = await listItems(c.env.DB, row.id);
  return c.json(items.map(toItemDTO));
});

todoRoutes.post("/todos/:id/items", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as CreateItemsBody | null;
  const texts = cleanItemTexts(body);
  if (texts.length === 0) {
    return c.json({ error: "text または texts が必要です" }, 400);
  }
  if (texts.some((t) => t.length > MAX_ITEM_TEXT_LENGTH)) {
    return c.json({ error: "チェックリスト項目が長すぎます" }, 400);
  }
  const created = await addItems(c.env.DB, row.id, texts);
  await syncTodoStatusFromItems(c.env.DB, row.id);
  return c.json(created.map(toItemDTO), 201);
});

// 項目の親 todo を辿り可視性チェックするヘルパー。
async function loadItemWithTodo(
  db: D1Database,
  householdId: string,
  viewerId: string,
  itemId: string,
) {
  const item = await getItem(db, itemId);
  if (!item) return null;
  const todo = await loadVisibleTodo(db, householdId, viewerId, item.todo_id);
  if (!todo) return null;
  return { item, todo };
}

todoRoutes.patch("/items/:id", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const loaded = await loadItemWithTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!loaded) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as UpdateItemBody | null;
  if (!body) return c.json({ error: "invalid body" }, 400);
  if (
    body.text !== undefined &&
    (typeof body.text !== "string" ||
      !body.text.trim() ||
      body.text.trim().length > MAX_ITEM_TEXT_LENGTH)
  ) {
    return c.json({ error: "text が不正です" }, 400);
  }
  await updateItem(c.env.DB, loaded.item.id, {
    text: typeof body.text === "string" ? body.text.trim() : undefined,
    done: typeof body.done === "boolean" ? body.done : undefined,
    position: typeof body.position === "number" ? body.position : undefined,
  });
  if (typeof body.done === "boolean") {
    await syncTodoStatusFromItems(c.env.DB, loaded.todo.id);
  }
  const fresh = await getItem(c.env.DB, loaded.item.id);
  return c.json(toItemDTO(fresh!));
});

todoRoutes.delete("/items/:id", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const loaded = await loadItemWithTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!loaded) return c.json({ error: "not_found" }, 404);
  await deleteItem(c.env.DB, loaded.item.id);
  await syncTodoStatusFromItems(c.env.DB, loaded.todo.id);
  return c.json({ ok: true });
});

// ---------- comments ----------
todoRoutes.get("/todos/:id/comments", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(await listComments(c.env.DB, row.id));
});

todoRoutes.post("/todos/:id/comments", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const row = await loadVisibleTodo(c.env.DB, household.id, user.id, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);

  const body = (await c.req.json().catch(() => null)) as CreateCommentBody | null;
  if (!body || typeof body.body !== "string" || !body.body.trim()) {
    return c.json({ error: "body は必須です" }, 400);
  }
  if (body.body.trim().length > MAX_COMMENT_LENGTH) {
    return c.json({ error: "body が長すぎます" }, 400);
  }
  await addComment(c.env.DB, row.id, user.id, body.body.trim());
  return c.json(await listComments(c.env.DB, row.id), 201);
});
