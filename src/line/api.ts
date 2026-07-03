// LINE Login の外部 API 呼び出しを差し替え可能な fetch ラッパに集約する。
// Vitest では globalThis.fetch を mock して契約をテストする。
// 秘密値（client_secret / code / id_token）はここでもログに出さない。

const LINE_TOKEN_ENDPOINT = "https://api.line.me/oauth2/v2.1/token";
const LINE_VERIFY_ENDPOINT = "https://api.line.me/oauth2/v2.1/verify";
const LINE_FRIENDSHIP_ENDPOINT = "https://api.line.me/friendship/v1/status";
const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_MULTICAST_ENDPOINT = "https://api.line.me/v2/bot/message/multicast";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
// リッチメニュー（作成/画像/デフォルト/削除）。data 系（画像）は api-data ホスト。
const LINE_RICHMENU_ENDPOINT = "https://api.line.me/v2/bot/richmenu";
const LINE_RICHMENU_DATA_ENDPOINT = "https://api-data.line.me/v2/bot/richmenu";
const LINE_DEFAULT_RICHMENU_ENDPOINT =
  "https://api.line.me/v2/bot/user/all/richmenu";

// token endpoint のレスポンス（必要分のみ）。
export interface LineTokenResponse {
  access_token: string;
  expires_in: number;
  id_token: string;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

// verify endpoint が返す（検証済み）ID token ペイロード。
export interface LineIdTokenPayload {
  iss: string;
  sub: string;
  aud: string;
  exp: number;
  iat?: number;
  nonce?: string;
  name?: string;
  picture?: string;
  email?: string;
}

// 外部 API 呼び出しの失敗を呼び出し側で安全に扱うためのエラー型。
export class LineApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LineApiError";
    this.status = status;
  }
}

async function fetchLine(
  endpoint: string,
  init: RequestInit,
  unreachableMessage: string,
): Promise<Response> {
  try {
    return await fetch(endpoint, init);
  } catch {
    throw new LineApiError(unreachableMessage, 502);
  }
}

function assertOk(res: Response, errorMessage: string): void {
  if (!res.ok) {
    throw new LineApiError(errorMessage, res.status);
  }
}

async function readJsonOrNull<T>(res: Response): Promise<T | null> {
  return (await res.json().catch(() => null)) as T | null;
}

// push 失敗の分類。無料枠浪費・無駄な再送を避けるため、
//   - permanent（400/403 等）: 無効 userId・ブロック等。再試行しても無駄 → 再送しない。
//   - transient（429/5xx・ネットワーク不達）: 一過性 → 未記録のまま次回 Cron で再試行。
// status だけで判定する（本文・秘密はログにも判定にも使わない）。
export type PushFailureClass = "permanent" | "transient";

export function classifyPushFailure(status: number): PushFailureClass {
  // 400 = 不正リクエスト（無効 userId 等）/ 403 = ブロック・友だち未登録。
  if (status === 400 || status === 403) return "permanent";
  // 429（レート）/ 5xx（一時障害）/ 502（不達）は一過性として再試行。
  return "transient";
}

// 認可コードをトークン（id_token 含む）に交換する。
// 4xx/5xx は LineApiError を投げる（本文は秘密を含みうるためメッセージに展開しない）。
export async function exchangeCodeForToken(params: {
  code: string;
  redirectUri: string;
  channelId: string;
  channelSecret: string;
}): Promise<LineTokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.channelId,
    client_secret: params.channelSecret,
  });

  const res = await fetchLine(
    LINE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    "token endpoint unreachable",
  );
  assertOk(res, "token endpoint error");

  const data = await readJsonOrNull<LineTokenResponse>(res);
  if (
    !data ||
    typeof data.id_token !== "string" ||
    data.id_token.length === 0 ||
    typeof data.access_token !== "string" ||
    data.access_token.length === 0
  ) {
    throw new LineApiError("token endpoint returned invalid token response", 502);
  }
  return data;
}

// ID token を LINE verify endpoint で検証し、ペイロードを得る。
// LINE は署名・aud・nonce 等の検証をここで行う（self 検証は呼び出し側で追加実施）。
export async function verifyIdToken(params: {
  idToken: string;
  channelId: string;
  nonce?: string;
}): Promise<LineIdTokenPayload> {
  const form = new URLSearchParams({
    id_token: params.idToken,
    client_id: params.channelId,
  });
  if (params.nonce) form.set("nonce", params.nonce);

  const res = await fetchLine(
    LINE_VERIFY_ENDPOINT,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    "verify endpoint unreachable",
  );

  if (!res.ok) {
    // 400 = 署名/nonce/aud 不正など。呼び出し側で 401 に寄せる。
    throw new LineApiError("verify endpoint rejected id_token", res.status);
  }

  const data = await readJsonOrNull<LineIdTokenPayload>(res);
  if (!data || typeof data.sub !== "string") {
    throw new LineApiError("verify endpoint returned invalid payload", 502);
  }
  return data;
}

