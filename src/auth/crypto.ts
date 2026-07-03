// パスワードハッシュ（WebCrypto PBKDF2 + ソルト）とトークン生成・タイミング安全比較。
// Workers ランタイムの crypto.subtle を使用（Node の scrypt は使わない）。

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH = "SHA-256";
const KEY_LEN_BYTES = 32;
const SALT_LEN_BYTES = 16;
const DUMMY_HASH_HEX = "00".repeat(KEY_LEN_BYTES);
const DUMMY_SALT_HEX = "00".repeat(SALT_LEN_BYTES);

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function randomBytes(len: number): Uint8Array {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return buf;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH,
    },
    keyMaterial,
    KEY_LEN_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export interface PasswordRecord {
  hash: string; // hex
  salt: string; // hex
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_LEN_BYTES);
  const derived = await pbkdf2(password, salt);
  return { hash: toHex(derived), salt: toHex(salt) };
}

// タイミング安全比較（長さ・内容ともに定数時間に近づける）。
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function verifyPassword(
  password: string,
  record: { hash: string | null; salt: string | null },
): Promise<boolean> {
  const hasRecord = Boolean(record.hash && record.salt);
  const hash = record.hash ?? DUMMY_HASH_HEX;
  const salt = fromHex(record.salt ?? DUMMY_SALT_HEX);
  const derived = await pbkdf2(password, salt);
  return hasRecord && timingSafeEqual(derived, fromHex(hash));
}

// 高エントロピーなトークン（セッション/招待）。32 bytes = 256bit。
export function generateToken(bytes = 32): string {
  return toHex(randomBytes(bytes));
}

// UUID（D1 の TEXT 主キー用）。
export function uuid(): string {
  return crypto.randomUUID();
}
