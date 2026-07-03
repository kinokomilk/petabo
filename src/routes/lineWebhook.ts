// LINE Messaging API Webhook。POST /api/line/webhook。
// 最重要: 生ボディで署名検証 → 検証後に JSON parse。検証前に副作用を起こさない。
// 素早く 200 を返し、重い処理は executionCtx.waitUntil() に逃がす。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { getLineMessagingConfig } from "../line/config";
import { verifyLineSignature } from "../line/signature";
import { setLineFollowed } from "../db/households";
import { createLineReply, type LineReply } from "../line/api";
import {
  processEvent,
  type IncomingMessageEvent,
  type IncomingPostbackEvent,
} from "../line/commands";

// LINE webhook イベント（follow/unfollow + message/postback の最小フィールド）。
interface LineWebhookEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
}
interface LineWebhookBody {
  destination?: string;
  events?: LineWebhookEvent[];
}

// follow / unfollow を DB に反映 + message / postback をコマンド処理する。
// reply は LineReply ラッパ経由（テストでは差し替え）。appBaseUrl は Web 誘導用。
async function applyEvents(
  db: D1Database,
  events: LineWebhookEvent[],
  reply: LineReply,
  appBaseUrl: string | null,
): Promise<void> {
  for (const ev of events) {
    const userId = ev.source?.userId;
    if (!userId) continue;
    if (ev.type === "follow") {
      await setLineFollowed(db, userId, true);
    } else if (ev.type === "unfollow") {
      await setLineFollowed(db, userId, false);
    } else if (ev.type === "message") {
      await processEvent(
        { db, reply, appBaseUrl },
        ev as IncomingMessageEvent,
      );
    } else if (ev.type === "postback") {
      await processEvent(
        { db, reply, appBaseUrl },
        ev as IncomingPostbackEvent,
      );
    }
    // 未知イベントは無視。
  }
}

// reply ラッパの生成口（テストで mock 実装に差し替えられるようにする）。
// 本番は createLineReply（global fetch）を使う。秘密値はここから漏らさない。
let replyFactory: (channelAccessToken: string) => LineReply = createLineReply;

// テスト専用: reply ラッパを差し替える。返り値で元へ戻せる。
export function __setReplyFactoryForTest(
  factory: (channelAccessToken: string) => LineReply,
): () => void {
  const prev = replyFactory;
  replyFactory = factory;
  return () => {
    replyFactory = prev;
  };
}

export const lineWebhookRoutes = new Hono<HonoEnv>();

lineWebhookRoutes.post("/line/webhook", async (c) => {
  const cfg = getLineMessagingConfig(c.env);
  // channel secret 無し → 署名検証不能。検証できないものは受け付けない。
  if (!cfg) {
    return c.json({ error: "LINE Messaging は未設定です" }, 503);
  }

  // 1) 生ボディ取得（c.req.json() を先に呼ばない）。
  const raw = await c.req.text();
  const signature = c.req.header("x-line-signature");

  // 2) 署名検証（通るまで parse / DB / userId / ログを触らない）。
  const ok = await verifyLineSignature(cfg.channelSecret, raw, signature);
  if (!ok) {
    // 署名なし/不一致は副作用ゼロで拒否。
    return c.json({ error: "invalid signature" }, 401);
  }

  // 3) 検証通過後に parse。壊れた JSON は 400（署名は通っているので副作用なしで返す）。
  let body: LineWebhookBody | null;
  try {
    body = JSON.parse(raw) as LineWebhookBody;
  } catch {
    return c.json({ error: "invalid body" }, 400);
  }
  const events = Array.isArray(body?.events) ? body.events : [];

  // 4) 素早く 200。DB 反映 / reply は waitUntil に逃がす（replyToken は約1分有効）。
  if (events.length > 0) {
    const reply = replyFactory(cfg.channelAccessToken);
    const appBaseUrl = c.env.APP_BASE_URL
      ? c.env.APP_BASE_URL.replace(/\/+$/, "")
      : null;
    const work = applyEvents(c.env.DB, events, reply, appBaseUrl);
    // executionCtx は提供されない実行（テスト等）でアクセスすると throw するため try で守る。
    let scheduled = false;
    try {
      c.executionCtx.waitUntil(work);
      scheduled = true;
    } catch {
      scheduled = false;
    }
    if (!scheduled) {
      // executionCtx が無い場合は同期的に完了させる（副作用を取りこぼさない）。
      await work;
    }
  }

  return c.json({ ok: true });
});
