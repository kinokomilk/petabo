import { test, expect } from "@playwright/test";
import fs from "node:fs";

// 「保存して続けて追加」：担当・期限・カテゴリ・公開範囲を保持したまま連続作成できる。
test("保存して続けて追加で担当/期限/カテゴリが保持され、複数作成できる", async ({
  page,
}) => {
  await page.goto("/new");

  const dateField = await page.locator(".nt-date-field").boundingBox();
  const dateInput = await page.getByLabel("期限").boundingBox();
  expect(dateField).not.toBeNull();
  expect(dateInput).not.toBeNull();
  if (dateField && dateInput) {
    expect(dateInput.x).toBeGreaterThanOrEqual(dateField.x);
    expect(dateInput.x + dateInput.width).toBeLessThanOrEqual(
      dateField.x + dateField.width
    );
    expect(dateInput.x + dateInput.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }

  const bodyBox = await page.locator(".newtodo-body").boundingBox();
  const actionsBox = await page.locator(".newtodo-actions").boundingBox();
  expect(bodyBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  if (bodyBox && actionsBox) {
    expect(bodyBox.y + bodyBox.height - (actionsBox.y + actionsBox.height)).toBeLessThanOrEqual(1);
  }
  fs.mkdirSync("e2e/artifacts", { recursive: true });
  await page.screenshot({ path: "e2e/artifacts/newtodo.png", fullPage: true });

  // 担当（このスペースは owner 1人）・カテゴリ・期限を選ぶ。
  await page.locator(".assignee-chip", { hasText: "おや" }).click();
  await page.getByRole("button", { name: "買い物" }).click();
  await page.getByLabel("期限").fill("2026-07-01");

  const t1 = `続けて追加A ${Date.now()}`;
  await page.getByLabel("タイトル").fill(t1);
  await page.getByRole("button", { name: "保存して続けて追加" }).click();

  // トースト表示・タイトルだけクリア・担当/カテゴリ/期限は保持。
  await expect(page.getByText(/保存しました/)).toBeVisible();
  await expect(page.getByLabel("タイトル")).toHaveValue("");
  await expect(
    page.locator(".assignee-chip", { hasText: "おや" })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "買い物" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByLabel("期限")).toHaveValue("2026-07-01");

  // 続けて2件目。
  const t2 = `続けて追加B ${Date.now()}`;
  await page.getByLabel("タイトル").fill(t2);
  await page.getByRole("button", { name: "保存して続けて追加" }).click();
  await expect(page.getByText(/保存しました/)).toBeVisible();

  // 両方が作成されている（「すべて」タブは当日/これからを問わず確認できる）。
  await page.goto("/");
  await page.getByRole("button", { name: "すべて" }).click();
  await expect(page.getByText(t1)).toBeVisible();
  await expect(page.getByText(t2)).toBeVisible();
});
