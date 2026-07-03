// リッチメニュー管理エンドポイント（Phase 3 / Wave 2-a）。オーナー限定。
//
// 運用: owner がデプロイ後に1回だけ POST /api/line/richmenu/setup を叩くと、
//   ① リッチメニュー作成（areas/actions 定義）
//   ② 画像アップロード（APP_BASE_URL/richmenu.png を fetch して bytes を LINE へ）
//   ③ デフォルト設定（全ユーザーに適用）
// を実行する。DELETE /api/line/richmenu で現在のデフォルトを削除できる。
//
// セキュリティ:
//   - requireAuth + requireOwner（未認証 401 / 非オーナー 403）。
//   - LINE Messaging 未設定は 503（mock-first。秘密が無ければ何もできない）。
//   - 秘密値（channelAccessToken）は応答にもログにも出さない。
//   - 画像 URL は APP_BASE_URL 由来の固定パス（秘密値を URL に入れない）。
import { Hono } from "hono";
import type { HonoEnv } from "../env";
import { getLineMessagingConfig, getLiffConfig } from "../line/config";
import {
  createLineRichMenuApi,
  LineApiError,
  type LineRichMenuApi,
} from "../line/api";
import { buildRichMenuDefinition } from "../line/richmenu";
import { requireAuth, requireOwner } from "../auth/middleware";

// リッチメニュー画像の固定パス（web/dist 静的配信。vite が web/public からコピー）。
const RICHMENU_IMAGE_PATH = "/richmenu.png";

// テストで差し替えられるよう、API ラッパ生成を factory に逃がす。
let richMenuApiFactory: (token: string) => LineRichMenuApi =
  createLineRichMenuApi;

export function __setRichMenuApiFactoryForTest(
  factory: (token: string) => LineRichMenuApi,
): () => void {
  const prev = richMenuApiFactory;
  richMenuApiFactory = factory;
  return () => {
    richMenuApiFactory = prev;
  };
}

interface FetchedImage {
  ok: boolean;
  status: number;
  contentType: string;
  body: ArrayBuffer;
}

// テストでは実取得を避けるため override を差し込む。本番は override 無しで
// ASSETS バインディング経由（自ホストへの公開サブリクエストをしない＝下記参照）。
let imageFetcherOverride:
  | ((url: string) => Promise<FetchedImage>)
  | null = null;

export function __setImageFetcherForTest(
  fetcher: (url: string) => Promise<FetchedImage>,
): () => void {
  imageFetcherOverride = fetcher;
  return () => {
    imageFetcherOverride = null;
  };
}

// リッチメニュー画像を取得する。
// Worker が自分の公開 URL へ fetch すると自己サブリクエストになり不安定なので、
// 本番は静的アセットの ASSETS バインディングから直接取得する。
async function fetchRichMenuImage(
  c: { env: HonoEnv["Bindings"]; req: { url: string } },
): Promise<FetchedImage> {
  if (imageFetcherOverride) {
    return imageFetcherOverride(`asset:${RICHMENU_IMAGE_PATH}`);
  }
  const assets = c.env.ASSETS;
  if (!assets) {
    return { ok: false, status: 503, contentType: "", body: new ArrayBuffer(0) };
  }
  const url = new URL(RICHMENU_IMAGE_PATH, c.req.url);
  const res = await assets.fetch(new Request(url.toString()));
  const contentType = res.headers.get("content-type") ?? "image/png";
  const body = res.ok ? await res.arrayBuffer() : new ArrayBuffer(0);
  return { ok: res.ok, status: res.status, contentType, body };
}

function normalizedBaseUrl(env: HonoEnv["Bindings"]): string | null {
  const raw = env.APP_BASE_URL;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.replace(/\/+$/, "");
}

export const lineRichMenuRoutes = new Hono<HonoEnv>();

