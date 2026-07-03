import { test, expect } from "@playwright/test";

// コメントの追加・表示（TESTING §1 コメント）を UI フローで検証する。
// クイック追加で作ったタスクをタップ→詳細でコメントを投稿→一覧に反映されることを見る。
// a-visual.spec.ts（空状態スナップショット）より後に実行されるよう c- 始まりのファイル名にしている。
test("タスク詳細でコメントを投稿すると一覧に表示される", async ({ page }) => {
  await page.goto("/");
  const title = `コメント対象 ${Date.now()}`;
  const input = page.getByLabel("やることを追加");
  await input.fill(title);
  await input.press("Enter");
  await expect(page.getByText(title)).toBeVisible();

  // タスク行をタップして詳細へ。
  await page.locator(".task-row", { hasText: title }).locator(".task-main").click();
  const titleInput = page.getByRole("textbox", { name: "タスク名" });
  await expect(titleInput).toHaveValue(title);

  const renamed = `${title} 更新`;
  await titleInput.fill(renamed);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes("/api/todos/") &&
        response.request().method() === "PATCH" &&
        response.ok()
    ),
    titleInput.press("Enter"),
  ]);
  await expect(titleInput).toHaveValue(renamed);

  await page.reload();
  await expect(page.getByRole("textbox", { name: "タスク名" })).toHaveValue(renamed);
  await expect(page.getByRole("button", { name: "タスク一覧へ戻る" })).toBeVisible();

  const visibilityBox = await page
    .locator(".detail-block", { hasText: "公開範囲" })
    .boundingBox();
  const assigneeBox = await page.locator(".detail-block", { hasText: "担当" }).boundingBox();
  expect(visibilityBox).not.toBeNull();
  expect(assigneeBox).not.toBeNull();
  if (visibilityBox && assigneeBox) {
    expect(visibilityBox.y).toBeLessThan(assigneeBox.y);
  }

  const dateFieldBox = await page.locator(".detail-date-field").boundingBox();
  const dateBox = await page.locator(".detail-date-input").boundingBox();
  expect(dateFieldBox).not.toBeNull();
  expect(dateBox).not.toBeNull();
  if (dateFieldBox && dateBox) {
    expect(dateBox.x).toBeGreaterThanOrEqual(0);
    expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(dateBox.x).toBeGreaterThanOrEqual(dateFieldBox.x);
    expect(dateBox.x + dateBox.width).toBeLessThanOrEqual(
      dateFieldBox.x + dateFieldBox.width
    );
  }

  // 初期は「まだコメントはありません。」。
  await expect(page.getByText("まだコメントはありません。")).toBeVisible();

  // コメントを投稿。
  const body = `卵は10個入りで ${Date.now()}`;
  const compose = page.getByPlaceholder("コメントを書く…");
  await compose.fill(body);
  await page.getByRole("button", { name: "送信" }).click();

  // 一覧に反映され、空状態メッセージが消える。
  await expect(page.getByText(body)).toBeVisible();
  await expect(page.getByText("まだコメントはありません。")).toHaveCount(0);

  const detailBody = await page.locator(".detail-body").boundingBox();
  const lastBlock = await page.locator(".detail-block").last().boundingBox();
  expect(detailBody).not.toBeNull();
  expect(lastBlock).not.toBeNull();
  if (detailBody && lastBlock) {
    expect(detailBody.y + detailBody.height - (lastBlock.y + lastBlock.height)).toBeLessThanOrEqual(
      13
    );
  }

  await page.getByRole("button", { name: "タスク一覧へ戻る" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(renamed)).toBeVisible();
});
