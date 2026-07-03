// リッチメニュー管理エンドポイント + areas/actions + postback 連携のテスト
// （Phase 3 / Wave 2-a）。
//
// 観点:
//   - POST /api/line/richmenu/setup はオーナーのみ（401 未認証 / 403 非オーナー /
//     503 LINE 未設定）。成功時は create→upload→setDefault を順に呼ぶ。
//   - DELETE /api/line/richmenu はオーナーのみ。デフォルトを削除する。
//   - リッチメニュー API は mock（fetch を呼ばない）。秘密（access token）が
//     応答に出ない。
//   - areas/actions（buildRichMenuDefinition）が画像座標と一致し、action が
//     postback/URI のみ・秘密を含まない。
//   - リッチメニュー postback（action=list / action=list&filter=today /
//     action=addprompt）が一覧処理・追加導線に正しく繋がる（private 隔離は
//     listTodos 経由）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import app from "../src/index";
import { testEnv, seedHousehold, seedMember } from "./helpers";
import type { Env } from "../src/env";
import type { LineRichMenuApi, RichMenuDefinition } from "../src/line/api";
import {
  __setRichMenuApiFactoryForTest,
  __setImageFetcherForTest,
} from "../src/routes/lineRichMenu";
import { buildRichMenuDefinition } from "../src/line/richmenu";
import { createLineRichMenuApi, LineApiError } from "../src/line/api";

const CHANNEL_SECRET = "rm-channel-secret";
const CHANNEL_ACCESS_TOKEN = "rm-access-token-SECRET";
const APP_BASE_URL = "https://petabo.example";

function lineEnv(): Env {
  return {
    ...testEnv(),
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_CHANNEL_ACCESS_TOKEN: CHANNEL_ACCESS_TOKEN,
    APP_BASE_URL,
  };
}

// LINE 未設定の env（503 検証用）。
function noLineEnv(): Env {
  return { ...testEnv() };
}

// owner cookie 付きで app を叩く（env を差し込む）。
async function callRichMenu(
  method: string,
  path: string,
  opts: { session?: string; env?: Env; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.session) headers["cookie"] = `petabo_session=${opts.session}`;
  // CSRF ミドルウェアは Origin / sec-fetch-site が無ければ通す（サーバ間呼び出し相当）。
  // クロスサイト検証は authz.test.ts で別途担保。ここでは認可（owner）と LINE 連携に集中。
  if (opts.origin) headers["origin"] = opts.origin;
  return app.request(
    path,
    { method, headers },
    (opts.env ?? lineEnv()) as unknown as Record<string, unknown>,
  );
}

// 呼び出しを記録する mock API（fetch を呼ばない）。
interface RmCalls {
  created: RichMenuDefinition[];
  uploaded: { id: string; bytes: number; contentType: string }[];
  defaulted: string[];
  deleted: string[];
  getDefaultReturns: string | null;
}
let rm: RmCalls;
let restoreApi: () => void;
let restoreImg: () => void;

function mockApi(): LineRichMenuApi {
  return {
    async createRichMenu(def) {
      rm.created.push(def);
      return "richmenu-mock-id";
    },
    async uploadRichMenuImage(id, image, contentType) {
      rm.uploaded.push({ id, bytes: image.byteLength, contentType });
    },
    async setDefaultRichMenu(id) {
      rm.defaulted.push(id);
    },
    async getDefaultRichMenuId() {
      return rm.getDefaultReturns;
    },
    async deleteRichMenu(id) {
      rm.deleted.push(id);
    },
  };
}

beforeEach(() => {
  rm = {
    created: [],
    uploaded: [],
    defaulted: [],
    deleted: [],
    getDefaultReturns: null,
  };
  restoreApi = __setRichMenuApiFactoryForTest(() => mockApi());
  // 画像取得も mock（実 fetch を避ける。256byte の擬似 png）。
  restoreImg = __setImageFetcherForTest(async () => ({
    ok: true,
    status: 200,
    contentType: "image/png",
    body: new ArrayBuffer(256),
  }));
});
afterEach(() => {
  restoreApi();
  restoreImg();
});

describe("POST /api/line/richmenu/setup の認可", () => {
  it("未認証は 401", async () => {
    const res = await callRichMenu("POST", "/api/line/richmenu/setup");
    expect(res.status).toBe(401);
    expect(rm.created.length).toBe(0);
  });

  it("非オーナー（member）は 403", async () => {
    const hh = await seedHousehold("rm非owner家");
    const member = await seedMember(hh.householdId, "メンバー");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: member.session,
    });
    expect(res.status).toBe(403);
    expect(rm.created.length).toBe(0);
  });

  it("LINE 未設定は 503（副作用なし）", async () => {
    const hh = await seedHousehold("rm未設定家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
      env: noLineEnv(),
    });
    expect(res.status).toBe(503);
    expect(rm.created.length).toBe(0);
  });
});