// LINE Login の access token で、連携済み公式アカウントとの友だち状態を確認する。
// bot_prompt だけでは「既に友だち」「追加しなかった」をDBへ確定反映できないため、
// callback 後にこの API の friendFlag を line_followed へ同期する。
export async function getFriendshipStatus(accessToken: string): Promise<boolean> {
  const res = await fetchLine(
    LINE_FRIENDSHIP_ENDPOINT,
    {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    },
    "friendship endpoint unreachable",
  );
  assertOk(res, "friendship endpoint error");

  const data = await readJsonOrNull<{ friendFlag?: unknown }>(res);
  if (!data || typeof data.friendFlag !== "boolean") {
    throw new LineApiError("friendship endpoint returned invalid payload", 502);
  }
  return data.friendFlag;
}

// ---------- Messaging API push（リマインダー用） ----------
// Push は差し替え可能なラッパに集約し、Vitest では globalThis.fetch を mock する。
// 呼び出し側（reminder ロジック）が 403/429/5xx を判別して
// 「送信済み記録するか／ブロック扱いにするか／次回再試行するか」を決められるよう、
// 失敗は LineApiError（status 付き）で投げる契約にする。
// 秘密値（channelAccessToken）はログに出さない。

// push / multicast / reply で送るメッセージ型。
// Phase 2 はテキストのみ。Phase 3 で Flex / quickReply を追加。
// quickReply は text / flex どちらにも付けられる（LINE 仕様）。
export interface LineQuickReplyItem {
  type: "action";
  action: LineAction;
}
export interface LineQuickReply {
  items: LineQuickReplyItem[];
}
// postback / message action（Flex ボタン・quickReply で使う最小集合）。
export interface LinePostbackAction {
  type: "postback";
  label: string;
  data: string; // 最大 300 byte（呼び出し側で担保する）
  displayText?: string;
}
export interface LineMessageAction {
  type: "message";
  label: string;
  text: string;
}
export interface LineUriAction {
  type: "uri";
  label: string;
  uri: string;
}
export type LineAction = LinePostbackAction | LineMessageAction | LineUriAction;

export interface LineTextMessage {
  type: "text";
  text: string;
  quickReply?: LineQuickReply;
}
// Flex は contents を任意 JSON（bubble / carousel）として持つ。
// 外部由来テキストは contents の構造値（text 等）に入れる＝文字列手結合しない。
export interface LineFlexMessage {
  type: "flex";
  altText: string;
  contents: unknown;
  quickReply?: LineQuickReply;
}
export type LineMessage = LineTextMessage | LineFlexMessage;

// 差し替え可能な push インターフェース。reminder ロジックはこの型に依存し、
// テストでは mock 実装（fetch を呼ばない）を注入できる。
export interface LinePush {
  // 単一の userId へ push（担当者あり / private creator 用）。
  push(to: string, messages: LineMessage[]): Promise<void>;
  // 複数 userId へ multicast（未担当 → active 全員。人数分の無料枠を消費する）。
  multicast(to: string[], messages: LineMessage[]): Promise<void>;
}

// LINE Messaging API を叩く本番用の LinePush 実装を生成する。
// global fetch を使うため、テストでは globalThis.fetch を mock するか、
// あるいは LinePush 自体を mock 実装へ差し替える。
export function createLinePush(channelAccessToken: string): LinePush {
  const headers = {
    authorization: `Bearer ${channelAccessToken}`,
    "content-type": "application/json",
  };

  async function send(endpoint: string, payload: unknown): Promise<void> {
    const res = await fetchLine(
      endpoint,
      {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      },
      "push endpoint unreachable",
    );
    // 本文は秘密やユーザ情報を含みうるためメッセージに展開しない。
    // status のみ呼び出し側へ渡す（403=ブロック / 429=レート / 5xx=一時障害）。
    assertOk(res, "push endpoint error");
  }

  return {
    async push(to, messages) {
      await send(LINE_PUSH_ENDPOINT, { to, messages });
    },
    async multicast(to, messages) {
      await send(LINE_MULTICAST_ENDPOINT, { to, messages });
    },
  };
}

// ---------- Messaging API reply（Phase 3 チャット操作用） ----------
// reply は replyToken（約1分・1回のみ有効）で即応する。push と同じく
// 差し替え可能ラッパに集約し、テストでは LineReply を mock 実装に差し替えるか
// globalThis.fetch を mock する。秘密値（channelAccessToken）はログに出さない。
export interface LineReply {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
}

