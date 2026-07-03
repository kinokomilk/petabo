// in-app リマインダー。reminders API の overdue=赤 / dueSoon=オレンジで色分け表示。
import type { RemindersDTO } from "../../../src/types";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { Link } from "../lib/router";
import "./ReminderBanner.css";

export function ReminderBanner() {
  const { data } = useAsync<RemindersDTO>(() => endpoints.reminders(), []);
  if (!data) return null;
  const overdue = data.overdue ?? [];
  const dueSoon = data.dueSoon ?? [];
  if (overdue.length === 0 && dueSoon.length === 0) return null;
  const overdueTarget = overdue.length === 1 ? `/todos/${overdue[0].id}` : "/";
  const dueSoonTarget = dueSoon.length === 1 ? `/todos/${dueSoon[0].id}` : "/";

  return (
    <div className="reminder-wrap">
      {overdue.length > 0 && (
        <div className="reminder overdue">
          <span className="rm-dot" aria-hidden="true" />
          <span className="rm-text">
            期限切れが <b>{overdue.length}</b> 件あります
          </span>
          <Link to={overdueTarget} className="rm-link">
            {overdue.length === 1 ? "確認" : "一覧"}
          </Link>
        </div>
      )}
      {dueSoon.length > 0 && (
        <div className="reminder soon">
          <span className="rm-dot" aria-hidden="true" />
          <span className="rm-text">
            まもなく期限が <b>{dueSoon.length}</b> 件
          </span>
          <Link to={dueSoonTarget} className="rm-link">
            {dueSoon.length === 1 ? "確認" : "一覧"}
          </Link>
        </div>
      )}
    </div>
  );
}
