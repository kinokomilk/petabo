import { defineConfig, devices } from "@playwright/test";

// E2E はローカルの Worker（wrangler dev が web/dist を配信）に対して実行する。
// webServer がマイグレーション適用→DB クリア→ビルド→dev 起動を順に行う（npm run e2e:server）。
// 単一スペース制約（register は household が空のときのみ）に合わせ、起動時に DB を空にする。
const PORT = 8799;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // 単一 D1・逐次シナリオ
  // フルスイート実行時のローカル dev サーバ負荷による一過性タイミングフレークを
  // 吸収する（各テストは単体では安定。真に壊れたテストは毎回落ちて顕在化する）。
  // 負荷時は応答が遅くなるため expect/timeout も余裕を持たせる。
  retries: 2,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // 先にオーナー登録してセッション(Cookie)を storageState に保存する。
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Pixel 5"] },
    },
    // 本体テストは保存済みセッションで（モバイル・chromium）。
    {
      name: "e2e",
      testMatch: /.*\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Pixel 5"],
        storageState: "e2e/.auth/owner.json",
      },
    },
  ],
  webServer: {
    command: "npm run e2e:server",
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
