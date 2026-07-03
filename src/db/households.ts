// households / memberships / invite_tokens / users のリポジトリ。
import type {
  HouseholdRow,
  UserRow,
  MembershipRow,
  InviteTokenRow,
  MemberRole,
} from "../types";
import { nowIso } from "./util";

export async function createHousehold(
  db: D1Database,
  id: string,
  name: string,
  ownerId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO households (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(id, name, ownerId, nowIso())
    .run();
}

export async function getHousehold(
  db: D1Database,
  id: string,
): Promise<HouseholdRow | null> {
  return db
    .prepare("SELECT * FROM households WHERE id = ?")
    .bind(id)
    .first<HouseholdRow>();
}

// 単一スペース運用での唯一の household（最初の1行）。Phase 1 の参照に使用。
export async function getFirstHousehold(
  db: D1Database,
): Promise<HouseholdRow | null> {
  return db
    .prepare("SELECT * FROM households ORDER BY created_at ASC LIMIT 1")
    .first<HouseholdRow>();
}

export async function createUser(
  db: D1Database,
  user: {
    id: string;
    displayName: string;
    color: string;
    passwordHash: string;
    salt: string;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .bind(
      user.id,
      user.displayName,
      user.color,
      user.passwordHash,
      user.salt,
      nowIso(),
    )
    .run();
}

export async function getUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
}

// LINE Login の sub（= line_user_id）でユーザーを引く。
export async function getUserByLineUserId(
  db: D1Database,
  lineUserId: string,
): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE line_user_id = ?")
    .bind(lineUserId)
    .first<UserRow>();
}

// 既存ユーザーへ LINE を紐付ける（表示名/アバターは既存維持）。
// 衝突防止のため、line_user_id が未設定の行のみ更新する。
export async function linkLineToUser(
  db: D1Database,
  userId: string,
  lineUserId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE users
         SET line_user_id = ?, line_linked_at = ?
       WHERE id = ? AND line_user_id IS NULL`,
    )
    .bind(lineUserId, nowIso(), userId)
    .run();
}

// LINE プロフィールから新規ユーザーを作成（membership は付けない＝未参加）。
// パスワードは持たない（line_user_id でログイン）。
export async function createLineUser(
  db: D1Database,
  user: {
    id: string;
    displayName: string;
    color: string;
    lineUserId: string;
    avatarUrl: string | null;
  },
): Promise<void> {
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, display_name, color, line_user_id, avatar_url, password_hash, salt, created_at, line_linked_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .bind(
      user.id,
      user.displayName,
      user.color,
      user.lineUserId,
      user.avatarUrl,
      now,
      now,
    )
    .run();
}

// webhook follow/unfollow で line_followed を更新する（該当行が無ければ no-op）。
export async function setLineFollowed(
  db: D1Database,
  lineUserId: string,
  followed: boolean,
): Promise<void> {
  if (followed) {
    await db
      .prepare(
        "UPDATE users SET line_followed = 1, line_unfollowed_at = NULL WHERE line_user_id = ?",
      )
      .bind(lineUserId)
      .run();
  } else {
    await db
      .prepare(
        "UPDATE users SET line_followed = 0, line_unfollowed_at = ? WHERE line_user_id = ?",
      )
      .bind(nowIso(), lineUserId)
      .run();
  }
}

// 同一 household 内で display_name が一致する active メンバーを探す（ログイン用）。
export async function findActiveUserByName(
  db: D1Database,
  householdId: string,
  displayName: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT u.* FROM users u
       JOIN memberships m ON m.user_id = u.id
       WHERE m.household_id = ? AND m.status = 'active' AND u.display_name = ?
       LIMIT 1`,
    )
    .bind(householdId, displayName)
    .first<UserRow>();
}

// アバター色割当用：household の active メンバー数（登録順インデックス）。
export async function countActiveMembers(
  db: D1Database,
  householdId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS c FROM memberships WHERE household_id = ? AND status = 'active'",
    )
    .bind(householdId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export async function addMembership(
  db: D1Database,
  householdId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)`,
    )
    .bind(householdId, userId, role, nowIso())
    .run();
}

export async function getMembership(
  db: D1Database,
  householdId: string,
  userId: string,
): Promise<MembershipRow | null> {
  return db
    .prepare(
      "SELECT * FROM memberships WHERE household_id = ? AND user_id = ?",
    )
    .bind(householdId, userId)
    .first<MembershipRow>();
}

// membership を active で確実に用意する（招待 LINE 参加の冪等化）。
// PRIMARY KEY (household_id, user_id) のため、過去に removed になった行が
// 残っていても重複させず active へ戻す。
export async function ensureActiveMembership(
  db: D1Database,
  householdId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memberships (household_id, user_id, role, status, joined_at)
       VALUES (?, ?, ?, 'active', ?)
       ON CONFLICT(household_id, user_id)
       DO UPDATE SET status = 'active'`,
    )
    .bind(householdId, userId, role, nowIso())
    .run();
}

// あるユーザーの active な membership（単一スペース運用では1件想定）。
export async function getActiveMembershipForUser(
  db: D1Database,
  userId: string,
): Promise<MembershipRow | null> {
  return db
    .prepare(
      "SELECT * FROM memberships WHERE user_id = ? AND status = 'active' LIMIT 1",
    )
    .bind(userId)
    .first<MembershipRow>();
}

export async function listActiveMembers(
  db: D1Database,
  householdId: string,
): Promise<UserRow[]> {
  const res = await db
    .prepare(
      `SELECT u.* FROM users u
       JOIN memberships m ON m.user_id = u.id
       WHERE m.household_id = ? AND m.status = 'active'
       ORDER BY m.joined_at ASC`,
    )
    .bind(householdId)
    .all<UserRow>();
  return res.results ?? [];
}

export async function removeMember(
  db: D1Database,
  householdId: string,
  userId: string,
): Promise<void> {
  await db
    .prepare(
      "UPDATE memberships SET status = 'removed' WHERE household_id = ? AND user_id = ?",
    )
    .bind(householdId, userId)
    .run();
}

// --- invite tokens ---
export async function createInvite(
  db: D1Database,
  token: string,
  householdId: string,
  createdBy: string,
  expiresAt: string | null,
): Promise<InviteTokenRow> {
  const createdAt = nowIso();
  await db
    .prepare(
      `INSERT INTO invite_tokens (token, household_id, created_by, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(token, householdId, createdBy, expiresAt, createdAt)
    .run();
  return {
    token,
    household_id: householdId,
    created_by: createdBy,
    expires_at: expiresAt,
    created_at: createdAt,
  };
}

export async function getInvite(
  db: D1Database,
  token: string,
): Promise<InviteTokenRow | null> {
  return db
    .prepare("SELECT * FROM invite_tokens WHERE token = ?")
    .bind(token)
    .first<InviteTokenRow>();
}

export async function deleteInvite(
  db: D1Database,
  token: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM invite_tokens WHERE token = ?")
    .bind(token)
    .run();
}

// 招待が有効か（存在・未失効）。
export function isInviteValid(invite: InviteTokenRow | null): invite is InviteTokenRow {
  if (!invite) return false;
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    return false;
  }
  return true;
}
