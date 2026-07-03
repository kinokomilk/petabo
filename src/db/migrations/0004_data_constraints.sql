-- アプリ層の enum / boolean / 色形式検証を DB 側でも補強する。
-- SQLite/D1 は既存テーブルに CHECK 制約を後付けしづらいため、既存データを
-- 作り直さずに済む BEFORE trigger で将来の不正 INSERT/UPDATE を拒否する。

CREATE TRIGGER IF NOT EXISTS validate_memberships_role_insert
BEFORE INSERT ON memberships
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid membership role');
END;

CREATE TRIGGER IF NOT EXISTS validate_memberships_role_update
BEFORE UPDATE OF role ON memberships
WHEN NEW.role NOT IN ('owner', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid membership role');
END;

CREATE TRIGGER IF NOT EXISTS validate_memberships_status_insert
BEFORE INSERT ON memberships
WHEN NEW.status NOT IN ('active', 'removed')
BEGIN
  SELECT RAISE(ABORT, 'invalid membership status');
END;

CREATE TRIGGER IF NOT EXISTS validate_memberships_status_update
BEFORE UPDATE OF status ON memberships
WHEN NEW.status NOT IN ('active', 'removed')
BEGIN
  SELECT RAISE(ABORT, 'invalid membership status');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_status_insert
BEFORE INSERT ON todos
WHEN NEW.status NOT IN ('todo', 'doing', 'done')
BEGIN
  SELECT RAISE(ABORT, 'invalid todo status');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_status_update
BEFORE UPDATE OF status ON todos
WHEN NEW.status NOT IN ('todo', 'doing', 'done')
BEGIN
  SELECT RAISE(ABORT, 'invalid todo status');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_visibility_insert
BEFORE INSERT ON todos
WHEN NEW.visibility NOT IN ('shared', 'private')
BEGIN
  SELECT RAISE(ABORT, 'invalid todo visibility');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_visibility_update
BEFORE UPDATE OF visibility ON todos
WHEN NEW.visibility NOT IN ('shared', 'private')
BEGIN
  SELECT RAISE(ABORT, 'invalid todo visibility');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_booleans_insert
BEFORE INSERT ON todos
WHEN NEW.is_checklist NOT IN (0, 1) OR NEW.is_important NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid todo boolean');
END;

CREATE TRIGGER IF NOT EXISTS validate_todos_booleans_update
BEFORE UPDATE OF is_checklist, is_important ON todos
WHEN NEW.is_checklist NOT IN (0, 1) OR NEW.is_important NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid todo boolean');
END;

CREATE TRIGGER IF NOT EXISTS validate_checklist_items_done_insert
BEFORE INSERT ON checklist_items
WHEN NEW.done NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid checklist done');
END;

CREATE TRIGGER IF NOT EXISTS validate_checklist_items_done_update
BEFORE UPDATE OF done ON checklist_items
WHEN NEW.done NOT IN (0, 1)
BEGIN
  SELECT RAISE(ABORT, 'invalid checklist done');
END;

CREATE TRIGGER IF NOT EXISTS validate_tags_color_insert
BEFORE INSERT ON tags
WHEN NOT (
  length(NEW.color) = 7
  AND substr(NEW.color, 1, 1) = '#'
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 2, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 3, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 4, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 5, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 6, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 7, 1)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid tag color');
END;

CREATE TRIGGER IF NOT EXISTS validate_tags_color_update
BEFORE UPDATE OF color ON tags
WHEN NOT (
  length(NEW.color) = 7
  AND substr(NEW.color, 1, 1) = '#'
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 2, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 3, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 4, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 5, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 6, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 7, 1)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid tag color');
END;

CREATE TRIGGER IF NOT EXISTS validate_users_color_insert
BEFORE INSERT ON users
WHEN NOT (
  length(NEW.color) = 7
  AND substr(NEW.color, 1, 1) = '#'
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 2, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 3, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 4, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 5, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 6, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 7, 1)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid user color');
END;

CREATE TRIGGER IF NOT EXISTS validate_users_color_update
BEFORE UPDATE OF color ON users
WHEN NOT (
  length(NEW.color) = 7
  AND substr(NEW.color, 1, 1) = '#'
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 2, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 3, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 4, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 5, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 6, 1)) > 0
  AND instr('0123456789ABCDEFabcdef', substr(NEW.color, 7, 1)) > 0
)
BEGIN
  SELECT RAISE(ABORT, 'invalid user color');
END;
