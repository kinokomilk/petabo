// vitest-pool-workers の `cloudflare:test` モジュール型を読み込む。
// 0.16 以降、型は /types サブパスから提供される。
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "cloudflare:test";
import type { Env as AppEnv } from "../src/env";

// 0.16 以降、`cloudflare:test` の `env` は global な `Cloudflare.Env` 型。
// アプリの Env バインディングに加え、テスト用に注入する TEST_MIGRATIONS を合成する。
declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
