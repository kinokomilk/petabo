import { test, expect } from "@playwright/test";

// 絞り込みタブの切替：完了タスクは「完了」タブにのみ出る（アーカイブ挙動）。
test("完了タスクは一覧から外れ「完了」タブに出る", async ({ page }) => {
  await page.goto("/");
  const title = `タブ完了 ${Date.now()}`;
  const input = page.getByLabel("やることを追加");
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByText(title)).toBeVisible();

  // 完了にする → 今日タブから消える。
  await page
    .locator(".task-row", { hasText: title })
    .getByRole("button", { name: /を完了にする/ })
    .click();
  await expect(page.getByText(title)).toHaveCount(0);

  // 「完了」タブに出る（exact で「…を完了にする」チェックボックスと区別）。
  await page.getByRole("button", { name: "完了", exact: true }).click();
  await expect(page.getByText(title)).toBeVisible();
});

// 「じぶんだけ」フィルタは非公開（private）タスクだけを表示する。
test("じぶんだけフィルタは非公開タスクのみ表示する", async ({ page }) => {
  await page.goto("/");
  const input = page.getByLabel("やることを追加");

  const shared = `共有フィルタ ${Date.now()}`;
  await input.fill(shared);
  await input.press("Enter");
  await expect(page.getByText(shared)).toBeVisible();

  // 公開範囲を「じぶん」に切替えて非公開タスクを追加。
  await page.getByRole("button", { name: "じぶん", exact: true }).click();
  const priv = `じぶんフィルタ ${Date.now()}`;
  await input.fill(priv);
  await input.press("Enter");
  await expect(page.getByText(priv)).toBeVisible();

  // 「じぶんだけ」ON → 非公開のみ。
  await page
    .getByRole("button", { name: "じぶんだけのタスクに絞り込む" })
    .click();
  await expect(page.getByText(priv)).toBeVisible();
  await expect(page.getByText(shared)).toHaveCount(0);
});
