import { test, expect } from "@playwright/test";
import fs from "node:fs";

// ホームのクイック追加・取り消し（Undo）・「重要だけ」フィルタ（#3/#4）。
test("クイック追加→今日に表示され、取り消し（Undo）トーストが出る", async ({ page }) => {
  await page.goto("/");
  const title = `牛乳を買う ${Date.now()}`;
  const input = page.getByLabel("やることを追加");
  await input.fill(title);
  await input.press("Enter");

  // 一覧に追加され、取り消し導線が出る。
  await expect(page.getByText(title)).toBeVisible();
  await expect(page.locator(".undo-toast")).toBeVisible();
  await expect(page.getByText("追加しました")).toBeVisible();

  // スクリーンショット（モバイル・モック目視比較用の artifact）。
  fs.mkdirSync("e2e/artifacts", { recursive: true });
  await page.screenshot({ path: "e2e/artifacts/home.png", fullPage: true });
});

test("クイック追加の「取り消し」で直前のタスクが消える", async ({ page }) => {
  await page.goto("/");
  const title = `まちがい追加 ${Date.now()}`;
  const input = page.getByLabel("やることを追加");
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByText(title)).toBeVisible();

  await page.getByRole("button", { name: "いま追加したタスクを取り消す" }).click();
  await expect(page.getByText(title)).toHaveCount(0);
});

test("★重要フィルタはスター付きタスクだけを表示する", async ({ page }) => {
  await page.goto("/");
  const star = `重要タスク ${Date.now()}`;
  const plain = `ふつうタスク ${Date.now()}`;
  const input = page.getByLabel("やることを追加");
  await input.fill(star);
  await input.press("Enter");
  await expect(page.getByText(star)).toBeVisible();
  await input.fill(plain);
  await input.press("Enter");
  await expect(page.getByText(plain)).toBeVisible();

  // star 行にスターを付ける。
  await page
    .locator(".task-row", { hasText: star })
    .getByRole("button", { name: "重要にする" })
    .click();

  // 「重要だけ」フィルタ ON。
  await page
    .getByRole("button", { name: "重要（スター）のタスクだけに絞り込む" })
    .click();

  await expect(page.getByText(star)).toBeVisible();
  await expect(page.getByText(plain)).toHaveCount(0);
});

test("期限切れが複数あるときのバナーは特定タスクではなく一覧へ誘導する", async ({
  page,
}) => {
  await page.goto("/");
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  await page.evaluate(async (dueDate) => {
    await fetch("/api/todos", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `期限切れA ${Date.now()}`, dueDate }),
    });
    await fetch("/api/todos", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `期限切れB ${Date.now()}`, dueDate }),
    });
  }, past);

  await page.reload();
  const overdueBanner = page.locator(".reminder.overdue");
  await expect(overdueBanner).toContainText("期限切れが");
  await expect(overdueBanner.getByRole("link", { name: "一覧" })).toHaveAttribute(
    "href",
    "/"
  );
  await overdueBanner.getByRole("link", { name: "一覧" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("ホームでチェックリスト項目を表示して完了できる", async ({ page }) => {
  await page.goto("/");
  const suffix = Date.now();
  const title = `旅行の準備 ${suffix}`;
  const item = `充電器 ${suffix}`;
  await page.evaluate(
    async ({ title, item }) => {
      await fetch("/api/todos", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, isChecklist: true, items: [item, "着替え"] }),
      });
    },
    { title, item }
  );
  await page.reload();

  const entry = page.locator(".task-entry", { hasText: title });
  await expect(entry.getByText(item)).toBeVisible();
  await entry.getByRole("button", { name: `${item} を完了にする` }).click();
  await expect(entry.getByRole("button", { name: `${item} を未完了にする` })).toBeVisible();
  await expect(entry).toContainText("チェックリスト 1/2");

  await entry.getByRole("button", { name: "着替え を完了にする" }).click();
  await expect(entry).toHaveCount(0);
  await page.getByRole("button", { name: "完了", exact: true }).click();
  await expect(page.locator(".task-entry", { hasText: title })).toBeVisible();
});

test("追加・公開範囲・一覧フィルターが用途ごとに整理されている", async ({ page }) => {
  await page.goto("/");
  const quickAdd = await page.locator(".quick-add").boundingBox();
  const filters = await page.locator(".home-filters").boundingBox();
  const list = await page.locator(".home-list").boundingBox();
  expect(quickAdd).not.toBeNull();
  expect(filters).not.toBeNull();
  if (quickAdd && filters) expect(quickAdd.y).toBeLessThan(filters.y);
  if (filters && list) expect(filters.y).toBeLessThan(list.y);

  const inputArea = await page.locator(".qa-bar").boundingBox();
  const attributes = await page.locator(".qa-controls").boundingBox();
  expect(inputArea).not.toBeNull();
  expect(attributes).not.toBeNull();
  if (quickAdd && inputArea && attributes) {
    expect(inputArea.x).toBeGreaterThanOrEqual(quickAdd.x);
    expect(inputArea.y).toBeGreaterThanOrEqual(quickAdd.y);
    expect(attributes.x).toBeGreaterThanOrEqual(quickAdd.x);
    expect(attributes.y + attributes.height).toBeLessThanOrEqual(
      quickAdd.y + quickAdd.height + 1
    );
  }

  await expect(page.getByText("担当", { exact: true })).toBeVisible();
  await expect(page.getByText("公開範囲", { exact: true })).toBeVisible();

  const scope = await page.locator(".qa-scope-row").boundingBox();
  const category = await page.locator(".qa-category").boundingBox();
  expect(scope).not.toBeNull();
  expect(category).not.toBeNull();
  if (scope && category) expect(scope.y).toBeLessThan(category.y);

  await page.getByRole("button", { name: "じぶん", exact: true }).click();
  await expect(page.getByText("あなただけに見えます")).toBeVisible();

  const footer = await page.locator(".bottom-nav").boundingBox();
  const addButton = await page.locator(".nav-add").boundingBox();
  expect(footer).not.toBeNull();
  expect(addButton).not.toBeNull();
  if (footer && addButton) {
    const footerCenter = footer.x + footer.width / 2;
    const buttonCenter = addButton.x + addButton.width / 2;
    expect(Math.abs(footerCenter - buttonCenter)).toBeLessThanOrEqual(1);
  }
});

test("設定でカテゴリを追加し、クイック追加から選択できる", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.locator(".tag-color")).toHaveCount(10);
  const name = `学校 ${Date.now()}`;
  await page.getByRole("textbox", { name: "新しいカテゴリ名" }).fill(name);
  await page.getByRole("button", { name: "追加", exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
  await page.screenshot({ path: "e2e/artifacts/settings-categories.png", fullPage: true });

  await page.getByRole("button", { name: "トップへ戻る" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("combobox", { name: "カテゴリ" }).selectOption({ label: name });
  await expect(page.getByRole("combobox", { name: "カテゴリ" })).toHaveValue(/.+/);
});
