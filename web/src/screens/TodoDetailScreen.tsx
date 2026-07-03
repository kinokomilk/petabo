// タスク詳細：状態3分割トグル / 担当 / 期限 / カテゴリ / 公開範囲 / コメント / チェックリスト。
import { useEffect, useState } from "react";
import type {
  TodoDTO,
  UserDTO,
  TagDTO,
  CommentDTO,
  TodoStatus,
} from "../../../src/types";
import { useAuth } from "../auth/AuthContext";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { useRouter } from "../lib/router";
import { Avatar } from "../components/Avatar";
import { Spinner, PrivateBadge } from "../components/bits";
import { ChecklistEditor } from "../components/ChecklistEditor";
import { toDateInputValue, fromDateInputValue, formatDateTime } from "../lib/datetime";
import { TopBar } from "../components/TopBar";
import { initial } from "../lib/avatar";
import "./TodoDetailScreen.css";

const STATUS_OPTS: { value: TodoStatus; label: string }[] = [
  { value: "todo", label: "未着手" },
  { value: "doing", label: "進行中" },
  { value: "done", label: "完了" },
];

export function TodoDetailScreen({ todoId }: { todoId: string }) {
  const { me } = useAuth();
  const { navigate } = useRouter();
  const meId = me?.user?.id ?? null;

  const todo = useAsync<TodoDTO>(() => endpoints.todo(todoId), [todoId]);
  const users = useAsync<UserDTO[]>(() => endpoints.users(), []);
  const tags = useAsync<TagDTO[]>(() => endpoints.tags(), []);
  const comments = useAsync<CommentDTO[]>(() => endpoints.comments(todoId), [todoId]);

  const [commentText, setCommentText] = useState("");
  const [saving, setSaving] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    if (todo.data) setTitleDraft(todo.data.title);
  }, [todo.data?.id, todo.data?.title]);

  if (todo.loading) {
    return (
      <div className="detail">
        <TopBar title="タスク" />
        <Spinner />
      </div>
    );
  }
  if (todo.error || !todo.data) {
    return (
      <div className="detail">
        <TopBar title="タスク" />
        <div className="home-error" style={{ margin: 20 }}>
          {todo.error ?? "見つかりませんでした"}
        </div>
      </div>
    );
  }

  const t = todo.data;
  const isCreator = t.creator?.id === meId;
  const isPrivate = t.visibility === "private";

  async function patch(body: Parameters<typeof endpoints.updateTodo>[1]) {
    setSaving(true);
    try {
      const updated = await endpoints.updateTodo(todoId, body);
      todo.setData(() => updated);
    } finally {
      setSaving(false);
    }
  }

  async function addComment() {
    const v = commentText.trim();
    if (!v) return;
    const list = await endpoints.addComment(todoId, { body: v });
    comments.setData(() => list);
    setCommentText("");
  }

  async function saveTitle() {
    const title = titleDraft.trim();
    if (!title || title === todo.data?.title) {
      setTitleDraft(todo.data?.title ?? "");
      return;
    }
    await patch({ title });
  }

  async function toChecklist() {
    setSaving(true);
    try {
      const updated = await endpoints.updateTodo(todoId, { isChecklist: true });
      todo.setData(() => updated);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!window.confirm("このタスクを削除しますか？")) return;
    await endpoints.deleteTodo(todoId);
    navigate("/");
  }

  const currentTagId = t.tags[0]?.id ?? null;

  return (
    <div className="detail">
      <TopBar
        title="タスク"
        backTo="/"
        backLabel="タスク一覧へ戻る"
        right={
          <button className="topbar-action danger" onClick={remove}>
            削除
          </button>
        }
      />

      <div className="detail-body">
        <div className="detail-titlecard">
          <h1 className="sr-only">{t.title}</h1>
          <input
            className="detail-title-input"
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
          {isPrivate && <PrivateBadge />}
        </div>

        {/* 状態 3分割トグル */}
        <section className="detail-block">
          <div className="block-label">状態</div>
          <div className="status-toggle" role="group" aria-label="状態を変更">
            {STATUS_OPTS.map((o) => (
              <button
                key={o.value}
                className={`status-seg ${t.status === o.value ? "active" : ""}`}
                aria-pressed={t.status === o.value}
                onClick={() => patch({ status: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
        </section>

        {/* 公開範囲（作成者のみ shared 化可） */}
        <section className="detail-block">
          <div className="block-label">公開範囲</div>
          <div className="segmented" role="group" aria-label="公開範囲を変更">
            <button
              className={`seg-btn ${t.visibility === "shared" ? "active" : ""}`}
              aria-pressed={t.visibility === "shared"}
              disabled={!isCreator}
              onClick={() => patch({ visibility: "shared" })}
            >
              共有
            </button>
            <button
              className={`seg-btn ${t.visibility === "private" ? "active priv" : ""}`}
              aria-pressed={t.visibility === "private"}
              disabled={!isCreator}
              onClick={() => patch({ visibility: "private", assigneeId: meId })}
            >
              じぶん
            </button>
          </div>
          {!isCreator && (
            <p className="block-note">公開範囲の変更は作成者のみ可能です。</p>
          )}
        </section>

        {/* 担当（タップ選択） */}
        <section className="detail-block">
          <div className="block-label">担当</div>
          <div className="assignee-picker">
            {(users.data ?? [])
              .filter((u) => !isPrivate || u.id === meId)
              .map((u) => {
                const sel = t.assignee?.id === u.id;
                return (
                  <button
                    key={u.id}
                    className={`assignee-chip ${sel ? "active" : ""}`}
                    aria-pressed={sel}
                    onClick={() => patch({ assigneeId: sel ? null : u.id })}
                  >
                    <span
                      className="avatar"
                      style={{ width: 22, height: 22, background: u.color, fontSize: 11 }}
                    >
                      {initial(u.displayName)}
                    </span>
                    {u.displayName}
                  </button>
                );
              })}
          </div>
          {isPrivate && (
            <p className="block-note">非公開タスクは自分専用です（担当は自分のみ）。</p>
          )}
        </section>

        {/* 期限 */}
        <section className="detail-block">
          <div className="block-label">期限</div>
          <div className="detail-date-field">
            <input
              type="date"
              className="input detail-date-input"
              value={toDateInputValue(t.dueDate)}
              onChange={(e) => patch({ dueDate: fromDateInputValue(e.target.value) })}
            />
          </div>
        </section>

        {/* カテゴリ */}
        <section className="detail-block">
          <div className="block-label">カテゴリ</div>
          <div className="cat-picker">
            {(tags.data ?? []).map((tag) => {
              const sel = currentTagId === tag.id;
              return (
                <button
                  key={tag.id}
                  className={`cat-pick ${sel ? "active" : ""}`}
                  aria-pressed={sel}
                  onClick={() => patch({ tagIds: sel ? [] : [tag.id] })}
                >
                  <span className="cat-dot" style={{ background: tag.color }} />
                  {tag.name}
                </button>
              );
            })}
          </div>
        </section>

        {/* チェックリスト */}
        {t.isChecklist ? (
          <section className="detail-block">
            <div className="block-label">チェックリスト</div>
            <ChecklistEditor todoId={todoId} onProgress={todo.reload} />
          </section>
        ) : (
          <section className="detail-block">
            <div className="block-label">チェックリスト</div>
            <button
              className="btn btn-ghost btn-sm ptb-press"
              onClick={() => void toChecklist()}
              disabled={saving}
            >
              チェックリストにする
            </button>
            <p className="block-note">
              小さな手順に分けて、ひとつずつチェックできます。
            </p>
          </section>
        )}

        {/* コメント */}
        <section className="detail-block">
          <div className="block-label">コメント</div>
          <div className="comment-list">
            {comments.loading ? (
              <Spinner />
            ) : (comments.data ?? []).length === 0 ? (
              <p className="block-note">まだコメントはありません。</p>
            ) : (
              (comments.data ?? []).map((c) => (
                <div key={c.id} className="comment-item">
                  <Avatar
                    name={c.user?.displayName ?? "?"}
                    color={c.user?.color ?? "var(--muted)"}
                    size={26}
                  />
                  <div className="comment-bubble">
                    <div className="comment-meta">
                      <span className="comment-name">
                        {c.user?.displayName ?? "（退出メンバー）"}
                      </span>
                      <span className="comment-time">{formatDateTime(c.createdAt)}</span>
                    </div>
                    <div className="comment-body">{c.body}</div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="comment-compose">
            <input
              className="input"
              placeholder="コメントを書く…"
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addComment();
                }
              }}
            />
            <button
              className="btn btn-primary btn-sm ptb-press"
              onClick={() => void addComment()}
              disabled={!commentText.trim()}
            >
              送信
            </button>
          </div>
        </section>

        {saving && <div className="saving-hint">保存中…</div>}
      </div>
    </div>
  );
}
