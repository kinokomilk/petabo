import type {
  CreateItemsBody,
  CreateTodoBody,
  TodoRow,
  TodoStatus,
  UpdateTodoBody,
  Visibility,
} from "../types";

const STATUSES: TodoStatus[] = ["todo", "doing", "done"];
const VISIBILITIES: Visibility[] = ["shared", "private"];
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_ITEM_TEXT_LENGTH = 300;

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ValidCreateTodo {
  raw: CreateTodoBody;
  title: string;
  description: string;
  status: TodoStatus;
  visibility: Visibility;
  dueDate: string | null;
  isChecklist: boolean;
  isImportant: boolean;
  tagIds: string[] | undefined;
  initialItems: string[];
}

function isTodoStatus(v: unknown): v is TodoStatus {
  return typeof v === "string" && STATUSES.includes(v as TodoStatus);
}

function isVisibility(v: unknown): v is Visibility {
  return typeof v === "string" && VISIBILITIES.includes(v as Visibility);
}

function isValidDueDate(v: unknown): v is string | null {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString() === v;
}

function cleanInitialItems(items: unknown): string[] {
  return Array.isArray(items)
    ? items
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
}

export function cleanItemTexts(body: CreateItemsBody | null): string[] {
  const texts: string[] = [];
  if (body) {
    if (Array.isArray(body.texts)) {
      for (const text of body.texts) {
        if (typeof text !== "string") continue;
        texts.push(text);
      }
    }
    // text に改行を含む一括登録もサポート。
    if (typeof body.text === "string") texts.push(...body.text.split("\n"));
  }
  return texts.map((t) => t.trim()).filter((t) => t.length > 0);
}

export function validateStatusQuery(status: unknown): ValidationResult<TodoStatus | undefined> {
  if (status === undefined) return { ok: true, value: undefined };
  if (!isTodoStatus(status)) return { ok: false, error: "status が不正です" };
  return { ok: true, value: status };
}

export function validateCreateTodoBody(
  body: CreateTodoBody | null,
): ValidationResult<ValidCreateTodo> {
  if (!body || typeof body.title !== "string" || !body.title.trim()) {
    return { ok: false, error: "title は必須です" };
  }
  const title = body.title.trim();
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, error: "title が長すぎます" };
  }
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" ||
      body.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return { ok: false, error: "description が不正です" };
  }
  if (body.status !== undefined && !isTodoStatus(body.status)) {
    return { ok: false, error: "status が不正です" };
  }
  if (body.visibility !== undefined && !isVisibility(body.visibility)) {
    return { ok: false, error: "visibility が不正です" };
  }
  if (body.dueDate !== undefined && !isValidDueDate(body.dueDate)) {
    return { ok: false, error: "dueDate が不正です" };
  }

  const initialItems = cleanInitialItems(body.items);
  if (initialItems.some((t) => t.length > MAX_ITEM_TEXT_LENGTH)) {
    return { ok: false, error: "チェックリスト項目が長すぎます" };
  }

  return {
    ok: true,
    value: {
      raw: body,
      title,
      description: typeof body.description === "string" ? body.description : "",
      status: body.status ?? "todo",
      visibility: body.visibility ?? "shared",
      dueDate: body.dueDate ?? null,
      isChecklist: body.isChecklist === true,
      isImportant: body.isImportant === true,
      tagIds: body.tagIds,
      initialItems,
    },
  };
}

export function validateUpdateTodoBody(
  body: UpdateTodoBody | null,
): ValidationResult<UpdateTodoBody> {
  if (!body) return { ok: false, error: "invalid body" };

  if (body.status !== undefined && !isTodoStatus(body.status)) {
    return { ok: false, error: "status が不正です" };
  }
  if (body.visibility !== undefined && !isVisibility(body.visibility)) {
    return { ok: false, error: "visibility が不正です" };
  }
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.trim().length > MAX_TITLE_LENGTH)
  ) {
    return { ok: false, error: "title が不正です" };
  }
  if (
    body.description !== undefined &&
    (typeof body.description !== "string" ||
      body.description.length > MAX_DESCRIPTION_LENGTH)
  ) {
    return { ok: false, error: "description が不正です" };
  }
  if (body.dueDate !== undefined && !isValidDueDate(body.dueDate)) {
    return { ok: false, error: "dueDate が不正です" };
  }

  return { ok: true, value: body };
}

export function assigneeForCreate(
  body: CreateTodoBody,
  visibility: Visibility,
  userId: string,
): string | null {
  let assigneeId = body.assigneeId === undefined ? userId : body.assigneeId;
  if (visibility === "private" && assigneeId && assigneeId !== userId) {
    assigneeId = null;
  }
  return assigneeId;
}

export function assigneeForUpdate(
  body: UpdateTodoBody,
  current: TodoRow,
  userId: string,
): string | null | undefined {
  const nextVisibility = body.visibility ?? current.visibility;
  let assigneeId = body.assigneeId;
  if (
    nextVisibility === "private" &&
    assigneeId !== undefined &&
    assigneeId &&
    assigneeId !== userId
  ) {
    assigneeId = null;
  }
  return assigneeId;
}
