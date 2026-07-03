// D1 アクセスの共通ヘルパー。すべて bind プレースホルダを使う（文字列結合禁止）。
import type { UserRow, UserDTO } from "../types";

export function nowIso(): string {
  return new Date().toISOString();
}

// IN (?, ?, ...) のプレースホルダ列を作る。空配列は呼び出し側で弾く。
export function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

export function toUserDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    displayName: u.display_name,
    color: u.color,
    avatarUrl: u.avatar_url,
  };
}

// 一覧の取得上限（無制限禁止）。家族規模では十分。
export const TODO_LIST_LIMIT = 500;
export const COMMENT_LIST_LIMIT = 500;
export const ITEM_LIST_LIMIT = 1000;
