// Worker のバインディング/環境変数とリクエストごとの ctx 変数の型。
import type { UserRow, HouseholdRow, MembershipRow } from "./types";

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  // Phase 2 以降（LINE）。mock-first: 未設定でも型は通る（すべて optional）。
  // 名称は docs/LINE_SETUP.md / docs/PHASE2_PRECHECK.md の正に統一する。
  // Messaging API（webhook 署名検証 / push）。
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  // LINE Login（OAuth / OIDC）。
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  // コールバック / 絶対 URL 生成の基底。
  APP_BASE_URL?: string;
  // Phase 3（LIFF）。
  LIFF_ID?: string;
}

// 認証ミドルウェアが ctx にセットする値。
export interface AuthVars {
  user: UserRow;
  household: HouseholdRow;
  membership: MembershipRow;
}

// Hono の型引数で使う Bindings/Variables。
export interface HonoEnv {
  Bindings: Env;
  Variables: Partial<AuthVars>;
}
