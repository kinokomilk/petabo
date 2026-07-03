// ID トークン自前検証（src/line/idToken.ts）のユニットテスト。
// 実鍵で ES256/HS256 署名し、JWKS(/certs) を mock して検証する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyIdTokenLocally,
  IdTokenSignatureError,
  IdTokenClaimError,
  IdTokenUnavailableError,
  __clearJwksCacheForTest,
} from "../src/line/idToken";
import {
  generateEs256Key,
  jwksDocument,
  signEs256,
  signHs256,
  tamperSignature,
  type Es256TestKey,
} from "./jwt";

const CHANNEL_ID = "1234567890";
const CHANNEL_SECRET = "login-channel-secret";
const CERTS_URL = "https://api.line.me/oauth2/v2.1/certs";

function validClaims(sub: string, over: Record<string, unknown> = {}) {
  return {
    iss: "https://access.line.me",
    sub,
    aud: CHANNEL_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    ...over,
  };
}

// /certs を返す mock。fetchCount で呼び出し回数を観測できる。
function installCertsMock(
  doc: { keys: unknown[] } | { fail: number } | { throws: true },
): { fetchCount: () => number } {
  let count = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === CERTS_URL) {
        count++;
        if ("throws" in doc) throw new Error("network");
        if ("fail" in doc) return new Response("err", { status: doc.fail });
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  );
  return { fetchCount: () => count };
}

let key: Es256TestKey;

beforeEach(async () => {
  __clearJwksCacheForTest();
  key = await generateEs256Key("kid-primary");
});
afterEach(() => vi.restoreAllMocks());

describe("ES256（JWKS）検証", () => {
  it("署名 OK → payload を返す", async () => {
    installCertsMock(jwksDocument([key]));
    const jwt = await signEs256(key, validClaims("Ues"));
    const payload = await verifyIdTokenLocally({
      idToken: jwt,
      channelId: CHANNEL_ID,
      channelSecret: CHANNEL_SECRET,
    });
    expect(payload.sub).toBe("Ues");
    expect(payload.aud).toBe(CHANNEL_ID);
  });

  it("署名改ざん → IdTokenSignatureError（reject・フォールバックしない）", async () => {
    installCertsMock(jwksDocument([key]));
    const jwt = tamperSignature(await signEs256(key, validClaims("Utamper")));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenSignatureError);
  });

  it("別鍵で署名（公開鍵不一致）→ IdTokenSignatureError", async () => {
    const other = await generateEs256Key("kid-primary"); // 同じ kid だが別鍵
    installCertsMock(jwksDocument([key]));
    const jwt = await signEs256(other, validClaims("Uother"));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenSignatureError);
  });

  it("kid 不一致 → JWKS 再取得しても見つからず IdTokenUnavailableError（フォールバック対象）", async () => {
    const mock = installCertsMock(jwksDocument([key]));
    const jwt = await signEs256(key, validClaims("Ukid"), { kid: "kid-missing" });
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenUnavailableError);
    // 1 回目（キャッシュ）+ 強制リロードで 2 回 fetch される。
    expect(mock.fetchCount()).toBe(2);
  });

  it("JWKS 取得失敗（5xx）→ IdTokenUnavailableError（フォールバック対象）", async () => {
    installCertsMock({ fail: 503 });
    const jwt = await signEs256(key, validClaims("Ujwks"));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenUnavailableError);
  });

  it("JWKS 取得失敗（throw）→ IdTokenUnavailableError", async () => {
    installCertsMock({ throws: true });
    const jwt = await signEs256(key, validClaims("Ujwks2"));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenUnavailableError);
  });

  it("JWKS はキャッシュされ、2 回目は再 fetch しない", async () => {
    const mock = installCertsMock(jwksDocument([key]));
    const a = await signEs256(key, validClaims("Uc1"));
    const b = await signEs256(key, validClaims("Uc2"));
    await verifyIdTokenLocally({
      idToken: a,
      channelId: CHANNEL_ID,
      channelSecret: CHANNEL_SECRET,
    });
    await verifyIdTokenLocally({
      idToken: b,
      channelId: CHANNEL_ID,
      channelSecret: CHANNEL_SECRET,
    });
    expect(mock.fetchCount()).toBe(1);
  });
});

describe("HS256（channel secret）検証", () => {
  it("署名 OK → payload を返す（fetch しない）", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const jwt = await signHs256(CHANNEL_SECRET, validClaims("Uhs"));
    const payload = await verifyIdTokenLocally({
      idToken: jwt,
      channelId: CHANNEL_ID,
      channelSecret: CHANNEL_SECRET,
    });
    expect(payload.sub).toBe("Uhs");
    expect(spy).not.toHaveBeenCalled();
  });

  it("署名 NG（別 secret）→ IdTokenSignatureError", async () => {
    const jwt = await signHs256("wrong-secret", validClaims("Uhsng"));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenSignatureError);
  });

  it("署名改ざん → IdTokenSignatureError", async () => {
    const jwt = tamperSignature(await signHs256(CHANNEL_SECRET, validClaims("Uhst")));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenSignatureError);
  });
});

describe("claims 検証（署名 OK 後）", () => {
  it("exp 切れ → IdTokenClaimError", async () => {
    const jwt = await signHs256(
      CHANNEL_SECRET,
      validClaims("Uexp", { exp: Math.floor(Date.now() / 1000) - 10 }),
    );
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenClaimError);
  });

  it("aud 不正 → IdTokenClaimError", async () => {
    const jwt = await signHs256(
      CHANNEL_SECRET,
      validClaims("Uaud", { aud: "other-channel" }),
    );
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenClaimError);
  });

  it("iss 不正 → IdTokenClaimError", async () => {
    const jwt = await signHs256(
      CHANNEL_SECRET,
      validClaims("Uiss", { iss: "https://evil.example" }),
    );
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenClaimError);
  });

  it("nonce 不一致 → IdTokenClaimError", async () => {
    const jwt = await signHs256(
      CHANNEL_SECRET,
      validClaims("Unonce", { nonce: "actual-nonce" }),
    );
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
        nonce: "expected-nonce",
      }),
    ).rejects.toBeInstanceOf(IdTokenClaimError);
  });

  it("nonce 一致 → OK", async () => {
    const jwt = await signHs256(
      CHANNEL_SECRET,
      validClaims("Unonce2", { nonce: "match" }),
    );
    const payload = await verifyIdTokenLocally({
      idToken: jwt,
      channelId: CHANNEL_ID,
      channelSecret: CHANNEL_SECRET,
      nonce: "match",
    });
    expect(payload.sub).toBe("Unonce2");
  });

  it("sub 空 → IdTokenClaimError", async () => {
    const jwt = await signHs256(CHANNEL_SECRET, validClaims("", { sub: "" }));
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenClaimError);
  });
});

describe("形式・未対応 alg", () => {
  it("3 パートでない → IdTokenSignatureError", async () => {
    await expect(
      verifyIdTokenLocally({
        idToken: "not-a-jwt",
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenSignatureError);
  });

  it("未対応 alg（RS256）→ IdTokenUnavailableError（フォールバック対象）", async () => {
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const payload = btoa(JSON.stringify(validClaims("Urs")))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const jwt = `${header}.${payload}.AAAA`;
    await expect(
      verifyIdTokenLocally({
        idToken: jwt,
        channelId: CHANNEL_ID,
        channelSecret: CHANNEL_SECRET,
      }),
    ).rejects.toBeInstanceOf(IdTokenUnavailableError);
  });
});
