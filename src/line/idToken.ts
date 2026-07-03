// LINE Login ID トークン（JWT）の自前署名検証。
// 外部 verify endpoint（api.line.me/oauth2/v2.1/verify）への依存を減らし、
// その障害時にもログインを継続できるよう、署名検証をローカルで行う。
//
// LINE 公式（https://developers.line.biz/en/docs/line-login/verify-id-token/）より:
//   - Web ログインの ID トークンは HS256（HMAC-SHA256, 鍵 = チャンネルシークレット）。
//   - LIFF / LINE SDK の ID トークンは ES256（ECDSA P-256）。公開鍵は JWKS
//     （https://api.line.me/oauth2/v2.1/certs, kty=EC / crv=P-256 / alg=ES256 / kid）。
// よって JWT ヘッダの alg を見て検証方式を分岐する（両対応）。
//
// 方針（安全第一）:
//   - 署名検証が通るまで payload/sub を信用しない。
//   - claims（iss/aud/exp/nonce/sub）の最終判定は呼び出し側でも実施（多層防御）。
//     本モジュールも基本的な claims（aud/iss/exp/nonce）は検証してから payload を返す。
//   - 署名“不一致”は即 reject（フォールバックしない＝改ざんを通さない）。
//   - JWKS が取得不能（fetch エラー / 非 2xx）、または該当 kid が見つからない等の
//     “実行不能”時のみ、呼び出し側が verify endpoint にフォールバックできるよう
//     IdTokenUnavailableError を投げて区別する。
//   - 秘密値・トークンはログに出さない。

import type { LineIdTokenPayload } from "./api";

const LINE_CERTS_ENDPOINT = "https://api.line.me/oauth2/v2.1/certs";

// 署名が改ざん／不正で確定的に拒否すべき場合（フォールバック不可）。
export class IdTokenSignatureError extends Error {
  constructor(message = "id_token signature verification failed") {
    super(message);
    this.name = "IdTokenSignatureError";
  }
}

// claims（iss/aud/exp/nonce/sub）が不正で確定的に拒否すべき場合（フォールバック不可）。
export class IdTokenClaimError extends Error {
  constructor(message = "id_token claim verification failed") {
    super(message);
    this.name = "IdTokenClaimError";
  }
}

// 検証“実行不能”（JWKS 取得失敗・kid 不一致・未対応 alg 等）。
// 呼び出し側はこの時のみ verify endpoint へフォールバックしてよい。
export class IdTokenUnavailableError extends Error {
  constructor(message = "id_token local verification unavailable") {
    super(message);
    this.name = "IdTokenUnavailableError";
  }
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

// base64url → Uint8Array。
function base64UrlToBytes(input: string): Uint8Array | null {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function base64UrlToString(input: string): string | null {
  const bytes = base64UrlToBytes(input);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// タイミング安全比較。
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- JWKS（ES256 公開鍵）キャッシュ ----------
// モジュール内メモ + 短い TTL。kid で引く。毎ログインで fetch しない。
interface Jwk {
  kty?: string;
  crv?: string;
  alg?: string;
  kid?: string;
  x?: string;
  y?: string;
}

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 時間
let jwksCache: { fetchedAt: number; keys: Map<string, Jwk> } | null = null;

// JWKS を取得（キャッシュ優先）。force=true で TTL 無視で取り直す（kid 不一致時の更新用）。
async function loadJwks(force: boolean): Promise<Map<string, Jwk>> {
  const now = Date.now();
  if (
    !force &&
    jwksCache &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS &&
    jwksCache.keys.size > 0
  ) {
    return jwksCache.keys;
  }

  let res: Response;
  try {
    res = await fetch(LINE_CERTS_ENDPOINT, { method: "GET" });
  } catch {
    // 取得不能（実行不能）。古いキャッシュがあればそれを使う、無ければ unavailable。
    if (jwksCache && jwksCache.keys.size > 0) return jwksCache.keys;
    throw new IdTokenUnavailableError("JWKS endpoint unreachable");
  }
  if (!res.ok) {
    if (jwksCache && jwksCache.keys.size > 0) return jwksCache.keys;
    throw new IdTokenUnavailableError("JWKS endpoint error");
  }
  const data = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  if (!data || !Array.isArray(data.keys)) {
    if (jwksCache && jwksCache.keys.size > 0) return jwksCache.keys;
    throw new IdTokenUnavailableError("JWKS endpoint returned invalid document");
  }
  const map = new Map<string, Jwk>();
  for (const k of data.keys) {
    if (k && typeof k.kid === "string") map.set(k.kid, k);
  }
  jwksCache = { fetchedAt: now, keys: map };
  return map;
}

// テスト用：JWKS キャッシュを明示クリアする。
export function __clearJwksCacheForTest(): void {
  jwksCache = null;
}

// JWK(EC P-256) を WebCrypto の公開鍵 CryptoKey に取り込む。
async function importEs256PublicKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

// ES256 署名検証。kid に対応する公開鍵で signingInput を検証する。
// kid 不一致時は JWKS を強制リロードして再試行（鍵ローテーション対応）。
async function verifyEs256(
  header: JwtHeader,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  if (!header.kid) {
    // ES256 は kid 必須。無ければローカルでは確定検証できない → 実行不能。
    throw new IdTokenUnavailableError("ES256 id_token missing kid");
  }

  const tryWith = async (keys: Map<string, Jwk>): Promise<boolean | "no-kid"> => {
    const jwk = keys.get(header.kid as string);
    if (!jwk) return "no-kid";
    if (jwk.kty !== "EC" || jwk.crv !== "P-256") {
      throw new IdTokenUnavailableError("JWKS key is not EC P-256");
    }
    const key = await importEs256PublicKey(jwk);
    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature as BufferSource,
      new TextEncoder().encode(signingInput),
    );
  };

  // まずキャッシュ（or 取得）で試す。
  let result = await tryWith(await loadJwks(false));
  if (result === "no-kid") {
    // 鍵がローテーションした可能性 → 強制リロードして再試行。
    result = await tryWith(await loadJwks(true));
  }
  if (result === "no-kid") {
    // それでも見つからない → 実行不能（フォールバック対象）。
    throw new IdTokenUnavailableError("no JWKS key matches kid");
  }
  return result;
}

// HS256 署名検証。鍵 = チャンネルシークレット。
async function verifyHs256(
  channelSecret: string,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)),
  );
  return timingSafeEqual(signature, expected);
}

