// クイック追加：入力→Enter で即追加。担当は自分を既定にし、カテゴリ・公開範囲は前回値を引き継ぐ。
import { useMemo, useRef, useState } from "react";
import type { TodoDTO, UserDTO, TagDTO } from "../../../src/types";
import { endpoints } from "../api/endpoints";
import { initial } from "../lib/avatar";
import { loadQuickPrefs, saveQuickPrefs } from "../lib/prefs";
import "./QuickAdd.css";

interface QuickAddProps {
  meUser: UserDTO | null;
  users: UserDTO[];
  tags: TagDTO[];
  onAdded: (created: TodoDTO) => void;
}

export function QuickAdd({ meUser, users, tags, onAdded }: QuickAddProps) {
  const initialPrefs = useMemo(() => loadQuickPrefs(), []);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"shared" | "private">(initialPrefs.scope);
  const [assigneeId, setAssigneeId] = useState<string | null>(
    meUser?.id ?? null
  );
  const [tagId, setTagId] = useState<string | null>(initialPrefs.tagId);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // private のときは担当＝自分（自分専用）。
  const effectiveAssignee =
    scope === "private"
      ? meUser
      : users.find((u) => u.id === assigneeId) ?? meUser;
  const effectiveTag = tags.find((t) => t.id === tagId) ?? null;

  function cycleWho() {
    if (users.length === 0) return;
    const idx = users.findIndex((u) => u.id === (assigneeId ?? meUser?.id));
    const next = users[(idx + 1) % users.length];
    setAssigneeId(next.id);
  }

  async function add() {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    const who = scope === "private" ? meUser?.id ?? null : effectiveAssignee?.id ?? null;
    try {
      const created = await endpoints.createTodo({
        title: v,
        visibility: scope,
        assigneeId: who,
        tagIds: effectiveTag ? [effectiveTag.id] : [],
        dueDate: new Date().toISOString(), // クイック追加は「今日」に置く
      });
      // 前回値を保存（カテゴリ・公開範囲の引き継ぎ用）。
      saveQuickPrefs({ assigneeId: who, tagId: effectiveTag?.id ?? null, scope });
      setText("");
      onAdded(created);
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="quick-add" aria-label="タスクを追加">
      <div className="qa-bar">
        <input
          ref={inputRef}
          className="qa-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="やることをペタッと追加…"
          aria-label="やることを追加"
        />
        <button
          type="button"
          className="qa-add ptb-add"
          aria-label="追加"
          onClick={() => void add()}
          disabled={busy || !text.trim()}
        >
          ＋
        </button>
      </div>

      <div className="qa-controls">
        <div className="qa-field">
          <span className="qa-field-label">担当</span>
          <button
            type="button"
            className="qa-assignee ptb-press"
            aria-label={`担当: ${effectiveAssignee?.displayName ?? "未設定"}（タップで切替）`}
            onClick={cycleWho}
            disabled={scope === "private"}
          >
            <span
              className="qa-who"
              style={{ background: effectiveAssignee?.color ?? "var(--muted)" }}
              aria-hidden="true"
            >
              {effectiveAssignee ? initial(effectiveAssignee.displayName) : "?"}
            </span>
            <span>{effectiveAssignee?.displayName ?? "未設定"}</span>
          </button>
        </div>

        <div className="qa-field qa-scope-row">
          <span className="qa-field-label">公開範囲</span>
          <div className="qa-field-value">
            <div className="segmented" role="group" aria-label="公開範囲">
              <button
                type="button"
                className={`seg-btn ptb-press ${scope === "shared" ? "active" : ""}`}
                aria-pressed={scope === "shared"}
                onClick={() => setScope("shared")}
              >
                共有
              </button>
              <button
                type="button"
                className={`seg-btn ptb-press ${scope === "private" ? "active priv" : ""}`}
                aria-pressed={scope === "private"}
                onClick={() => setScope("private")}
              >
                じぶん
              </button>
            </div>
            <span className="qa-hint">
              {scope === "private" ? "あなただけに見えます" : "家族みんなに共有"}
            </span>
          </div>
        </div>

        <label className="qa-field qa-category">
          <span className="qa-field-label">カテゴリ</span>
          <span className="qa-field-value qa-category-value">
            <span
              className="cat-dot"
              style={{ background: effectiveTag?.color ?? "var(--muted-2)" }}
            />
            <select
              className="qa-category-select"
              aria-label="カテゴリ"
              value={effectiveTag?.id ?? ""}
              onChange={(event) => setTagId(event.target.value || null)}
            >
              <option value="">なし</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </span>
        </label>
      </div>
    </section>
  );
}
