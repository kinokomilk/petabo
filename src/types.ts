// petabo 共有型（API 入出力）。フロント(web)からも import 可能。
// 例: import type { TodoDTO } from "../../src/types";
//
// DB の行型（snake_case）と API の DTO（camelCase）を分け、API 境界は DTO を使う。

// ---------- 列挙 ----------
export type TodoStatus = "todo" | "doing" | "done";
export type Visibility = "shared" | "private";
export type MemberRole = "owner" | "member";
export type MemberStatus = "active" | "removed";

// ---------- DB 行型（snake_case：D1 から返る生の形） ----------
export interface HouseholdRow {
  id: string;
  name: string;
  owner_id: string | null;
  created_at: string;
}

export interface UserRow {
  id: string;
  display_name: string;
  color: string;
  line_user_id: string | null;
  avatar_url: string | null;
  password_hash: string | null;
  salt: string | null;
  created_at: string;
  // Phase 2（LINE）。0005 で追加。
  line_followed: number; // 0 | 1
  line_linked_at: string | null;
  line_unfollowed_at: string | null;
}

// LINE Login の OAuth state / nonce 一時保存行（0005）。
export interface LineLoginStateRow {
  state: string;
  nonce: string;
  created_at: string;
  expires_at: string;
  // 招待リンク経由の参加時に紐付ける招待トークン（通常ログイン/連携では NULL）。
  invite_token: string | null;
}

export interface MembershipRow {
  household_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  joined_at: string;
}

export interface InviteTokenRow {
  token: string;
  household_id: string;
  created_by: string | null;
  expires_at: string | null;
  created_at: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  created_at: string;
  expires_at: string | null;
}

export interface TagRow {
  id: string;
  household_id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface TodoRow {
  id: string;
  household_id: string;
  title: string;
  description: string;
  status: TodoStatus;
  is_checklist: number;
  is_important: number;
  visibility: Visibility;
  due_date: string | null;
  assignee_id: string | null;
  creator_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChecklistItemRow {
  id: string;
  todo_id: string;
  text: string;
  done: number;
  position: number;
  created_at: string;
}

export interface CommentRow {
  id: string;
  todo_id: string;
  user_id: string | null;
  body: string;
  created_at: string;
}

// ---------- API DTO（camelCase：クライアントへ返す形） ----------
export interface UserDTO {
  id: string;
  displayName: string;
  color: string;
  avatarUrl: string | null;
}

export interface TagDTO {
  id: string;
  name: string;
  color: string;
}

export interface ChecklistItemDTO {
  id: string;
  todoId: string;
  text: string;
  done: boolean;
  position: number;
}

export interface CommentDTO {
  id: string;
  todoId: string;
  body: string;
  user: UserDTO | null;
  createdAt: string;
}

export interface ChecklistProgress {
  done: number;
  total: number;
}

// 一覧/取得で返す hydrate 済み TODO
export interface TodoDTO {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  isChecklist: boolean;
  isImportant: boolean;
  visibility: Visibility;
  dueDate: string | null;
  assignee: UserDTO | null;
  creator: UserDTO | null;
  tags: TagDTO[];
  checklist: ChecklistProgress;
  checklistItems: ChecklistItemDTO[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface HouseholdDTO {
  id: string;
  name: string;
  ownerId: string | null;
}

// 参加状態を含む現在ユーザー情報
export interface MeDTO {
  authenticated: boolean;
  user: UserDTO | null;
  membership: {
    role: MemberRole;
    status: MemberStatus;
  } | null;
  household: HouseholdDTO | null;
  // フロントが画面分岐に使う: 'active' = 参加済 / 'none' = 未参加（招待待ち）
  joinState: "active" | "none";
  // LINE アカウントと連携済みか（設定画面の「LINEと連携」導線の出し分けに使う）。
  lineLinked: boolean;
}

export interface InviteDTO {
  token: string;
  householdId: string;
  expiresAt: string | null;
  createdAt: string;
  // フロントが共有リンクを組み立てやすいよう相対パスも返す
  joinPath: string; // 例: "/join/<token>"
}

// ---------- リクエストボディ型 ----------
export interface RegisterOwnerBody {
  householdName: string;
  displayName: string;
  password: string;
}

export interface JoinBody {
  displayName: string;
  password: string;
}

export interface LoginBody {
  displayName: string;
  password: string;
}

export interface CreateTagBody {
  name: string;
  color?: string;
}

export interface CreateTodoBody {
  title: string;
  description?: string;
  status?: TodoStatus;
  isChecklist?: boolean;
  isImportant?: boolean;
  visibility?: Visibility;
  dueDate?: string | null;
  assigneeId?: string | null;
  tagIds?: string[];
  items?: string[]; // チェックリスト初期項目
}

export interface UpdateTodoBody {
  title?: string;
  description?: string;
  status?: TodoStatus;
  isChecklist?: boolean;
  isImportant?: boolean;
  visibility?: Visibility;
  dueDate?: string | null;
  assigneeId?: string | null;
  tagIds?: string[];
}

export interface CreateItemsBody {
  // 単一 text でも、改行を含む一括テキストでも、配列でも受ける
  text?: string;
  texts?: string[];
}

export interface UpdateItemBody {
  text?: string;
  done?: boolean;
  position?: number;
}

export interface CreateCommentBody {
  body: string;
}

export interface RemindersDTO {
  overdue: TodoDTO[];
  dueSoon: TodoDTO[]; // 24h 以内
}

export interface ApiError {
  error: string;
}
