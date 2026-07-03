-- todos に重要フラグ（スター/重要ピン留め）を追加。
-- 重要は可視性に影響しない（既存の private/認可ルールは不変）。
-- 並び順は変更しない（DTO に載せてフロントが扱う方針）。
ALTER TABLE todos ADD COLUMN is_important INTEGER NOT NULL DEFAULT 0;
