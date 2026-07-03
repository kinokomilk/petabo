import type { TodoDTO } from "../../../src/types";
import { dueState } from "../lib/datetime";

export type HomeTab = "today" | "upcoming" | "all" | "done";

export interface HomeListOptions {
  onlyMine: boolean;
  importantOnly: boolean;
  viewerId: string | null;
}

export interface HomeLists {
  todayList: TodoDTO[];
  upcomingList: TodoDTO[];
  allList: TodoDTO[];
  doneList: TodoDTO[];
}

export interface HomeVisibility {
  showDone: boolean;
  showToday: boolean;
  showUpcoming: boolean;
  visibleCount: number;
}

// 重要(isImportant)を各セクション最上部にピン留め。サーバ並び（期限/作成順）は維持。
export function pinImportant(list: TodoDTO[]): TodoDTO[] {
  return [...list].sort(
    (a, b) => Number(b.isImportant) - Number(a.isImportant)
  );
}

function applyHomeFilters(list: TodoDTO[], options: HomeListOptions): TodoDTO[] {
  const scoped = options.onlyMine
    ? list.filter(
        (t) => t.visibility === "private" && t.creator?.id === options.viewerId
      )
    : list;
  return options.importantOnly ? scoped.filter((t) => t.isImportant) : scoped;
}

export function buildHomeLists(
  activeSource: TodoDTO[],
  doneSource: TodoDTO[],
  options: HomeListOptions,
): HomeLists {
  const activeBase = applyHomeFilters(activeSource, options).filter(
    (t) => t.status !== "done"
  );
  const today: TodoDTO[] = [];
  const upcoming: TodoDTO[] = [];

  for (const todo of activeBase) {
    const state = dueState(todo.dueDate);
    if (state === "today" || state === "overdue") today.push(todo);
    else upcoming.push(todo);
  }

  return {
    todayList: pinImportant(today),
    upcomingList: pinImportant(upcoming),
    allList: applyHomeFilters(activeSource, options),
    doneList: pinImportant(applyHomeFilters(doneSource, options)),
  };
}

export function getHomeVisibility(tab: HomeTab, lists: HomeLists): HomeVisibility {
  const showDone = tab === "done";
  const showToday = !showDone && (tab === "today" || tab === "all");
  const showUpcoming = !showDone && (tab === "upcoming" || tab === "all");
  const visibleCount =
    (showToday ? lists.todayList.length : 0) +
    (showUpcoming ? lists.upcomingList.length : 0) +
    (showDone ? lists.doneList.length : 0);

  return { showDone, showToday, showUpcoming, visibleCount };
}
