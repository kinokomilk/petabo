-- petabo 初期スキーマ（Phase 1）
-- SPEC §2 データモデル + §9 参加・権限追補 + リード確定事項（todos/tags に household_id 付与）
-- D1 / SQLite 互換。すべて TEXT id（uuid）。日時は ISO8601 文字列。

-- 家族スペース（当面1行。将来の複数家族化に備える）
CREATE TABLE households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT,
  created_at TEXT NOT NULL
);

-- ユーザー（LINE勢 or フォールバック勢）
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  color         TEXT NOT NULL,            -- アバター色（パレットから登録順に割当）
  line_user_id  TEXT UNIQUE,             -- LINEログイン勢。Phase 1 では NULL
  avatar_url    TEXT,
  password_hash TEXT,                    -- フォールバック勢
  salt          TEXT,
  created_at    TEXT NOT NULL
);

-- 参加（メンバーシップ）
CREATE TABLE memberships (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  status       TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'removed'
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id)
);

-- 招待トークン
CREATE TABLE invite_tokens (
  token        TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TEXT,
  created_at   TEXT NOT NULL
);

-- セッション（HttpOnly Cookie のトークンを保持）
CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

-- タグ（household スコープ）。確定事項により household_id を付与。
-- name の一意性は household 内で担保（UNIQUE(household_id, name)）。
CREATE TABLE tags (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (household_id, name)
);

-- TODO（household スコープ）。確定事項により household_id を付与。
CREATE TABLE todos (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'todo',   -- 'todo' | 'doing' | 'done'
  is_checklist INTEGER NOT NULL DEFAULT 0,
  visibility   TEXT NOT NULL DEFAULT 'shared', -- 'shared' | 'private'
  due_date     TEXT,
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE checklist_items (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE todo_tags (
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (todo_id, tag_id)
);

CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  todo_id    TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- リマインダー重複送信の防止（Phase 2 利用。スキーマは先に用意）
CREATE TABLE todo_reminders (
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (todo_id, kind)
);

-- --- インデックス ---
CREATE INDEX idx_todos_household_status ON todos(household_id, status);
CREATE INDEX idx_todos_assignee         ON todos(assignee_id);
CREATE INDEX idx_todos_creator          ON todos(creator_id);
CREATE INDEX idx_todos_due_date         ON todos(due_date);
CREATE INDEX idx_checklist_todo_pos     ON checklist_items(todo_id, position);
CREATE INDEX idx_comments_todo          ON comments(todo_id);
CREATE INDEX idx_todo_tags_tag          ON todo_tags(tag_id);
CREATE INDEX idx_sessions_expires       ON sessions(expires_at);
CREATE INDEX idx_sessions_user          ON sessions(user_id);
CREATE INDEX idx_memberships_user       ON memberships(user_id);
CREATE INDEX idx_tags_household         ON tags(household_id);
CREATE INDEX idx_invite_tokens_household ON invite_tokens(household_id);
