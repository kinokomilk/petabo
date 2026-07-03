import { test, expect } from "@playwright/test";

// チェックリスト作成→Enter 連続追加→チェックで進捗が進む（消し込み）。
test("チェックリストを作成し、項目をEnterで追加してチェックできる", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "チェックリスト" }).click();
  const title = `買い物リスト ${Date.now()}`;
  await page.getByLabel("タイトル").fill(title);
  await page.getByRole("button", { name: "作成して項目を追加" }).click();

  // チェックリスト詳細へ。
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  const itemInput = page.getByLabel("品目を追加");
  // 各項目が追加されたのを確認してから次を足す（実ユーザーの操作に合わせる）。
  await itemInput.fill("牛乳");
  await itemInput.press("Enter");
  await expect(page.getByText("牛乳")).toBeVisible();
  await itemInput.fill("卵");
  await itemInput.press("Enter");
  await expect(page.getByText("卵")).toBeVisible();

  await expect(page.getByText("0 / 2")).toBeVisible();

  // 牛乳をチェック→進捗 1/2。
  await page.getByRole("button", { name: "牛乳 を切替" }).click();
  await expect(page.getByText("1 / 2")).toBeVisible();
});

test("新規チェックリストは複数項目をまとめて登録できる", async ({ page }) => {
  await page.goto("/new");
  await page.getByRole("button", { name: "チェックリスト" }).click();
  const title = `まとめ買い ${Date.now()}`;
  await page.getByLabel("タイトル").fill(title);
  await page.getByLabel("タイトル").press("Enter");
  await expect(page.getByLabel("チェック項目")).toBeFocused();

  await page.getByLabel("チェック項目").fill("牛乳\n卵\nパン");
  await page.getByRole("button", { name: "作成して項目を追加" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("牛乳")).toBeVisible();
  await expect(page.getByText("卵")).toBeVisible();
  await expect(page.getByText("パン")).toBeVisible();
  await expect(page.getByText("0 / 3")).toBeVisible();
});

// #1 通常タスク→チェックリスト化（詳細の「チェックリストにする」）。
test("通常タスクを後からチェックリスト化できる", async ({ page }) => {
  await page.goto("/new");
  const title = `あとで分割 ${Date.now()}`;
  await page.getByLabel("タイトル").fill(title);
  await page.getByRole("button", { name: "保存して開く" }).click();

  // タスク詳細。
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: "チェックリストにする" }).click();

  // チェックリストの項目追加欄が出る。
  await expect(page.getByLabel("品目を追加")).toBeVisible();
});