// global fetch を使う本番用 LineReply 実装を生成する。
export function createLineReply(channelAccessToken: string): LineReply {
  const headers = {
    authorization: `Bearer ${channelAccessToken}`,
    "content-type": "application/json",
  };
  return {
    async reply(replyToken, messages) {
      const res = await fetchLine(
        LINE_REPLY_ENDPOINT,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ replyToken, messages }),
        },
        "reply endpoint unreachable",
      );
      // 本文は秘密やユーザ情報を含みうるためメッセージに展開しない。
      assertOk(res, "reply endpoint error");
    },
  };
}

// ---------- リッチメニュー（Phase 3 / Wave 2-a 管理用） ----------
// オーナーがデプロイ後に1回だけ叩く管理エンドポイント（routes/lineRichMenu.ts）から
// 使う。global fetch を使い、テストでは LineRichMenuApi を mock 実装へ差し替えるか
// globalThis.fetch を mock する。秘密値（channelAccessToken）はログにも応答にも出さない。

// areas/actions の定義（LINE リッチメニュー仕様の必要分のみ）。
export interface RichMenuBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface RichMenuArea {
  bounds: RichMenuBounds;
  action: LineAction;
}
export interface RichMenuSize {
  width: number; // 2500 固定
  height: number; // 1686 または 843
}
export interface RichMenuDefinition {
  size: RichMenuSize;
  selected: boolean;
  name: string; // 管理用名称（ユーザーには出ない）
  chatBarText: string; // メニューバーのラベル（最大14文字）
  areas: RichMenuArea[];
}

// 差し替え可能なリッチメニュー API。テストでは fetch を呼ばない mock を注入できる。
export interface LineRichMenuApi {
  // リッチメニュー定義を作成し richMenuId を返す。
  createRichMenu(def: RichMenuDefinition): Promise<string>;
  // 画像（png/jpeg bytes）をアップロードする。
  uploadRichMenuImage(
    richMenuId: string,
    image: ArrayBuffer,
    contentType: string,
  ): Promise<void>;
  // 全ユーザーのデフォルトリッチメニューに設定する。
  setDefaultRichMenu(richMenuId: string): Promise<void>;
  // 現在のデフォルトリッチメニュー id を取得（無ければ null）。
  getDefaultRichMenuId(): Promise<string | null>;
  // リッチメニューを削除する（cleanup / 入れ替え用）。
  deleteRichMenu(richMenuId: string): Promise<void>;
}

// LINE Messaging API を叩く本番用 LineRichMenuApi 実装を生成する。
export function createLineRichMenuApi(
  channelAccessToken: string,
): LineRichMenuApi {
  const authHeader = { authorization: `Bearer ${channelAccessToken}` };

  return {
    async createRichMenu(def) {
      const res = await fetchLine(
        LINE_RICHMENU_ENDPOINT,
        {
          method: "POST",
          headers: { ...authHeader, "content-type": "application/json" },
          body: JSON.stringify(def),
        },
        "richmenu create unreachable",
      );
      assertOk(res, "richmenu create error");
      const data = await readJsonOrNull<{ richMenuId?: unknown }>(res);
      if (!data || typeof data.richMenuId !== "string" || !data.richMenuId) {
        throw new LineApiError("richmenu create returned invalid id", 502);
      }
      return data.richMenuId;
    },

    async uploadRichMenuImage(richMenuId, image, contentType) {
      const res = await fetchLine(
        `${LINE_RICHMENU_DATA_ENDPOINT}/${encodeURIComponent(richMenuId)}/content`,
        {
          method: "POST",
          headers: { ...authHeader, "content-type": contentType },
          body: image,
        },
        "richmenu image unreachable",
      );
      assertOk(res, "richmenu image error");
    },

    async setDefaultRichMenu(richMenuId) {
      const res = await fetchLine(
        `${LINE_DEFAULT_RICHMENU_ENDPOINT}/${encodeURIComponent(richMenuId)}`,
        { method: "POST", headers: authHeader },
        "richmenu default unreachable",
      );
      assertOk(res, "richmenu default error");
    },

    async getDefaultRichMenuId() {
      const res = await fetchLine(
        LINE_DEFAULT_RICHMENU_ENDPOINT,
        {
          method: "GET",
          headers: authHeader,
        },
        "richmenu default get unreachable",
      );
      // 404 = デフォルト未設定（正常系として null を返す）。
      if (res.status === 404) return null;
      assertOk(res, "richmenu default get error");
      const data = await readJsonOrNull<{ richMenuId?: unknown }>(res);
      if (!data || typeof data.richMenuId !== "string" || !data.richMenuId) {
        return null;
      }
      return data.richMenuId;
    },

    async deleteRichMenu(richMenuId) {
      const res = await fetchLine(
        `${LINE_RICHMENU_ENDPOINT}/${encodeURIComponent(richMenuId)}`,
        { method: "DELETE", headers: authHeader },
        "richmenu delete unreachable",
      );
      // 404 = 既に無い（冪等に成功扱い）。
      if (res.status === 404) return;
      assertOk(res, "richmenu delete error");
    },
  };
}
