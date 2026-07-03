// 新規作成：通常タスク / チェックリスト。「保存して続けて追加」で担当・期限・カテゴリ保持。
import { useMemo, useRef, useState } from "react";
import type { UserDTO, TagDTO } from "../../../src/types";
import { useAuth } from "../auth/AuthContext";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { useRouter } from "../lib/router";
import { TopBar } from "../components/TopBar";
import { initial } from "../lib/avatar";
import { fromDateInputValue } from "../lib/datetime";
import "../components/forms.css";
import "./NewTodoScreen.css";

export function NewTodoScreen() {
  const { me } = useAuth();
  const { navigate } = useRouter();
  const meId = me?.user?.id ?? null;

  const users = useAsync<UserDTO[]>(() => endpoints.users(), []);
  const tags = useAsync<TagDTO[]>(() => endpoints.tags(), []);

  const [title, setTitle] = useState("");
  const [isChecklist, setIsChecklist] = useState(false);
  const [checklistText, setChecklistText] = useState("");
  const [scope, setScope] = useState<"shared" | "private">("shared");
  const [assigneeId, setAssigneeId] = useState<string | null>(meId);
  const [tagId, setTagId] = useState<string | null>(null);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const checklistRef = useRef<HTMLTextAreaElement>(null);

  const effectiveAssignee = scope === "private" ? meId : assigneeId;

  const userList = useMemo(
    () => (users.data ?? []).filter((u) => scope !== "private" || u.id === meId),
    [users.data, scope, meId]
  );

  async function create(): Promise<string | null> {
    const v = title.trim();
    if (!v) return null;
    const items = checklistText
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    const created = await endpoints.createTodo({
      title: v,
      isChecklist,
      visibility: scope,
      assigneeId: effectiveAssignee ?? undefined,
      tagIds: tagId ? [tagId] : [],
      dueDate: fromDateInputValue(due),
      items: isChecklist && items.length > 0 ? items : undefined,
    });
    return created.id;
  }

  async function saveAndOpen() {
    if (busy || !title.trim()) return;
    setBusy(true);
    try {
      const id = await create();
      if (id) navigate(isChecklist ? `/checklists/${id}` : `/todos/${id}`);
    } finally {
      setBusy(false);
    }
  }

  async function saveAndContinue() {
    if (busy || !title.trim()) return;
    setBusy(true);
    try {
      await create();
      // 担当・期限・カテゴリ・公開範囲は保持。入力内容だけクリア。
      setTitle("");
      setChecklistText("");
      setToast("保存しました。続けて追加できます");
      window.setTimeout(() => setToast(null), 1800);
      titleRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="newtodo">
      <TopBar title="新しいタスク" />
      <div className="newtodo-body">
        <div className="type-toggle" role="group" aria-label="タスクの種類">
          <button
            className={`type-btn ${!isChecklist ? "active" : ""}`}
            aria-pressed={!isChecklist}
            onClick={() => setIsChecklist(false)}
          >
            タスク
          </button>
          <button
            className={`type-btn ${isChecklist ? "active" : ""}`}
            aria-pressed={isChecklist}
            onClick={() => setIsChecklist(true)}
          >
            チェックリスト
          </button>
        </div>

        <div className="field">
          <label htmlFor="nt-title">タイトル</label>
          <input
            id="nt-title"
            ref={titleRef}
            className="input"
            placeholder={isChecklist ? "買い物リスト" : "牛乳と卵を買う"}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (isChecklist) {
                  checklistRef.current?.focus();
                  return;
                }
                void saveAndContinue();
              }
            }}
            autoFocus
          />
        </div>

        {isChecklist && (
          <div className="field">
            <label htmlFor="nt-checklist-items">チェック項目</label>
            <textarea
              id="nt-checklist-items"
              ref={checklistRef}
              className="textarea checklist-items-input"
              placeholder={"牛乳\n卵\nパン"}
              value={checklistText}
              onChange={(e) => setChecklistText(e.target.value)}
            />
            <span className="form-note">
              1行に1項目ずつ入力すると、作成時にまとめて登録されます
            </span>
          </div>
        )}

        <div className="field">
          <label>公開範囲</label>
          <div className="segmented" role="group" aria-label="公開範囲">
            <button
              className={`seg-btn ${scope === "shared" ? "active" : ""}`}
              aria-pressed={scope === "shared"}
              onClick={() => setScope("shared")}
            >
              共有
            </button>
            <button
              className={`seg-btn ${scope === "private" ? "active priv" : ""}`}
              aria-pressed={scope === "private"}
              onClick={() => {
                setScope("private");
                setAssigneeId(meId);
              }}
            >
              じぶん
            </button>
          </div>
          <span className="form-note">
            {scope === "private" ? "あなただけに見えます" : "家族みんなに共有します"}
          </span>
        </div>

        <div className="field">
          <label>担当</label>
          <div className="assignee-picker">
            {userList.map((u) => {
              const sel = effectiveAssignee === u.id;
              return (
                <button
                  key={u.id}
                  className={`assignee-chip ${sel ? "active" : ""}`}
                  aria-pressed={sel}
                  onClick={() => setAssigneeId(u.id)}
                  disabled={scope === "private" && u.id !== meId}
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
        </div>

        <div className="field">
          <label htmlFor="nt-due">期限</label>
          <div className="nt-date-field">
            <input
              id="nt-due"
              type="date"
              className="input nt-due-input"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label>カテゴリ</label>
          <div className="cat-picker">
            {(tags.data ?? []).map((tag) => {
              const sel = tagId === tag.id;
              return (
                <button
                  key={tag.id}
                  className={`cat-pick ${sel ? "active" : ""}`}
                  aria-pressed={sel}
                  onClick={() => setTagId(sel ? null : tag.id)}
                >
                  <span className="cat-dot" style={{ background: tag.color }} />
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="newtodo-actions">
          <button
            className="btn btn-ghost btn-block ptb-press"
            onClick={() => void saveAndContinue()}
            disabled={busy || !title.trim()}
          >
            保存して続けて追加
          </button>
          <button
            className="btn btn-primary btn-block ptb-press"
            onClick={() => void saveAndOpen()}
            disabled={busy || !title.trim()}
          >
            {isChecklist ? "作成して項目を追加" : "保存して開く"}
          </button>
        </div>
      </div>

      {toast && <div className="saving-hint">{toast}</div>}
    </div>
  );
}
