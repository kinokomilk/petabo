import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig(async () => {
  // マイグレーションは Node コンテキスト(設定時)で読み、テストへバインディング経由で渡す。
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./src/db/migrations", import.meta.url)),
  );

  return {
    plugins: [
      // vitest 4 / pool-workers 0.16 では pool 設定は cloudflareTest プラグインに渡す
      // （旧 test.poolOptions.workers 相当）。
      cloudflareTest({
        // 全ファイルを単一ランタイム・共有 D1（singleWorker）で走らせる。smoke は
        // 前段に依存する逐次シナリオなので per-test rollback も切る。ファイル間の
        // household 衝突は apply-migrations.ts が各ファイル開始時に全テーブルを
        // クリアして順序非依存にすることで防ぐ。
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: { DB: "petabo-test" },
          // テストワーカーから参照できるよう設定値として注入。
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      // Playwright の E2E（e2e/*.spec.ts）は vitest 対象外。
      exclude: [...configDefaults.exclude, "e2e/**"],
    },
  };
});
