import type { TagDTO } from "../../../src/types";
import { dueState, formatDue } from "../lib/datetime";
import "./bits.css";

// ローディングスピナー。
export function Spinner({ label = "読み込み中" }: { label?: string }) {
  return (
    <div className="spinner-wrap" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

// 期限 pill（淡オレンジ／期限切れ赤／間近）。
export function DuePill({ dueDate }: { dueDate: string | null }) {
  if (!dueDate) return null;
  const state = dueState(dueDate);
  const text = formatDue(dueDate);
  if (!text) return null;
  return <span className={`due-pill due-${state}`}>{text}</span>;
}

// カテゴリ（色ドット＋名）。
export function CategoryChip({ tag }: { tag: TagDTO }) {
  return (
    <span className="cat-chip">
      <span className="cat-dot" style={{ background: tag.color }} />
      {tag.name}
    </span>
  );
}

// 非公開（じぶんだけ）バッジ＝鍵＋バイオレット。
export function PrivateBadge({ inline = true }: { inline?: boolean }) {
  return (
    <span className={inline ? "private-badge" : "private-badge block"}>
      <span className="lock-glyph" aria-hidden="true" />
      じぶんだけ
    </span>
  );
}

// セグメント・トグルの汎用ボタン群。
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  privTint = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  privTint?: boolean;
}) {
  return (
    <div className="segmented">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            type="button"
            key={o.value}
            className={`seg-btn ptb-press ${active ? "active" : ""} ${
              active && privTint ? "priv" : ""
            }`}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
