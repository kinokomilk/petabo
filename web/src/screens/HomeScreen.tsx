// ホーム。ヘッダ / タブ / クイック追加 / セクション / タスク行。
import { useRef, useState } from "react";
import type { ChecklistItemDTO, TodoDTO, UserDTO, TagDTO } from "../../../src/types";
import { useAuth } from "../auth/AuthContext";
import { endpoints } from "../api/endpoints";
import { useAsync } from "../lib/useAsync";
import { AvatarStack } from "../components/AvatarStack";
import { TaskRow } from "../components/TaskRow";
import { Spinner } from "../components/bits";
import { EmptyState } from "../components/EmptyState";
import { QuickAdd } from "../components/QuickAdd";
import { BottomNav } from "../components/BottomNav";
import { ReminderBanner } from "../components/ReminderBanner";
import { buildHomeLists, getHomeVisibility, type HomeTab } from "./homeModel";
import "./HomeScreen.css";

export function HomeScreen() {
  const { me } = useAuth();
  const [tab, setTab] = useState<HomeTab>("all");
  const [onlyMine, setOnlyMine] = useState(false);
  const [importantOnly, setImportantOnly] = useState(false);
  const [recentlyAdded, setRecentlyAdded] = useState<string | null>(null);
  // クイック追加直後の「取り消し」トースト（Enter 誤登録の救済）。
  const [undoTodo, setUndoTodo] = useState<TodoDTO | null>(null);
  const undoTimer = useRef<number | null>(null);

  const users = useAsync<UserDTO[]>(() => endpoints.users(), []);
  const tags = useAsync<TagDTO[]>(() => endpoints.tags(), []);
  const todos = useAsync<TodoDTO[]>(() => endpoints.todos(), []);
  // 完了タスクは専用フィルタ選択時のみ取得（GET /api/todos?status=done）。
  const doneTodos = useAsync<TodoDTO[]>(
    () => endpoints.todos({ status: "done" }),
    []
  );

  const meUser = me?.user ?? null;

  // フィルタ＆並び（バックエンドが due 近い順で返す前提だが念のため安定化）。
  const { todayList, upcomingList, allList, doneList } = buildHomeLists(
    todos.data ?? [],
    doneTodos.data ?? [],
    { onlyMine, importantOnly, viewerId: meUser?.id ?? null },
  );

  function refreshTodos() {
    todos.reload();
  }

  async function handleToggleDone(todo: TodoDTO) {
    const next = todo.status === "done" ? "todo" : "done";
    // 楽観更新
    todos.setData((prev) =>
      (prev ?? []).map((t) => (t.id === todo.id ? { ...t, status: next } : t))
    );
    doneTodos.setData((prev) =>
      (prev ?? []).map((t) => (t.id === todo.id ? { ...t, status: next } : t))
    );
    try {
      await endpoints.updateTodo(todo.id, { status: next });
    } finally {
      // 完了/再オープンで両リストの所属が変わるため再取得して整合させる。
      refreshTodos();
      doneTodos.reload();
    }
  }

  // スター(重要)を DB 永続化。楽観更新＋失敗時ロールバック。
  async function handleToggleStar(todo: TodoDTO) {
    const next = !todo.isImportant;
    const apply = (t: TodoDTO) =>
      t.id === todo.id ? { ...t, isImportant: next } : t;
    todos.setData((prev) => (prev ?? []).map(apply));
    doneTodos.setData((prev) => (prev ?? []).map(apply));
    try {
      await endpoints.updateTodo(todo.id, { isImportant: next });
    } catch {
      // ロールバック
      const revert = (t: TodoDTO) =>
        t.id === todo.id ? { ...t, isImportant: todo.isImportant } : t;
      todos.setData((prev) => (prev ?? []).map(revert));
      doneTodos.setData((prev) => (prev ?? []).map(revert));
    }
  }

  async function handleChecklistItemToggle(todoId: string, item: ChecklistItemDTO) {
    const next = !item.done;
    const delta = next ? 1 : -1;
    const target = (todos.data ?? doneTodos.data ?? []).find((t) => t.id === todoId);
    const nextDone = target
      ? Math.max(0, Math.min(target.checklist.total, target.checklist.done + delta))
      : 0;
    const parentStatus =
      target && target.checklist.total > 0 && nextDone === target.checklist.total
        ? "done"
        : target?.status === "done"
          ? "todo"
          : target?.status;
    const apply = (t: TodoDTO) =>
      t.id === todoId
        ? {
            ...t,
            status: parentStatus ?? t.status,
            checklist: {
              ...t.checklist,
              done: Math.max(0, Math.min(t.checklist.total, t.checklist.done + delta)),
            },
            checklistItems: t.checklistItems.map((candidate) =>
              candidate.id === item.id ? { ...candidate, done: next } : candidate
            ),
          }
        : t;
    todos.setData((prev) => (prev ?? []).map(apply));
    doneTodos.setData((prev) => (prev ?? []).map(apply));
    try {
      await endpoints.updateItem(item.id, { done: next });
      if (parentStatus !== target?.status) {
        todos.reload();
        doneTodos.reload();
      }
    } catch {
      todos.reload();
      doneTodos.reload();
    }
  }

  function handleAdded(created: TodoDTO) {
    setRecentlyAdded(created.id);
    window.setTimeout(() => setRecentlyAdded(null), 1500);
    refreshTodos();
    // 取り消し導線を 5 秒間表示。
    setUndoTodo(created);
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => {
      setUndoTodo(null);
      undoTimer.current = null;
    }, 5000);
  }

  async function handleUndo() {
    const target = undoTodo;
    if (!target) return;
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
    setUndoTodo(null);
    await endpoints.deleteTodo(target.id);
    refreshTodos();
  }

  const loading = users.loading || tags.loading || todos.loading;

  const renderList = (list: TodoDTO[]) =>
    list.map((t) => (
      <TaskRow
        key={t.id}
        todo={t}
        onToggleDone={handleToggleDone}
        onToggleStar={handleToggleStar}
        onChecklistItemToggle={(todoId, item) =>
          void handleChecklistItemToggle(todoId, item)
        }
        justAdded={recentlyAdded === t.id}
      />
    ));

  const { showDone, showToday, showUpcoming, visibleCount } =
    getHomeVisibility(tab, { todayList, upcomingList, allList, doneList });

  const allActiveEmpty =
    (todos.data ?? []).filter((t) => t.status !== "done").length === 0;

  return (
    <div className="home">
      {/* ヘッダ */}
      <header className="home-header">
        <div className="brand">
          <span className="brand-logo">petabo</span>
          <span className="brand-house">{me?.household?.name ?? ""}</span>
        </div>
        <AvatarStack users={users.data ?? []} max={3} size={26} />
      </header>

      {/* リマインダー（overdue/dueSoon の色分け） */}
      <ReminderBanner />

      {/* クイック追加 */}
      <QuickAdd
        meUser={meUser}
        users={users.data ?? []}
        tags={tags.data ?? []}
        onAdded={handleAdded}
      />

      {/* 一覧の絞り込み。追加エリアと混ぜず、対象リストの直前に置く。 */}
      <div className="home-filters">
        <div className="home-tabs-seg" role="group" aria-label="表示を絞り込む">
          <button
            className={`tab-pill ${tab === "all" ? "active" : ""}`}
            aria-pressed={tab === "all"}
            onClick={() => setTab("all")}
          >
            すべて
          </button>
          <button
            className={`tab-pill ${tab === "today" ? "active" : ""}`}
            aria-pressed={tab === "today"}
            onClick={() => setTab("today")}
          >
            今日
          </button>
          <button
            className={`tab-pill ${tab === "upcoming" ? "active" : ""}`}
            aria-pressed={tab === "upcoming"}
            onClick={() => setTab("upcoming")}
          >
            これから
          </button>
          {/* 完了は控えめな導線（done トーン）。モック非掲載のためトーンを崩さない。 */}
          <button
            className={`tab-pill tab-pill-done ${tab === "done" ? "active" : ""}`}
            aria-pressed={tab === "done"}
            onClick={() => setTab("done")}
          >
            完了
          </button>
        </div>
        <div className="home-tabs-filters">
          <button
            className={`important-only ${importantOnly ? "active" : ""}`}
            aria-pressed={importantOnly}
            aria-label="重要（スター）のタスクだけに絞り込む"
            onClick={() => setImportantOnly((v) => !v)}
          >
            <span aria-hidden="true">★</span> 重要
          </button>
          <button
            className={`only-mine ${onlyMine ? "active" : ""}`}
            aria-pressed={onlyMine}
            aria-label="じぶんだけのタスクに絞り込む"
            onClick={() => setOnlyMine((v) => !v)}
          >
            じぶんだけ
          </button>
        </div>
      </div>

      {/* リスト本体 */}
      {showDone ? (
        doneTodos.loading ? (
          <Spinner />
        ) : doneTodos.error ? (
          <div className="home-error">{doneTodos.error}</div>
        ) : doneList.length === 0 ? (
          <EmptyState kind="filter" />
        ) : (
          <div className="home-list">
            <SectionHead label="完了" count={doneList.length} />
            {renderList(doneList)}
          </div>
        )
      ) : loading ? (
        <Spinner />
      ) : todos.error ? (
        <div className="home-error">{todos.error}</div>
      ) : onlyMine && visibleCount === 0 ? (
        <EmptyState kind="private" />
      ) : allActiveEmpty && !onlyMine ? (
        <EmptyState kind="first" />
      ) : visibleCount === 0 ? (
        <EmptyState kind="filter" />
      ) : (
        <div className="home-list">
          {showToday && todayList.length > 0 && (
            <>
              <SectionHead label="今日" count={todayList.length} />
              {renderList(todayList)}
            </>
          )}
          {showUpcoming && upcomingList.length > 0 && (
            <>
              <SectionHead label="これから" count={upcomingList.length} />
              {renderList(upcomingList)}
            </>
          )}
        </div>
      )}

      <div className="home-spacer" />

      {/* クイック追加の取り消しトースト（誤登録の救済）。 */}
      {undoTodo && (
        <div className="undo-toast" role="status" aria-live="polite">
          <span className="undo-toast-msg">追加しました</span>
          <button
            type="button"
            className="undo-toast-btn"
            onClick={() => void handleUndo()}
            aria-label="いま追加したタスクを取り消す"
          >
            取り消し
          </button>
        </div>
      )}

      <BottomNav active="today" allCount={allList.length} />
    </div>
  );
}

function SectionHead({ label, count }: { label: string; count: number }) {
  return (
    <div className="section-head">
      <span className="section-label">{label}</span>
      <span className="section-count">{count}</span>
    </div>
  );
}