describe("POST /api/line/richmenu/setup の成功フロー", () => {
  it("owner は create→upload→setDefault を順に呼び、秘密は応答に出ない", async () => {
    const hh = await seedHousehold("rm登録家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; richMenuId: string }>();
    expect(body.ok).toBe(true);
    expect(body.richMenuId).toBe("richmenu-mock-id");

    // 3 ステップが順に実行される。
    expect(rm.created.length).toBe(1);
    expect(rm.uploaded.length).toBe(1);
    expect(rm.defaulted).toEqual(["richmenu-mock-id"]);
    expect(rm.uploaded[0]).toMatchObject({
      id: "richmenu-mock-id",
      bytes: 256,
      contentType: "image/png",
    });

    // areas/actions が画像座標（2500×1686, 2x2）と一致する。
    const def = rm.created[0];
    expect(def.size).toEqual({ width: 2500, height: 1686 });
    expect(def.areas.length).toBe(4);
    const datas = def.areas.map((a) =>
      a.action.type === "postback"
        ? a.action.data
        : a.action.type === "uri"
          ? a.action.uri
          : null,
    );
    expect(datas).toContain("action=list");
    expect(datas).toContain("action=list&filter=today");
    expect(datas).toContain("action=addprompt");
    expect(datas).toContain(APP_BASE_URL);

    // 秘密（access token）が応答 JSON に出ない。
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(CHANNEL_ACCESS_TOKEN);
    expect(raw).not.toContain(CHANNEL_SECRET);
  });

  it("再実行は既存デフォルトを削除してから作成する（冪等化）", async () => {
    // 既存のデフォルトリッチメニューがある状態。
    rm.getDefaultReturns = "old-rm-id";
    const hh = await seedHousehold("rm冪等家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    // 旧メニューを削除してから新規作成。
    expect(rm.deleted).toEqual(["old-rm-id"]);
    expect(rm.created.length).toBe(1);
    expect(rm.defaulted).toEqual(["richmenu-mock-id"]);
  });

  it("既存デフォルト取得が失敗しても作成は続行する（404/未設定を握る）", async () => {
    restoreApi();
    restoreApi = __setRichMenuApiFactoryForTest(() => ({
      ...mockApi(),
      async getDefaultRichMenuId() {
        throw new LineApiError("not found", 404);
      },
    }));
    const hh = await seedHousehold("rm冪等握り家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    expect(rm.created.length).toBe(1);
    expect(rm.defaulted).toEqual(["richmenu-mock-id"]);
  });

  it("画像 content-type が png/jpeg でなければ 502（作成しない）", async () => {
    restoreImg();
    restoreImg = __setImageFetcherForTest(async () => ({
      ok: true,
      status: 200,
      contentType: "text/html",
      body: new ArrayBuffer(256),
    }));
    const hh = await seedHousehold("rm誤contenttype家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(502);
    expect(rm.created.length).toBe(0);
    expect(rm.uploaded.length).toBe(0);
  });

  it("LIFF_ID 設定時は連携設定が LIFF URL になる", async () => {
    const hh = await seedHousehold("rmLIFF家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
      env: { ...lineEnv(), LIFF_ID: "1234-abcd" },
    });
    expect(res.status).toBe(200);
    const settings = rm.created[0].areas.find((a) => a.bounds.x === 1250 && a.bounds.y === 843)
      ?.action;
    expect(settings?.type === "uri" && settings.uri).toBe(
      "https://liff.line.me/1234-abcd",
    );
  });

  it("画像取得に失敗すると 502（作成しない）", async () => {
    restoreImg();
    restoreImg = __setImageFetcherForTest(async () => ({
      ok: false,
      status: 404,
      contentType: "image/png",
      body: new ArrayBuffer(0),
    }));
    const hh = await seedHousehold("rm画像失敗家");
    const res = await callRichMenu("POST", "/api/line/richmenu/setup", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(502);
    expect(rm.created.length).toBe(0);
  });
});

describe("DELETE /api/line/richmenu", () => {
  it("非オーナーは 403", async () => {
    const hh = await seedHousehold("rm削除非owner家");
    const member = await seedMember(hh.householdId, "メンバー");
    const res = await callRichMenu("DELETE", "/api/line/richmenu", {
      session: member.session,
    });
    expect(res.status).toBe(403);
  });

  it("デフォルトがあれば削除する", async () => {
    rm.getDefaultReturns = "current-rm-id";
    const hh = await seedHousehold("rm削除家");
    const res = await callRichMenu("DELETE", "/api/line/richmenu", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; richMenuId?: string }>();
    expect(body.deleted).toBe(true);
    expect(rm.deleted).toEqual(["current-rm-id"]);
  });

  it("デフォルト未設定なら deleted:false（削除しない）", async () => {
    rm.getDefaultReturns = null;
    const hh = await seedHousehold("rm削除なし家");
    const res = await callRichMenu("DELETE", "/api/line/richmenu", {
      session: hh.ownerSession,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean }>();
    expect(body.deleted).toBe(false);
    expect(rm.deleted.length).toBe(0);
  });
});

describe("buildRichMenuDefinition（areas/actions 定義）", () => {
  it("2x2 の bounds が画像分割と一致し、action は postback/URI のみ・秘密を含まない", () => {
    const def = buildRichMenuDefinition(APP_BASE_URL);
    expect(def.size).toEqual({ width: 2500, height: 1686 });
    // 4 領域、それぞれ 1250×843。
    for (const a of def.areas) {
      expect(a.bounds.width).toBe(1250);
      expect(a.bounds.height).toBe(843);
      expect(["postback", "uri"]).toContain(a.action.type);
    }
    // 左上=一覧 / 右上=きょう / 左下=メモ / 右下=連携設定 の座標。
    const at = (x: number, y: number) =>
      def.areas.find((a) => a.bounds.x === x && a.bounds.y === y)?.action;
    const list = at(0, 0);
    const today = at(1250, 0);
    const memo = at(0, 843);
    const settings = at(1250, 843);
    expect(list?.type === "postback" && list.data).toBe("action=list");
    expect(today?.type === "postback" && today.data).toBe(
      "action=list&filter=today",
    );
    expect(memo?.type === "postback" && memo.data).toBe("action=addprompt");
    expect(settings?.type === "uri" && settings.uri).toBe(APP_BASE_URL);
    // 秘密値が定義に紛れ込まない。
    expect(JSON.stringify(def)).not.toContain(CHANNEL_ACCESS_TOKEN);
  });

  it("liffId 未指定なら連携設定は APP_BASE_URL、指定時は LIFF URL", () => {
    const noLiff = buildRichMenuDefinition(APP_BASE_URL);
    const settingsNo = noLiff.areas.find(
      (a) => a.bounds.x === 1250 && a.bounds.y === 843,
    )?.action;
    expect(settingsNo?.type === "uri" && settingsNo.uri).toBe(APP_BASE_URL);

    const withLiff = buildRichMenuDefinition(APP_BASE_URL, "9999-xyz");
    const settingsLiff = withLiff.areas.find(
      (a) => a.bounds.x === 1250 && a.bounds.y === 843,
    )?.action;
    expect(settingsLiff?.type === "uri" && settingsLiff.uri).toBe(
      "https://liff.line.me/9999-xyz",
    );
  });
});

describe("createLineRichMenuApi（fetch ラッパ・mock）", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("create は richMenuId を返し、Bearer トークンを Authorization に載せる", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth =
        (init?.headers as Record<string, string> | undefined)?.[
          "authorization"
        ] ?? null;
      return new Response(JSON.stringify({ richMenuId: "id-123" }), {
        status: 200,
      });
    }) as typeof fetch;

    const api = createLineRichMenuApi(CHANNEL_ACCESS_TOKEN);
    const id = await api.createRichMenu(buildRichMenuDefinition(APP_BASE_URL));
    expect(id).toBe("id-123");
    expect(seenUrl).toContain("/v2/bot/richmenu");
    expect(seenAuth).toBe(`Bearer ${CHANNEL_ACCESS_TOKEN}`);
  });

  it("LINE エラー時は LineApiError(status) を投げ、メッセージに秘密を含めない", async () => {
    globalThis.fetch = (async () =>
      new Response("body", { status: 400 })) as typeof fetch;
    const api = createLineRichMenuApi(CHANNEL_ACCESS_TOKEN);
    await expect(
      api.createRichMenu(buildRichMenuDefinition(APP_BASE_URL)),
    ).rejects.toMatchObject({ status: 400 });
    try {
      await api.createRichMenu(buildRichMenuDefinition(APP_BASE_URL));
    } catch (e) {
      expect(e).toBeInstanceOf(LineApiError);
      expect((e as Error).message).not.toContain(CHANNEL_ACCESS_TOKEN);
    }
  });

  it("getDefaultRichMenuId は 404 を null として返す", async () => {
    globalThis.fetch = (async () =>
      new Response("", { status: 404 })) as typeof fetch;
    const api = createLineRichMenuApi(CHANNEL_ACCESS_TOKEN);
    expect(await api.getDefaultRichMenuId()).toBeNull();
  });
});
