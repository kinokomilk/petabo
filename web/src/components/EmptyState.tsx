import type { ReactNode } from "react";
import "./EmptyState.css";

type Kind = "first" | "checklist" | "filter" | "private" | "unjoined";

const PRESETS: Record<
  Kind,
  { icon: ReactNode; title: string; body: ReactNode; tone: "accent" | "lock" }
> = {
  first: {
    tone: "accent",
    icon: <span className="es-plus">＋</span>,
    title: "まだ何もありません",
    body: (
      <>
        上の入力から、
        <br />
        最初のやることを貼ってみよう
      </>
    ),
  },
  checklist: {
    tone: "accent",
    icon: <span className="es-list" aria-hidden="true" />,
    title: "品目がまだありません",
    body: (
      <>
        下の入力から、牛乳・卵…と
        <br />
        どんどん足していけます
      </>
    ),
  },
  filter: {
    tone: "accent",
    icon: <span className="es-search" aria-hidden="true" />,
    title: "このフィルタのタスクはありません",
    body: (
      <>
        フィルタを変えるか、
        <br />
        新しく貼ってみよう
      </>
    ),
  },
  private: {
    tone: "lock",
    icon: <span className="lock-glyph-lg" aria-hidden="true" />,
    title: "じぶんだけのメモはまだありません",
    body: (
      <>
        「じぶん」を選んでペタッと貼ると、
        <br />
        あなたにだけ見えるタスクになります。
      </>
    ),
  },
  unjoined: {
    tone: "accent",
    icon: <span className="es-wave">👋</span>,
    title: "ようこそ petabo へ",
    body: <>家族のスペースに参加して、やることを共有しましょう。</>,
  },
};

export function EmptyState({
  kind,
  action,
}: {
  kind: Kind;
  action?: ReactNode;
}) {
  const p = PRESETS[kind];
  return (
    <div className="empty-state">
      <div className={`es-icon es-${p.tone}`}>{p.icon}</div>
      <div className="es-title">{p.title}</div>
      <div className="es-body">{p.body}</div>
      {action && <div className="es-action">{action}</div>}
    </div>
  );
}
