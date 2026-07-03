// 依存ゼロの最小ルータ（History API）。SPA フォールバックは Worker 側で対応済み。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import type { ReactNode } from "react";

interface RouterValue {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const Ctx = createContext<RouterValue | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) {
      window.history.replaceState({}, "", to);
    } else {
      window.history.pushState({}, "", to);
    }
    setPath(to.split("?")[0]);
    window.scrollTo(0, 0);
  }, []);

  return <Ctx.Provider value={{ path, navigate }}>{children}</Ctx.Provider>;
}

export function useRouter(): RouterValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRouter must be used within RouterProvider");
  return v;
}

// /join/:token を取り出すヘルパー。
export function matchJoin(path: string): string | null {
  const m = path.match(/^\/join\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// /todos/:id を取り出すヘルパー。
export function matchTodo(path: string): string | null {
  const m = path.match(/^\/todos\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// 内部リンク。modifier クリックや別タブはブラウザに任せる。
export function Link({
  to,
  className,
  children,
  replace,
}: {
  to: string;
  className?: string;
  children: ReactNode;
  replace?: boolean;
}) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (
          e.defaultPrevented ||
          e.button !== 0 ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.altKey
        ) {
          return;
        }
        e.preventDefault();
        navigate(to, { replace });
      }}
    >
      {children}
    </a>
  );
}
