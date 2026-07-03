// fetch ラッパ。Cookie セッション認証なので credentials:'include' を必須にする。
// 共有型はモノレポ親の src/types.ts を import（重複定義しない）。

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// 401（未認証）を上位（AuthContext）が拾えるよう専用クラス。
export class UnauthorizedError extends ApiError {
  constructor(message = "unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

const BASE = "/api";

// 送信ボディ。任意の JSON シリアライズ可能な値を許容する。
type JsonBody = unknown;

async function request<T>(
  method: string,
  path: string,
  body?: JsonBody
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "include", // Cookie 同送（HttpOnly セッション）
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "ネットワークに接続できませんでした");
  }

  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      (data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : null) || `エラーが発生しました (${res.status})`;
    if (res.status === 401) throw new UnauthorizedError(message);
    throw new ApiError(res.status, message);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: JsonBody) =>
    request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: JsonBody) =>
    request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
};
