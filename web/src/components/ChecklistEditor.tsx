// チェックリスト編集：Enter 連続追加 / 改行一括登録 / タップで done / 進捗 n/m＋バー。
import { useRef, useState } from "react";
import type { ChecklistItemDTO } from "../../../src/types";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { Checkbox } from "./Checkbox";
import { Spinner } from "./bits";
import "./ChecklistEditor.css";

export function ChecklistEditor({
  todoId,
  onProgress,
}: {
  todoId: string;
  onProgress?: () => void;
}) {
  const items = useAsync<ChecklistItemDTO[]>(() => endpoints.items(todoId), [todoId]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const list = items.data ?? [];
  const total = list.length;
  const done = list.filter((i) => i.done).length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  async function addItems(rawText = text) {
    const v = rawText.trim();
    if (!v || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      // 改行を含む場合は一括登録（backend が text を改行分割する）。
      const created = await endpoints.addItems(todoId, { text: v });
      items.setData((prev) => [...(prev ?? []), ...created]);
      setText("");
      inputRef.current?.focus();
      onProgress?.();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function toggle(item: ChecklistItemDTO) {
    const next = !item.done;
    items.setData((prev) =>
      (prev ?? []).map((i) => (i.id === item.id ? { ...i, done: next } : i))
    );
    try {
      await endpoints.updateItem(item.id, { done: next });
      onProgress?.();
    } catch {
      items.reload();
    }
  }

  async function removeItem(item: ChecklistItemDTO) {
    items.setData((prev) => (prev ?? []).filter((i) => i.id !== item.id));
    try {
      await endpoints.deleteItem(item.id);
      onProgress?.();
    } catch {
      items.reload();
    }
  }

  return (
    <div className="checklist-card">
      <div className="cl-progress">
        <div className="cl-bar">
          <div className="cl-bar-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="cl-count">
          {done} / {total}
        </span>
      </div>

      {items.loading ? (
        <Spinner />
      ) : total === 0 ? (
        <p className="cl-empty">
          品目がまだありません。下の入力から、牛乳・卵…とどんどん足していけます。
        </p>
      ) : (
        <div className="cl-items">
          {list.map((item) => (
            <div className="cl-item" key={item.id}>
              <Checkbox
                checked={item.done}
                onToggle={() => toggle(item)}
                variant="square"
                size={21}
                label={`${item.text} を切替`}
              />
              <span className={`cl-text ${item.done ? "done" : ""}`}>
                {item.text}
                {item.done && <span className="cl-strike" aria-hidden="true" />}
              </span>
              <button
                className="cl-del"
                aria-label="削除"
                onClick={() => removeItem(item)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="cl-add">
        <input
          ref={inputRef}
          className="input"
          placeholder="品目を追加（Enterで続けて／改行で一括）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void addItems(e.currentTarget.value);
            }
          }}
          aria-label="品目を追加"
        />
        <button
          className="btn btn-primary btn-sm ptb-press"
          onClick={() => void addItems()}
          disabled={busy || !text.trim()}
        >
          ＋
        </button>
      </div>
    </div>
  );
}
