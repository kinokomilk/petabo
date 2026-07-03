// LINE Webhook の署名検証（生ボディ基準・WebCrypto HMAC-SHA256）。
// X-Line-Signature = base64(HMAC-SHA256(channelSecret, raw body))。
// 検証が通るまで JSON parse / DB / userId / ログを触らないこと。

function base64FromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function bytesFromBase64(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// タイミング安全比較（長さ・内容ともに一定時間に近づける）。
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// 生ボディに対する HMAC-SHA256 を base64 で返す。
export async function computeLineSignature(
  channelSecret: string,
  rawBody: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return base64FromBytes(new Uint8Array(sig));
}

// X-Line-Signature ヘッダを検証する。署名なし/不一致は false。副作用なし。
export async function verifyLineSignature(
  channelSecret: string,
  rawBody: string,
  signatureHeader: string | undefined | null,
): Promise<boolean> {
  if (!signatureHeader) return false;
  const provided = bytesFromBase64(signatureHeader);
  if (!provided) return false;
  const expected = await computeLineSignature(channelSecret, rawBody);
  const expectedBytes = bytesFromBase64(expected);
  if (!expectedBytes) return false;
  return timingSafeEqual(provided, expectedBytes);
}
