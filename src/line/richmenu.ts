// リッチメニュー定義（areas/actions）。Phase 3 / Wave 2-a。
//
// 画像 web/public/richmenu.png（2500×1686, 2列×2行）と座標を一致させる:
//   左上 = 一覧 / 右上 = きょう / 左下 = メモを貼る / 右下 = 連携設定
//
// action は postback か URI のみ。秘密値を URL/data に入れない（PHASE3_PRE_REVIEW 厳守）。
//   一覧       → postback action=list（既定フィルタ。webhook の handlePostback が一覧 Flex を返す）
//   きょう     → postback action=list&filter=today（today フィルタ）
//   メモを貼る → postback action=addprompt（quickReply で「追加 」入力を促す最小実装）
//   連携設定   → URI。LIFF_ID があれば https://liff.line.me/<LIFF_ID>（LINE 内で本体が
//                開く）、未設定なら APP_BASE_URL（外部ブラウザ）。
//                LIFF_ID は公開設定なので URL に載せてよい（他の秘密値は載せない）。
import type { RichMenuDefinition } from "./api";

// 画像サイズ（生成スクリプトと一致させる）。
export const RICHMENU_WIDTH = 2500;
export const RICHMENU_HEIGHT = 1686;
const HALF_W = RICHMENU_WIDTH / 2; // 1250
const HALF_H = RICHMENU_HEIGHT / 2; // 843

// LIFF_ID から LINE 内で本体を開く URL を組み立てる（公開値のみ）。
export function liffUrlFor(liffId: string): string {
  return `https://liff.line.me/${encodeURIComponent(liffId)}`;
}

// appBaseUrl は呼び出し側で正規化済み（末尾スラッシュ無し）の絶対 URL を渡す。
// liffId が非 null なら本体導線（連携設定）を LIFF URL に寄せる（LINE 内表示）。
export function buildRichMenuDefinition(
  appBaseUrl: string,
  liffId: string | null = null,
): RichMenuDefinition {
  // 本体を開く導線（連携設定）の URI。LIFF があれば LINE 内で開く。
  const appOpenUri = liffId ? liffUrlFor(liffId) : appBaseUrl;
  return {
    size: { width: RICHMENU_WIDTH, height: RICHMENU_HEIGHT },
    selected: true,
    name: "petabo-default",
    chatBarText: "メニュー",
    areas: [
      // 左上: 一覧
      {
        bounds: { x: 0, y: 0, width: HALF_W, height: HALF_H },
        action: {
          type: "postback",
          label: "一覧",
          data: "action=list",
          displayText: "一覧",
        },
      },
      // 右上: きょう
      {
        bounds: { x: HALF_W, y: 0, width: HALF_W, height: HALF_H },
        action: {
          type: "postback",
          label: "きょう",
          data: "action=list&filter=today",
          displayText: "きょう",
        },
      },
      // 左下: メモを貼る
      {
        bounds: { x: 0, y: HALF_H, width: HALF_W, height: HALF_H },
        action: {
          type: "postback",
          label: "メモを貼る",
          data: "action=addprompt",
          displayText: "メモを貼る",
        },
      },
      // 右下: 連携設定（本体を開く。LIFF があれば LINE 内、無ければ外部ブラウザ）。
      {
        bounds: { x: HALF_W, y: HALF_H, width: HALF_W, height: HALF_H },
        action: {
          type: "uri",
          label: "連携設定",
          uri: appOpenUri,
        },
      },
    ],
  };
}
