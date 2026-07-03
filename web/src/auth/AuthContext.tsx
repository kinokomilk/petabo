// 認証コンテキスト。me 取得とローディング/未認証/未参加/参加済の分岐をまとめる。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { MeDTO } from "../../../src/types";
import { endpoints } from "../api/endpoints";
import { tryLiffLogin } from "./liff";

export type AuthStatus =
  | "loading"
  | "anonymous" // 未認証
  | "unjoined" // 認証済だが未参加（joinState === 'none'）
  | "active"; // 参加済

interface AuthValue {
  status: AuthStatus;
  me: MeDTO | null;
  refresh: () => Promise<MeDTO | null>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

function deriveStatus(me: MeDTO | null): AuthStatus {
  if (!me) return "anonymous";
  if (!me.authenticated) return "anonymous";
  if (me.joinState === "active") return "active";
  return "unjoined";
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const refresh = useCallback(async () => {
    try {
      const next = await endpoints.me();
      setMe(next);
      setStatus(deriveStatus(next));
      return next;
    } catch {
      // me は 401 を返さない設計（guest を返す）が、念のため anonymous 扱い。
      setMe(null);
      setStatus("anonymous");
      return null;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await endpoints.logout();
    } finally {
      setMe(null);
      setStatus("anonymous");
    }
  }, []);

  useEffect(() => {
    // 起動時: LINE 内（LIFF）ならまずサーバ側でセッションを確立してから me を取得する。
    // LINE 外 / LIFF_ID 未設定 / SDK 読込失敗では tryLiffLogin は何もせず false を返し、
    // 通常の Web ログインフローへフォールバックする（refresh が anonymous を返すだけ）。
    void (async () => {
      await tryLiffLogin();
      await refresh();
    })();
  }, [refresh]);

  return (
    <Ctx.Provider value={{ status, me, refresh, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used within AuthProvider");
  return v;
}
