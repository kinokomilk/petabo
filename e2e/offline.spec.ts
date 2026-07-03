import { test, expect } from "@playwright/test";

// PWA：service worker が登録・制御し、オフライン用のアプリシェルを precache する。
// 本番ビルド（wrangler dev が web/dist を配信）で SW が登録される前提。
//
// 注: Playwright の context.setOffline によるオフライン・ナビゲーション再現は、
// SW がキャッシュ配信するナビゲーションを安定して通さない（実ブラウザの
// DevTools offline では動く類の制約）。そこでオフライン能力の本質＝
// 「SW がページを制御し、シェル(index.html)が precache 済み」を検証する。
test("service worker が登録され、オフライン用シェルが precache される", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null
  );
  await page.waitForLoadState("networkidle");

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const paths: string[] = [];
    for (const k of keys) {
      const c = await caches.open(k);
      for (const r of await c.keys()) paths.push(new URL(r.url).pathname);
    }
    return paths;
  });

  // アプリシェルがオフライン配信用にキャッシュされている。
  expect(cached).toContain("/index.html");
  expect(cached).toContain("/");
});
