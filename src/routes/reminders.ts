// GET /api/todos/reminders — overdue / due_soon(24h)。private は creator のみ。
// 注意: /todos/:id より前にマウントすること（:id に "reminders" を食わせない）。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import type { RemindersDTO } from "../types";
import { requireAuth, authCtx } from "../auth/middleware";
import { listReminderRows, hydrateTodos } from "../db/todos";

export const reminderRoutes = new Hono<HonoEnv>();

reminderRoutes.get("/todos/reminders", requireAuth, async (c) => {
  const { household, user } = authCtx(c);
  const { overdue, dueSoon } = await listReminderRows(c.env.DB, household.id, user.id);
  const result: RemindersDTO = {
    overdue: await hydrateTodos(c.env.DB, overdue),
    dueSoon: await hydrateTodos(c.env.DB, dueSoon),
  };
  return c.json(result);
});