// オーナーのみ。requireAuth で 401/403(not_member)、requireOwner で 403(非オーナー)。
lineRichMenuRoutes.use("/line/richmenu", requireAuth, requireOwner);
lineRichMenuRoutes.use("/line/richmenu/*", requireAuth, requireOwner);

// 登録: 作成 → 画像アップロード → デフォルト設定。
lineRichMenuRoutes.post("/line/richmenu/setup", async (c) => {
  const cfg = getLineMessagingConfig(c.env);
  if (!cfg) {
    return c.json({ error: "LINE Messaging は未設定です" }, 503);
  }
  const baseUrl = normalizedBaseUrl(c.env);
  if (!baseUrl) {
    return c.json({ error: "APP_BASE_URL が未設定です" }, 503);
  }

  const api = richMenuApiFactory(cfg.channelAccessToken);

  // 1) 画像を取得（ASSETS バインディング経由＝自己公開サブリクエストを避ける）。
  const img = await fetchRichMenuImage(c);
  if (!img.ok || img.body.byteLength === 0) {
    // 画像が配信されていない（未デプロイ／アセット未配置等）。URL は内部情報なので出さない。
    return c.json({ error: "リッチメニュー画像を取得できませんでした" }, 502);
  }
  // LINE は image/png または image/jpeg のみ受け付ける。
  // content-type が png/jpeg でなければ HTML 等の誤配信なので 502（アップロードしない）。
  const ct = img.contentType.toLowerCase();
  const contentType = ct.startsWith("image/jpeg")
    ? "image/jpeg"
    : ct.startsWith("image/png")
      ? "image/png"
      : null;
  if (!contentType) {
    return c.json({ error: "リッチメニュー画像の形式が不正です" }, 502);
  }

  try {
    // 0) 冪等化: 既存のデフォルトリッチメニューがあれば先に削除する
    //    （再実行で旧メニューが LINE 側に残らないように）。
    //    getDefault / delete の失敗（404・未設定等）は握って続行する。
    try {
      const existing = await api.getDefaultRichMenuId();
      if (existing) {
        await api.deleteRichMenu(existing);
      }
    } catch {
      // 既存が無い／取得・削除に一時失敗しても新規作成は続行する。
    }

    // 2) 作成。LIFF_ID があれば「連携設定」を LINE 内で開く URL に寄せる（公開値のみ）。
    const liffId = getLiffConfig(c.env).liffId;
    const def = buildRichMenuDefinition(baseUrl, liffId);
    const richMenuId = await api.createRichMenu(def);
    // 3) 画像アップロード。
    await api.uploadRichMenuImage(richMenuId, img.body, contentType);
    // 4) デフォルト設定。
    await api.setDefaultRichMenu(richMenuId);
    // richMenuId は秘密ではない（後続の削除運用に使えるよう返す）。token は返さない。
    return c.json({ ok: true, richMenuId });
  } catch (e) {
    if (e instanceof LineApiError) {
      // LINE 側のエラー status を呼び出し側へ。本文（秘密含みうる）は展開しない。
      return c.json({ error: "LINE リッチメニュー登録に失敗しました" }, 502);
    }
    throw e;
  }
});

// 削除: 現在のデフォルトリッチメニューを削除する。
lineRichMenuRoutes.delete("/line/richmenu", async (c) => {
  const cfg = getLineMessagingConfig(c.env);
  if (!cfg) {
    return c.json({ error: "LINE Messaging は未設定です" }, 503);
  }
  const api = richMenuApiFactory(cfg.channelAccessToken);
  try {
    const current = await api.getDefaultRichMenuId();
    if (!current) {
      return c.json({ ok: true, deleted: false });
    }
    await api.deleteRichMenu(current);
    return c.json({ ok: true, deleted: true, richMenuId: current });
  } catch (e) {
    if (e instanceof LineApiError) {
      return c.json({ error: "LINE リッチメニュー削除に失敗しました" }, 502);
    }
    throw e;
  }
});
