// 型付き API 呼び出し。型はモノレポ親 src/types.ts を共有。
import { api } from "./client";
import type {
  MeDTO,
  UserDTO,
  TagDTO,
  TodoDTO,
  ChecklistItemDTO,
  CommentDTO,
  InviteDTO,
  RemindersDTO,
  RegisterOwnerBody,
  JoinBody,
  LoginBody,
  CreateTagBody,
  CreateTodoBody,
  UpdateTodoBody,
  CreateItemsBody,
  UpdateItemBody,
  CreateCommentBody,
  TodoStatus,
} from "../../../src/types";

// 招待検証レスポンス（invites ルートの形に合わせる）。
export interface InviteCheckDTO {
  valid: boolean;
  invite?: InviteDTO;
}

export interface TodosQuery {
  status?: TodoStatus;
  assignee?: string;
  tag?: string;
}

function qs(q: TodosQuery): string {
  const p = new URLSearchParams();
  if (q.status) p.set("status", q.status);
  if (q.assignee) p.set("assignee", q.assignee);
  if (q.tag) p.set("tag", q.tag);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const endpoints = {
  // ---- auth / 参加 ----
  me: () => api.get<MeDTO>("/auth/me"),
  register: (b: RegisterOwnerBody) =>
    api.post<{ ok: true; userId: string; householdId: string }>(
      "/auth/register",
      b
    ),
  login: (b: LoginBody) =>
    api.post<{ ok: true; userId: string }>("/auth/login", b),
  join: (token: string, b: JoinBody) =>
    api.post<{ ok: true; userId: string; householdId: string }>(
      `/join/${encodeURIComponent(token)}`,
      b
    ),
  // 認証済みだが未参加のユーザーが新スペースを作りオーナーになる。
  createHousehold: (householdName: string) =>
    api.post<{ ok: true; householdId: string }>("/households", {
      householdName,
    }),
  logout: () => api.post<{ ok: true }>("/auth/logout"),
  checkInvite: (token: string) =>
    api.get<InviteCheckDTO>(`/invites/${encodeURIComponent(token)}`),

  // ---- 招待（オーナー） ----
  createInvite: () => api.post<InviteDTO>("/invites"),
  revokeInvite: (token: string) =>
    api.del<{ ok: true }>(`/invites/${encodeURIComponent(token)}`),
  removeMember: (userId: string) =>
    api.del<{ ok: true }>(`/members/${encodeURIComponent(userId)}`),

  // ---- データ ----
  users: () => api.get<UserDTO[]>("/users"),
  tags: () => api.get<TagDTO[]>("/tags"),
  createTag: (b: CreateTagBody) => api.post<TagDTO>("/tags", b),
  deleteTag: (id: string) => api.del<{ ok: true }>(`/tags/${id}`),

  todos: (q: TodosQuery = {}) => api.get<TodoDTO[]>(`/todos${qs(q)}`),
  todo: (id: string) => api.get<TodoDTO>(`/todos/${id}`),
  createTodo: (b: CreateTodoBody) => api.post<TodoDTO>("/todos", b),
  updateTodo: (id: string, b: UpdateTodoBody) =>
    api.patch<TodoDTO>(`/todos/${id}`, b),
  deleteTodo: (id: string) => api.del<{ ok: true }>(`/todos/${id}`),

  items: (todoId: string) =>
    api.get<ChecklistItemDTO[]>(`/todos/${todoId}/items`),
  addItems: (todoId: string, b: CreateItemsBody) =>
    api.post<ChecklistItemDTO[]>(`/todos/${todoId}/items`, b),
  updateItem: (id: string, b: UpdateItemBody) =>
    api.patch<ChecklistItemDTO>(`/items/${id}`, b),
  deleteItem: (id: string) => api.del<{ ok: true }>(`/items/${id}`),

  comments: (todoId: string) => api.get<CommentDTO[]>(`/todos/${todoId}/comments`),
  addComment: (todoId: string, b: CreateCommentBody) =>
    api.post<CommentDTO[]>(`/todos/${todoId}/comments`, b),

  reminders: () => api.get<RemindersDTO>("/todos/reminders"),

  // ---- LIFF（LINE 内で Web 本体を開く） ----
  // 公開設定。liffId は秘密でない（未設定なら null）。
  liffConfig: () => api.get<{ liffId: string | null }>("/liff/config"),
  // LIFF の id_token をサーバへ渡してセッションを確立する。
  liffLogin: (idToken: string, friendFlag?: boolean) =>
    api.post<{ ok: true; joinState: "active" | "none" }>("/auth/liff", {
      idToken,
      friendFlag,
    }),
};
