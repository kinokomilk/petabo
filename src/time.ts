// 期限判定の時刻ヘルパー（JST 基準）。
// petabo は日本の家族向けなので「今日/期限切れ」は JST(UTC+9) の暦日で判定する。
// Worker は UTC で動くため、JST のその日の 00:00 を UTC instant(ms) に変換して使う。
//
// 「期限切れ(overdue)」= 期限の“日付”が今日(JST)より前。
// 今日が期限のタスクは、当日中は overdue にしない（時刻を過ぎても今日のうちは期限内）。
export function jstStartOfTodayMs(nowMs: number): number {
  // now を JST の壁時計に直し（+9h）、その暦日の 00:00 を求めて UTC instant に戻す。
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const jstMidnightAsUtc = Date.UTC(
    jst.getUTCFullYear(),
    jst.getUTCMonth(),
    jst.getUTCDate(),
  );
  return jstMidnightAsUtc - 9 * 60 * 60 * 1000;
}

export function jstStartOfTodayIso(nowMs: number): string {
  return new Date(jstStartOfTodayMs(nowMs)).toISOString();
}
