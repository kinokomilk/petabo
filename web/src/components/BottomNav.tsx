import { Link } from "../lib/router";
import "./BottomNav.css";

// petabo 下部ナビ。Phase 1 では「今日」がアクティブ。他は将来画面（設定のみ実体あり）。
export function BottomNav({
  active,
}: {
  active: "today" | "members" | "activity" | "settings";
  allCount?: number;
}) {
  return (
    <nav className="bottom-nav" aria-label="メインナビ">
      <Link to="/" className={`nav-item ${active === "today" ? "active" : ""}`}>
        今日
      </Link>
      <span className="nav-item disabled">みんな</span>
      <Link to="/new" className="nav-add" aria-label="新規作成">
        ＋
      </Link>
      <span className="nav-item disabled">アクティビティ</span>
      <Link
        to="/settings"
        className={`nav-item ${active === "settings" ? "active" : ""}`}
      >
        設定
      </Link>
    </nav>
  );
}
