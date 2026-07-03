// チェックリスト詳細：タイトル＋進捗＋ChecklistEditor（Enter連続追加・改行一括・タップで done）。
import { useEffect, useState } from "react";
import type { TodoDTO } from "../../../src/types";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { Link } from "../lib/router";
import { TopBar } from "../components/TopBar";
import { ChecklistEditor } from "../components/ChecklistEditor";
import { Spinner, PrivateBadge } from "../components/bits";
import "./ChecklistDetailScreen.css";

export function ChecklistDetailScreen({ todoId }: { todoId: string }) {
  const todo = useAsync<TodoDTO>(() => endpoints.todo(todoId), [todoId]);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    if (todo.data) setTitleDraft(todo.data.title);
  }, [todo.data?.id, todo.data?.title]);

  async function saveTitle() {
    const title = titleDraft.trim();
    if (!title || title === todo.data?.title) {
      setTitleDraft(todo.data?.title ?? "");
      return;
    }
    const updated = await endpoints.updateTodo(todoId, { title });
    todo.setData(() => updated);
  }

  if (todo.loading) {
    return (
      <div className="cldetail">
        <TopBar title="チェックリスト" />
        <Spinner />
      </div>
    );
  }
  if (todo.error || !todo.data) {
    return (
      <div className="cldetail">
        <TopBar title="チェックリスト" />
        <div className="home-error" style={{ margin: 20 }}>
          {todo.error ?? "見つかりませんでした"}
        </div>
      </div>
    );
  }

  const t = todo.data;

  return (
    <div className="cldetail">
      <TopBar
        title="チェックリスト"
        backTo="/"
        backLabel="タスク一覧へ戻る"
        right={
          <Link to={`/todos/${t.id}`} className="topbar-action">
            詳細
          </Link>
        }
      />
      <div className="cldetail-body">
        <div className="cldetail-head">
          <h1 className="sr-only">{t.title}</h1>
          <input
            className="cldetail-title-input"
            aria-label="タスク名"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                setTitleDraft(t.title);
                event.currentTarget.blur();
              }
            }}
          />
          {t.visibility === "private" && <PrivateBadge />}
        </div>
        <ChecklistEditor todoId={todoId} />
      </div>
    </div>
  );
}
