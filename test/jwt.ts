// テスト用 JWT ヘルパー。実鍵で ID トークンを自前署名し、JWKS(/certs) を組み立てる。
// idToken.ts の自前検証（ES256=JWKS / HS256=channel secret）を実鍵で検証するために使う。

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function stringToBase64Url(s: string): string {
  return bytesToBase64Url(new TextEncoder().encode(s));
}

// ローカル ES256 検証を“実行不能”にする為の、署名が無効な ES256 JWT を作る
// （/certs を 503 にする mock と組み合わせてフォールバック経路を試すのに使う）。
export function fakeEs256Token(payload: Record<string, unknown>): string {
  const header = stringToBase64Url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: "kx" }));
  const body = stringToBase64Url(JSON.stringify(payload));
  return `${header}.${body}.AAAA`;
}

// ---- ES256 ----
export interface Es256TestKey {
  privateKey: CryptoKey;
  jwkPublic: JsonWebKey; // kty=EC / crv=P-256 / x / y
  kid: string;
}

export async function generateEs256Key(kid: string): Promise<Es256TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwkPublic = (await crypto.subtle.exportKey(
    "jwk",
    pair.publicKey,
  )) as JsonWebKey;
  return { privateKey: pair.privateKey, jwkPublic, kid };
}

// LINE /certs 形式の JWKS document を組み立てる。
export function jwksDocument(keys: Es256TestKey[]): { keys: unknown[] } {
  return {
    keys: keys.map((k) => ({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      use: "sig",
      kid: k.kid,
      x: k.jwkPublic.x,
      y: k.jwkPublic.y,
    })),
  };
}

// ES256 で JWT を署名する。
export async function signEs256(
  key: Es256TestKey,
  payload: Record<string, unknown>,
  opts: { kid?: string } = {},
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT", kid: opts.kid ?? key.kid };
  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(
    JSON.stringify(payload),
  )}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}

// ---- HS256 ----
export async function signHs256(
  channelSecret: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(
    JSON.stringify(payload),
  )}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput)),
  );
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}

// 署名を改ざんしたトークンを返す（reject テスト用）。
// 末尾文字は trailing bit が無意味で decode 結果が変わらないことがあるため、
// 署名の先頭付近の文字を確実に別バイトへ変える。
export function tamperSignature(jwt: string): string {
  const parts = jwt.split(".");
  const sig = parts[2];
  const i = 0; // 先頭文字を置換（上位ビットに効く）。
  const replacement = sig[i] === "A" ? "B" : "A";
  parts[2] = replacement + sig.slice(1);
  return parts.join(".");
}
