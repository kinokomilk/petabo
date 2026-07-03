-- petabo Phase 2: LINE ログイン + リマインダー通知の基盤スキーマ。
-- 既存マイグレーション（0001–0004）は変更不可。本ファイルは追加のみ。
-- SPEC §4 認証 / §6 LINE / §9 データモデル、PHASE2_LINE_DESIGN_REVIEW のデータモデル候補に準拠。

-- users へ LINE 連携状態の列を追加。
--  line_followed       : 公式アカウントを友だち追加中か（push 可否判定の基準）。0/1。
--  line_linked_at      : LINE ログインで line_user_id を紐付けた時刻（ISO8601）。
--  line_unfollowed_at  : unfollow を受信した時刻（再 follow / 抑止判定の参考）。
ALTER TABLE users ADD COLUMN line_followed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN line_linked_at TEXT;
ALTER TABLE users ADD COLUMN line_unfollowed_at TEXT;

-- LINE Login の OAuth state / nonce を短命保存するテーブル。
-- /api/auth/line/start で発行し、/api/auth/line/callback で照合・即削除する。
CREATE TABLE line_login_states (
  state      TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- 期限切れ state の掃除を効率化するインデックス。
CREATE INDEX idx_line_login_states_expires ON line_login_states(expires_at);

-- line_followed の 0/1 を 0004 のスタイルに倣って BEFORE トリガで検証。
CREATE TRIGGER IF NOT EXISTS validate_users_line_followed_insert
BEFORE INSERT ON users
WHEN NEW.line_followed NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid user line_followed');
END;

CREATE TRIGGER IF NOT EXISTS validate_users_line_followed_update
BEFORE UPDATE OF line_followed ON users
WHEN NEW.line_followed NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid user line_followed');
END;
