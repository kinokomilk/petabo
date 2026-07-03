// LINE 設定の読み取りヘルパー（Phase 2 基盤）。
// mock-first: Secrets 未設定でも動く形にし、login / webhook / cron が
// 「LINE 未設定」を明確に判定できるようにする。
// 秘密値そのものはここから返さない・ログに出さない（boolean の有無判定のみ公開）。
import type { Env } from "../env";

// Messaging API（webhook 署名検証・push）に必要な設定一式。
export interface LineMessagingConfig {
  channelSecret: string;
  channelAccessToken: string;
}

// LINE Login（OAuth / OIDC）に必要な設定一式。
export interface LineLoginConfig {
  channelId: string;
  channelSecret: string;
  appBaseUrl: string;
}

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

// Messaging API が利用可能か（webhook / push）。
export function isLineMessagingConfigured(env: Env): boolean {
  return nonEmpty(env.LINE_CHANNEL_SECRET) && nonEmpty(env.LINE_CHANNEL_ACCESS_TOKEN);
}

// LINE Login（OAuth）が利用可能か。
export function isLineLoginConfigured(env: Env): boolean {
  return (
    nonEmpty(env.LINE_LOGIN_CHANNEL_ID) &&
    nonEmpty(env.LINE_LOGIN_CHANNEL_SECRET) &&
    nonEmpty(env.APP_BASE_URL)
  );
}

// Messaging 設定を取得。未設定なら null（呼び出し側で skip / 503 等に分岐）。
export function getLineMessagingConfig(env: Env): LineMessagingConfig | null {
  if (!isLineMessagingConfigured(env)) return null;
  return {
    channelSecret: env.LINE_CHANNEL_SECRET as string,
    channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN as string,
  };
}

// Login 設定を取得。未設定なら null。
export function getLineLoginConfig(env: Env): LineLoginConfig | null {
  if (!isLineLoginConfigured(env)) return null;
  return {
    channelId: env.LINE_LOGIN_CHANNEL_ID as string,
    channelSecret: env.LINE_LOGIN_CHANNEL_SECRET as string,
    appBaseUrl: (env.APP_BASE_URL as string).replace(/\/+$/, ""),
  };
}

// LIFF（Phase 3）。LIFF_ID は「公開設定」として扱える＝フロントに渡してよい。
// channel secret / access token は LIFF/フロントへ渡さない（ここからも返さない）。
export function isLiffConfigured(env: Env): boolean {
  return nonEmpty(env.LIFF_ID);
}

// フロントへ返してよい公開 LIFF 設定。未設定なら liffId=null。
// 秘密値は含めない（ここに channel secret / access token を足さないこと）。
export function getLiffConfig(env: Env): { liffId: string | null } {
  return { liffId: isLiffConfigured(env) ? (env.LIFF_ID as string) : null };
}
