// tags リポジトリ（household スコープ）。
import type { TagRow } from "../types";
import { nowIso } from "./util";
import { uuid } from "../auth/crypto";

// 初期タグと色（SPEC §10-6 / petabo-ui 配色準拠）。
const INITIAL_TAGS: { name: string; color: string }[] = [
  { name: "家事", color: "#FF7A4D" },
  { name: "買い物", color: "#4C8DF6" },
  { name: "育児", color: "#3AA675" },
  { name: "手続き", color: "#9B7EDE" },
  { name: "お出かけ", color: "#E86FA0" },
];

const DEFAULT_TAG_COLOR = "#4C8DF6";

export async function seedInitialTags(
  db: D1Database,
  householdId: string,
): Promise<void> {
  const createdAt = nowIso();
  const stmt = db.prepare(
    "INSERT INTO tags (id, household_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const batch = INITIAL_TAGS.map((t) =>
    stmt.bind(uuid(), householdId, t.name, t.color, createdAt),
  );
  await db.batch(batch);
}

export async function listTags(
  db: D1Database,
  householdId: string,
): Promise<TagRow[]> {
  const res = await db
    .prepare(
      "SELECT * FROM tags WHERE household_id = ? ORDER BY created_at ASC",
    )
    .bind(householdId)
    .all<TagRow>();
  return res.results ?? [];
}

export async function createTag(
  db: D1Database,
  householdId: string,
  name: string,
  color: string | undefined,
): Promise<TagRow> {
  const id = uuid();
  const createdAt = nowIso();
  const c = color && color.trim() ? color.trim() : DEFAULT_TAG_COLOR;
  await db
    .prepare(
      "INSERT INTO tags (id, household_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, householdId, name, c, createdAt)
    .run();
  return { id, household_id: householdId, name, color: c, created_at: createdAt };
}

// 同 household 内で同名タグを引く（作成前の重複チェックに使う）。
export async function getTagByName(
  db: D1Database,
  householdId: string,
  name: string,
): Promise<TagRow | null> {
  return db
    .prepare("SELECT * FROM tags WHERE household_id = ? AND name = ?")
    .bind(householdId, name)
    .first<TagRow>();
}

export async function getTag(
  db: D1Database,
  householdId: string,
  id: string,
): Promise<TagRow | null> {
  return db
    .prepare("SELECT * FROM tags WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .first<TagRow>();
}

export async function deleteTag(
  db: D1Database,
  householdId: string,
  id: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM tags WHERE id = ? AND household_id = ?")
    .bind(id, householdId)
    .run();
}