const LINE_ISS = "https://access.line.me";

// 署名検証 + 基本 claims 検証を行い、payload を返す。
// - alg=HS256 → channelSecret で HMAC 検証。
// - alg=ES256 → JWKS の公開鍵で ECDSA 検証。
// 例外:
//   - IdTokenSignatureError / IdTokenClaimError: 確定拒否（フォールバック不可）。
//   - IdTokenUnavailableError: 実行不能（呼び出し側で verify endpoint フォールバック可）。
export async function verifyIdTokenLocally(params: {
  idToken: string;
  channelId: string;
  channelSecret: string;
  nonce?: string;
  // 時刻のわずかなズレを吸収（既定 0。exp 判定の許容秒）。
  clockToleranceSec?: number;
}): Promise<LineIdTokenPayload> {
  const parts = params.idToken.split(".");
  if (parts.length !== 3) {
    // 形式不正は署名以前の問題＝確定拒否。
    throw new IdTokenSignatureError("malformed JWT");
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  const headerJson = base64UrlToString(headerB64);
  const payloadJson = base64UrlToString(payloadB64);
  const signature = base64UrlToBytes(signatureB64);
  if (!headerJson || !payloadJson || !signature) {
    throw new IdTokenSignatureError("invalid JWT encoding");
  }

  let header: JwtHeader;
  let payload: LineIdTokenPayload;
  try {
    header = JSON.parse(headerJson) as JwtHeader;
    payload = JSON.parse(payloadJson) as LineIdTokenPayload;
  } catch {
    throw new IdTokenSignatureError("invalid JWT JSON");
  }

  const signingInput = `${headerB64}.${payloadB64}`;
  const alg = header.alg;

  let signatureOk: boolean;
  if (alg === "HS256") {
    signatureOk = await verifyHs256(
      params.channelSecret,
      signingInput,
      signature,
    );
  } else if (alg === "ES256") {
    signatureOk = await verifyEs256(header, signingInput, signature);
  } else {
    // 未知 alg はローカルで検証できない → 実行不能（フォールバック対象）。
    throw new IdTokenUnavailableError(`unsupported alg`);
  }

  if (!signatureOk) {
    // 署名不一致は改ざんの可能性 → 確定拒否（フォールバックしない）。
    throw new IdTokenSignatureError();
  }

  // ---- 署名 OK。基本 claims を検証（多層防御。呼び出し側でも再検証する）。----
  if (payload.iss !== LINE_ISS) {
    throw new IdTokenClaimError("iss mismatch");
  }
  if (payload.aud !== params.channelId) {
    throw new IdTokenClaimError("aud mismatch");
  }
  const tolerance = params.clockToleranceSec ?? 0;
  if (
    typeof payload.exp !== "number" ||
    payload.exp * 1000 + tolerance * 1000 <= Date.now()
  ) {
    throw new IdTokenClaimError("expired");
  }
  if (params.nonce && payload.nonce !== params.nonce) {
    throw new IdTokenClaimError("nonce mismatch");
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new IdTokenClaimError("sub empty");
  }

  return payload;
}
