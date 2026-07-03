import type { ReactNode } from "react";
import { useRouter } from "../lib/router";
import "./TopBar.css";

// 詳細・作成画面の上部バー（戻る＋タイトル＋右アクション）。
export function TopBar({
  title,
  right,
  backTo,
  backLabel = "戻る",
}: {
  title: string;
  right?: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  const { navigate } = useRouter();
  return (
    <div className="topbar">
      <button
        className="topbar-back"
        aria-label={backLabel}
        onClick={() => {
          if (backTo) {
            navigate(backTo);
            return;
          }
          if (window.history.length > 1) window.history.back();
          else navigate("/");
        }}
      >
        <span aria-hidden="true">‹</span>
        {backTo && <span className="topbar-back-label">一覧へ</span>}
      </button>
      <span className="topbar-title">{title}</span>
      <div className="topbar-right">{right}</div>
    </div>
  );
}
