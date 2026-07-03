import "./Checkbox.css";

interface CheckboxProps {
  checked: boolean;
  onToggle: () => void;
  variant?: "round" | "square"; // タスク行=round, チェックリスト項目=square
  size?: number;
  label?: string;
}

// 完了＝--accent 塗り＋白チェック（SVG dashoffset アニメ）。done で取り消し線は親側で。
export function Checkbox({
  checked,
  onToggle,
  variant = "round",
  size = 27,
  label = "完了切替",
}: CheckboxProps) {
  return (
    <button
      type="button"
      className={`ptb-checkbox ptb-check ${variant}`}
      onClick={onToggle}
      aria-pressed={checked}
      aria-label={label}
      style={{
        width: size,
        height: size,
        borderColor: checked ? "var(--accent)" : "var(--line-2)",
        background: checked ? "var(--accent)" : "transparent",
        borderRadius: variant === "round" ? "50%" : "7px",
        // ヒット領域を最低 44px に拡張（見た目は size のまま）。
        ["--ptb-cb-hit" as string]: `${Math.max(44, size)}px`,
      }}
    >
      {checked && (
        <svg
          className="ptb-check-svg"
          viewBox="0 0 24 24"
          width={size * 0.6}
          height={size * 0.6}
          aria-hidden="true"
        >
          <path
            d="M5 13 L10 18 L19 7"
            fill="none"
            stroke="#fff"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
