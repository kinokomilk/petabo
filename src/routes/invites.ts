// 招待トークンとメンバー管理。発行/失効/メンバー削除はオーナー限定。検証は公開。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import type { InviteDTO } from "../types";
import { generateToken } from "../auth/crypto";
import { requireAuth, requireOwner, authCtx } from "../auth/middleware";
import {
  createInvite,
  getInvite,
  deleteInvite,
  isInviteValid,
  removeMember,
  getMembership,
} from "../db/households";
import { deleteSessionsForUser } from "../db/sessions";

export const inviteRoutes = new Hono<HonoEnv>();

// 招待リンクの有効期限（既定14日）。
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function toInviteDTO(row: {
  token: string;
  household_id: string;
  expires_at: string | null;
  created_at: string;
}): InviteDTO {
  return {
    token: row.token,
    householdId: row.household_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    joinPath: `/join/${row.token}`,
  };
}

// 公開：招待トークンの検証（フロントが /join/<token> 画面で使う）。
inviteRoutes.get("/invites/:token", async (c) => {
  const token = c.req.param("token");
  const invite = await getInvite(c.env.DB, token);
  if (!isInviteValid(invite)) {
    return c.json({ valid: false }, 404);
  }
  return c.json({ valid: true, invite: toInviteDTO(invite) });
});

// オーナー：招待発行。
inviteRoutes.post("/invites", requireAuth, requireOwner, async (c) => {
  const { household, user } = authCtx(c);
  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const row = await createInvite(c.env.DB, token, household.id, user.id, expiresAt);
  return c.json(toInviteDTO(row), 201);
});

// オーナー：招待失効。
inviteRoutes.delete("/invites/:token", requireAuth, requireOwner, async (c) => {
  const { household } = authCtx(c);
  const token = c.req.param("token");
  const invite = await getInvite(c.env.DB, token);
  if (!invite || invite.household_id !== household.id) {
    return c.json({ error: "not_found" }, 404);
  }
  await deleteInvite(c.env.DB, token);
  return c.json({ ok: true });
});

// オーナー：メンバー削除（status='removed'）。自分自身は削除不可。
inviteRoutes.delete("/members/:userId", requireAuth, requireOwner, async (c) => {
  const { household, user } = authCtx(c);
  const targetId = c.req.param("userId");
  if (targetId === user.id) {
    return c.json({ error: "オーナー自身は削除できません" }, 400);
  }
  const membership = await getMembership(c.env.DB, household.id, targetId);
  if (!membership || membership.status !== "active") {
    return c.json({ error: "not_found" }, 404);
  }
  await removeMember(c.env.DB, household.id, targetId);
  // membership を removed にするだけでなく、対象のセッションも即時破棄する
  // （削除直後も Cookie が有効なままにならないように）。
  await deleteSessionsForUser(c.env.DB, targetId);
  return c.json({ ok: true });
});
