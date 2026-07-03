// クイック追加の「前回値引き継ぎ」を localStorage に保持。
const KEY = "petabo:prefs:v1";

export interface QuickPrefs {
  assigneeId: string | null; // 前回の担当
  tagId: string | null; // 前回のカテゴリ
  scope: "shared" | "private"; // 前回の公開範囲
}

const DEFAULT: QuickPrefs = {
  assigneeId: null,
  tagId: null,
  scope: "shared",
};

export function loadQuickPrefs(): QuickPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<QuickPrefs>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveQuickPrefs(p: QuickPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // localStorage 不可環境では引き継ぎ無効（致命的でない）
  }
}
