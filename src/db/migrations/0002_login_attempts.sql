-- ログイン失敗のレート制限用テーブル（TESTING §3 総当り対策＝緩いレート制限）。
-- key 1 つにつき 1 行のスライディングウィンドウを保持する軽量実装。
-- key は「household 内 display_name」または取得できない場合は CF-Connecting-IP。
-- ウィンドウ（既定15分）内に N 回（既定10）失敗したら 429 を返し、
-- ログイン成功で当該 key の行を削除してリセットする。
-- 無料枠を圧迫しないよう、行数は key 数（=メンバー数 + 攻撃元IP数）程度に収まる設計。
CREATE TABLE login_attempts (
  key          TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,   -- 現ウィンドウ開始時刻（ISO8601）
  count        INTEGER NOT NULL DEFAULT 0
);
