// GET /api/users — 同 household のアクティブメンバー一覧（担当選択用）。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { requireAuth, authCtx } from "../auth/middleware";
import { listActiveMembers } from "../db/households";
import { toUserDTO } from "../db/util";

export const userRoutes = new Hono<HonoEnv>();

userRoutes.get("/users", requireAuth, async (c) => {
  const { household } = authCtx(c);
  const members = await listActiveMembers(c.env.DB, household.id);
  return c.json(members.map(toUserDTO));
});
