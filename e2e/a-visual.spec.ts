import { test, expect } from "@playwright/test";

// 視覚回帰：空状態のホームをスナップショットと比較する。
// ファイル名を a- で始めて setup 直後（タスク投入前＝空状態が確定）に実行する。
// フォント描画の僅差は maxDiffPixelRatio で許容。ベースラインは環境依存のため、
// 環境やデザインを変えたら `npm run e2e -- --update-snapshots` で再生成する。
test("ホーム（空状態）が petabo のデザインで表示される", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand-logo")).toHaveText("petabo");
  await expect(page.getByText("まだ何もありません")).toBeVisible();
  // Web フォントの読込完了を待ってから撮影（フォールバックとの差を避ける）。
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot("home-empty.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.02,
  });
});
