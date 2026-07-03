-- 招待リンク経由の LINE 参加を可能にする。
-- /api/auth/line/start?invite=<token> で受けた招待トークンを OAuth state に一時的に紐付け、
-- callback で検証して household の membership を作成するために使う。
-- NULL = 通常の LINE ログイン/連携（招待なし）。
ALTER TABLE line_login_states ADD COLUMN invite_token TEXT;
