import { test, expect, devices } from "@playwright/test";

// 招待リンク発行 → 別ユーザーが /join/:token で参加できる（オーナー＋メンバーの2コンテキスト）。
test("オーナーが招待リンクを発行し、別ユーザーが参加できる", async ({
  page,
  browser,
}) => {
  // オーナー（storageState）：設定で招待リンクを発行。
  await page.goto("/settings");
  await page.getByRole("button", { name: "招待リンクを発行" }).click();
  const inviteUrl = await page.locator(".invite-url").textContent();
  expect(inviteUrl).toBeTruthy();
  expect(inviteUrl!).toContain("/join/");

  // 参加者：未ログインの別コンテキストでリンクを開いて参加。
  const joinerCtx = await browser.newContext({ ...devices["Pixel 5"] });
  const joiner = await joinerCtx.newPage();
  await joiner.goto(inviteUrl!.trim());

  await joiner.getByLabel("あなたの名前").fill(`けん${Date.now()}`);
  await joiner.getByLabel("パスワード").fill("pw12345678");
  await joiner.getByRole("button", { name: "参加する" }).click();

  // 参加後、同じ家族スペースのホームに着く。
  await expect(joiner.locator(".brand-logo")).toHaveText("petabo");
  await expect(joiner.locator(".brand-house")).toHaveText("E2Eサンプル家");

  await joinerCtx.close();
});

test("無効な招待トークンは参加フォームを出さない", async ({ browser }) => {
  const ctx = await browser.newContext({ ...devices["Pixel 5"] });
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:8799/join/not-a-real-token");
  await expect(
    p.getByText("この招待リンクは無効か、期限が切れています。")
  ).toBeVisible();
  await ctx.close();
});
