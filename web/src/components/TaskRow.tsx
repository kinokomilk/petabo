import { useState } from "react";
import type { ChecklistItemDTO, TodoDTO } from "../../../src/types";
import { Avatar } from "./Avatar";
import { Checkbox } from "./Checkbox";
import { DuePill, PrivateBadge } from "./bits";
import { Link } from "../lib/router";
import { TaskChecklistPreview } from "./TaskChecklistPreview";
import "./TaskRow.css";

interface TaskRowProps {
  todo: TodoDTO;
  onToggleDone: (todo: TodoDTO) => void;
  onToggleStar: (todo: TodoDTO) => void;
  onChecklistItemToggle: (todoId: string, item: ChecklistItemDTO) => void;
  justAdded?: boolean;
}

// petabo のタスク行：丸チェック｜タイトル｜右端スター。メタ＝担当/期限/カテゴリ/private。
export function TaskRow({
  todo,
  onToggleDone,
  onToggleStar,
  onChecklistItemToggle,
  justAdded,
}: TaskRowProps) {
  const done = todo.status === "done";
  const doing = todo.status === "doing";
  const starred = todo.isImportant;
  const [flash, setFlash] = useState(false);

  function handleToggle() {
    if (!done) {
      setFlash(true);
      window.setTimeout(() => setFlash(false), 700);
    }
    onToggleDone(todo);
  }

  const primaryTag = todo.tags[0];
  const hasChecklist = todo.isChecklist && todo.checklist.total > 0;

  return (
    <div className={`task-entry ${done ? "is-done" : ""} ${justAdded ? "just-added" : ""}`}>
      <div className="task-row">
        <div className={flash ? "task-check-flash" : undefined}>
          <Checkbox
            checked={done}
            onToggle={handleToggle}
            variant="round"
            label={`${todo.title} を${done ? "未完了" : "完了"}にする`}
          />
        </div>

        <Link to={`/todos/${todo.id}`} className="task-main">
          <div className="task-title-wrap">
            <span className="task-title">{todo.title}</span>
            {done && <span className="strike" aria-hidden="true" />}
          </div>

          <div className="task-meta">
            {todo.assignee && (
              <span className="meta-assignee">
                <Avatar
                  name={todo.assignee.displayName}
                  color={todo.assignee.color}
                  size={20}
                />
                <span className="meta-name">{todo.assignee.displayName}</span>
              </span>
            )}
            <DuePill dueDate={todo.dueDate} />
            {doing && <span className="status-chip status-chip-doing">進行中</span>}
            {primaryTag && (
              <span className="cat-chip">
                <span className="cat-dot" style={{ background: primaryTag.color }} />
                {primaryTag.name}
              </span>
            )}
            {todo.visibility === "private" && <PrivateBadge />}
            {hasChecklist && (
              <span className="meta-sub">
                チェックリスト {todo.checklist.done}/{todo.checklist.total}
              </span>
            )}
            {todo.commentCount > 0 && (
              <span className="meta-sub">💬 {todo.commentCount}</span>
            )}
          </div>
        </Link>

        <button
          type="button"
          className="star-btn ptb-press"
          aria-pressed={starred}
          aria-label={starred ? "重要を解除" : "重要にする"}
          onClick={() => onToggleStar(todo)}
          style={{ color: starred ? "var(--star)" : "var(--line-2)" }}
        >
          ★
        </button>
      </div>
      {hasChecklist && !done && (
        <TaskChecklistPreview
          items={todo.checklistItems}
          onToggle={(item) => onChecklistItemToggle(todo.id, item)}
        />
      )}
    </div>
  );
}
