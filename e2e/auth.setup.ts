import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";

// オーナーを新規登録し、HttpOnly Cookie セッションを storageState に保存する。
// register は単一スペース制約で一度しか通らないため、すでに登録済み（前回の
// 試行残り／リトライ）ならログインにフォールバックして冪等にする。
const authFile = "e2e/.auth/owner.json";
const HOUSE = "E2Eサンプル家";
const NAME = "おや";
const PW = "pw12345678";

setup("オーナー登録（または復帰ログイン）してセッションを保存", async ({ page }) => {
  fs.mkdirSync("e2e/.auth", { recursive: true });

  await page.goto("/");
  // まず新規作成（スペースを作る）を試す。
  await page.getByRole("tab", { name: "スペースを作る" }).click();
  await page.getByLabel("家族の名前").fill(HOUSE);
  await page.getByLabel("あなたの名前").fill(NAME);
  await page.getByLabel("パスワード").fill(PW);
  await page.getByRole("button", { name: "スペースを作ってはじめる" }).click();

  // 成功ならホーム到達。失敗（既にスペースあり等）ならログインで復帰。
  const brand = page.locator(".brand-logo");
  try {
    await expect(brand).toHaveText("petabo", { timeout: 8000 });
  } catch {
    await page.getByRole("tab", { name: "ログイン" }).click();
    await page.getByLabel("あなたの名前").fill(NAME);
    await page.getByLabel("パスワード").fill(PW);
    await page.getByRole("button", { name: "ログイン" }).click();
    await expect(brand).toHaveText("petabo", { timeout: 8000 });
  }

  await expect(page.getByLabel("やることを追加")).toBeVisible();
  await expect(page.locator(".brand-house")).toHaveText(HOUSE);

  await page.context().storageState({ path: authFile });
});
