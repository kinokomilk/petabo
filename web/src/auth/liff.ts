// LIFF 起動（LINE 内で Web 本体を開く）。
//
// 方針（mock-first / 既存 Web フローを壊さない）:
// - 起動時に /api/liff/config で liffId を取得。未設定（null）なら何もしない。
// - LIFF SDK（index.html で読み込む window.liff）が無い／init 失敗なら通常フローへ
//   フォールバック（例外を投げず false を返す）。
// - LINE 内（liff.isInClient()）かつログイン済みのときだけ id_token をサーバへ渡し、
//   POST /api/auth/liff でセッションを確立する。LINE 外（通常ブラウザ）では何もしない。
// - 秘密はクライアントに渡さない（扱うのは公開設定の liffId と、サーバ検証用 id_token のみ）。
import { endpoints } from "../api/endpoints";

// LIFF SDK の最小型（必要分のみ。@line/liff の型に依存せず軽量に保つ）。
interface LiffSdk {
  init(config: { liffId: string }): Promise<void>;
  isInClient(): boolean;
  isLoggedIn(): boolean;
  getIDToken(): string | null;
  getFriendship?(): Promise<{ friendFlag: boolean }>;
}

declare global {
  interface Window {
    liff?: LiffSdk;
  }
}

// LIFF 経由でセッションを確立できたら true。何もしなかった／フォールバックした場合は false。
// 例外は内部で握りつぶす（呼び出し側＝AuthContext の通常フローを阻害しない）。
export async function tryLiffLogin(): Promise<boolean> {
  try {
    // 公開設定を取得。未設定なら LIFF を使わない。
    const { liffId } = await endpoints.liffConfig();
    if (!liffId) return false;

    const liff = window.liff;
    if (!liff) return false; // SDK 未読込（ネットワーク失敗等）→ 通常フロー。

    await liff.init({ liffId });

    // LINE 外（通常ブラウザ）では何もしない＝既存 Web ログインフローを維持する。
    if (!liff.isInClient()) return false;
    if (!liff.isLoggedIn()) return false;

    const idToken = liff.getIDToken();
    if (!idToken) return false;

    // 友だち状態を取得できる場合はサーバへ渡し、line_followed と同期する。
    // 取得失敗時は undefined のまま送り、サーバ側で既存状態を維持する。
    let friendFlag: boolean | undefined;
    if (typeof liff.getFriendship === "function") {
      try {
        const friendship = await liff.getFriendship();
        if (typeof friendship.friendFlag === "boolean") {
          friendFlag = friendship.friendFlag;
        }
      } catch {
        friendFlag = undefined;
      }
    }

    // サーバへ id_token を渡し、サーバ側で検証＋セッション発行（Cookie）。
    await endpoints.liffLogin(idToken, friendFlag);
    return true;
  } catch {
    // init 失敗・ネットワーク失敗・検証失敗いずれも通常フローへフォールバック。
    return false;
  }
}
