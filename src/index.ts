// petabo Worker エントリ。/api/* は REST、それ以外は静的アセット(SPA フォールバック)。
import { Hono } from "hono";
import type { HonoEnv } from "./env";
import { authRoutes } from "./routes/auth";
import { requireSameOriginMutation } from "./auth/middleware";
import { inviteRoutes } from "./routes/invites";
import { userRoutes } from "./routes/users";
import { tagRoutes } from "./routes/tags";
import { reminderRoutes } from "./routes/reminders";
import { todoRoutes } from "./routes/todos";
import { lineAuthRoutes } from "./routes/lineAuth";
import { lineWebhookRoutes } from "./routes/lineWebhook";
import { lineRichMenuRoutes } from "./routes/lineRichMenu";
import { liffRoutes } from "./routes/liff";
import type { Env } from "./env";
import { getLineMessagingConfig } from "./line/config";
import { createLinePush } from "./line/api";
import { runReminders } from "./line/reminder";
import { purgeExpiredLineLoginStates } from "./db/lineLoginStates";

const app = new Hono<HonoEnv>();

// LINE webhook は LINE からの外部 POST。同一オリジン CSRF 防御の対象外にする
// （署名検証で守る）。CSRF ミドルウェアを通さないよう api より前に登録する。
app.route("/api", lineWebhookRoutes); // /api/line/webhook

// LIFF: /api/liff/config（公開 GET）と POST /api/auth/liff。
// 後者は LINE 内 WebView からクロスオリジンで呼ばれうるため、同一オリジン CSRF
// ミドルウェア（requireSameOriginMutation）の対象外にする＝ webhook 同様 api より前に
// 登録する。Cookie ではなく id_token 提示でユーザーを確定するので CSRF 影響は無い。
app.route("/api", liffRoutes); // /api/liff/config, /api/auth/liff

// API ルート。
const api = new Hono<HonoEnv>();
api.use("*", requireSameOriginMutation);
api.get("/health", (c) => c.json({ ok: true }));
api.route("/", authRoutes); // /auth/*, /join/:token
api.route("/", lineAuthRoutes); // /auth/line/start, /auth/line/callback
api.route("/", lineRichMenuRoutes); // /line/richmenu/setup（owner）, DELETE /line/richmenu
api.route("/", inviteRoutes); // /invites*, /members/:userId
api.route("/", userRoutes); // /users
api.route("/", tagRoutes); // /tags*
api.route("/", reminderRoutes); // /todos/reminders  ← /todos/:id より前
api.route("/", todoRoutes); // /todos*, /items/:id

app.route("/api", api);

// 未知の /api/* は JSON 404（SPA フォールバックに流さない）。
app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

// それ以外は静的アセット（web/dist）を配信。assets バインディングが
// not_found_handling=single-page-application なので index.html にフォールバックする。
// ローカルで web 未ビルド/未バインドの場合は簡易メッセージを返す。
app.get("*", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("petabo worker is running. (web/dist not built yet)", 200);
});

// Cron Trigger（wrangler.toml の crons）から呼ばれるリマインダー実行。
// LINE Messaging 未設定（mock-first）なら何もしない。実機時刻で runReminders を呼ぶ。
// 重い DB/push 処理は waitUntil に逃がし、ハンドラ自体は素早く返す。
async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // M5: 期限切れ LINE ログイン state の掃除は DB のみで完結するため、
  // LINE 未設定でも実行する（push とは独立、waitUntil で素早く返す）。
  ctx.waitUntil(purgeExpiredLineLoginStates(env.DB));

  const cfg = getLineMessagingConfig(env);
  if (!cfg) {
    // LINE 未設定なら push できない。skip（無料枠・例外を避ける）。
    return;
  }
  const push = createLinePush(cfg.channelAccessToken);
  ctx.waitUntil(
    runReminders(env.DB, push, new Date()).then(() => undefined),
  );
}

// fetch（Hono アプリ）と scheduled（Cron）を同一 Worker から export する。
// テスト（test/*.ts）は `app.request(...)` を使うため Hono インスタンスを既定
// export のまま保ち、Workers の Cron 入口になる `scheduled` を同じオブジェクトへ
// 付与する。Hono の `fetch` は既に実装済みなので fetch ハンドラはそのまま使える。
const worker = app as typeof app & {
  scheduled: typeof scheduled;
};
worker.scheduled = scheduled;

export default worker;
