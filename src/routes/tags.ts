// GET/POST/DELETE /api/tags — household スコープのカテゴリ。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import type { CreateTagBody, TagDTO, TagRow } from "../types";
import { requireAuth, authCtx } from "../auth/middleware";
import { listTags, createTag, getTag, getTagByName, deleteTag } from "../db/tags";

export const tagRoutes = new Hono<HonoEnv>();
const MAX_TAG_NAME_LENGTH = 40;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function toTagDTO(t: TagRow): TagDTO {
  return { id: t.id, name: t.name, color: t.color };
}

tagRoutes.get("/tags", requireAuth, async (c) => {
  const { household } = authCtx(c);
  const tags = await listTags(c.env.DB, household.id);
  return c.json(tags.map(toTagDTO));
});

tagRoutes.post("/tags", requireAuth, async (c) => {
  const { household } = authCtx(c);
  const body = (await c.req.json().catch(() => null)) as CreateTagBody | null;
  if (!body || typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name は必須です" }, 400);
  }
  const name = body.name.trim();
  if (name.length > MAX_TAG_NAME_LENGTH) {
    return c.json({ error: "name が長すぎます" }, 400);
  }
  if (body.color !== undefined && !HEX_COLOR.test(body.color.trim())) {
    return c.json({ error: "color が不正です" }, 400);
  }
  // 同名タグの存在を事前に確認して 409 を返す（UNIQUE(household_id, name) 違反のみ）。
  // それ以外の DB エラーは catch で握り潰さず 500 として伝播させる。
  const existing = await getTagByName(c.env.DB, household.id, name);
  if (existing) {
    return c.json({ error: "同名のタグが既に存在します" }, 409);
  }
  const tag = await createTag(c.env.DB, household.id, name, body.color);
  return c.json(toTagDTO(tag), 201);
});

tagRoutes.delete("/tags/:id", requireAuth, async (c) => {
  const { household } = authCtx(c);
  const id = c.req.param("id");
  const tag = await getTag(c.env.DB, household.id, id);
  if (!tag) return c.json({ error: "not_found" }, 404);
  await deleteTag(c.env.DB, household.id, id);
  return c.json({ ok: true });
});
