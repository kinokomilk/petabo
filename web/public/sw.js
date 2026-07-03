// petabo 最小オフラインシェル Service Worker。
// アプリシェル（ナビゲーション）を cache-first で返し、API は常にネットワーク。
const CACHE = "petabo-shell-v2";
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // API はキャッシュしない（Cookie 認証・鮮度重視）。
  if (url.pathname.startsWith("/api/")) return;

  // SPA ナビゲーションはネット優先 → 失敗時にシェルへフォールバック。
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/index.html").then((r) => r || Response.error()))
    );
    return;
  }

  // 静的アセットは cache-first（無ければ取得してキャッシュ）。
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
          return res;
        })
    )
  );
});
