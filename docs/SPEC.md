# petabo 仕様書（SPEC）

家族・友人で共有する TODO ＋チェックリストアプリ。Web/PWA と LINE の2入口、Cloudflare 無料枠で運用。

> **実装状況（2026-06）**：Phase 1〜3 は実装済み。Phase 4 は任意・未着手。本書は設計の正（受け入れ基準・データモデル・API・決定事項）として維持し、運用は `docs/DEPLOY_RUNBOOK.md` を参照。

---

## 1. 全体像

```
[Web/PWA] ─┐
           ├─REST→ [Worker(Hono)] ─→ [D1(SQLite)]
[LINEアプリ]┘   ├ REST API / 認証 / 静的配信(PWA+LIFF)
                ├ /line/webhook（署名検証→Flex応答）
                └ Cron：期限チェック → push
   ↕ OAuth(IDトークン検証) / webhook・push
[LINE Platform]（LINEログイン ＋ Messaging API：同一プロバイダー）
```

- Web と LINE(LIFF) が同じ Worker＋D1 を見る。
- ログイン（LINE Login）と通知（Messaging API）は**同一プロバイダー**配下に置く → `userId` 共通 → ログイン時点で通知先に自動紐付け。
- LINE 連携はすべてサーバー側（Cloudflare）で動くため、クライアント環境に依存しにくい。

## 2. データモデル（D1 / SQLite）

```sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,         -- uuid
  display_name  TEXT NOT NULL,
  color         TEXT NOT NULL,            -- アバター色（パレットから割当）
  line_user_id  TEXT UNIQUE,             -- LINEログイン勢。NULL可
  avatar_url    TEXT,                    -- LINEプロフィール画像（任意）
  password_hash TEXT,                    -- フォールバック勢。NULL可
  salt          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE todos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'todo',   -- 'todo' | 'doing' | 'done'
  is_checklist INTEGER NOT NULL DEFAULT 0,     -- チェックリスト型か
  visibility   TEXT NOT NULL DEFAULT 'shared', -- 'shared'(家族共有) | 'private'(作成者のみ)
  due_date    TEXT,                            -- ISO8601, NULL可
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  creator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE checklist_items (
  id        TEXT PRIMARY KEY,
  todo_id   TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  text      TEXT NOT NULL,
  done      INTEGER NOT NULL DEFAULT 0,
  position  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE todo_tags (
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (todo_id, tag_id)
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL, created_at TEXT NOT NULL
);

-- リマインダー重複送信の防止（kind 例: 'due_soon' / 'overdue'）
CREATE TABLE todo_reminders (
  todo_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (todo_id, kind)
);
```

- ユーザーは `line_user_id`（LINE勢）か `password_hash`（フォールバック勢）で識別。両方持つことも可。
- 共有スペースは1つ（家族全員が共有タスクを見る）。複数グループ対応は Phase 4。
- アバター色は登録順にパレットから割当（`#F0695A,#5A78D0,#2BA396,#F1AE34,#B25BA0,#3DA5FF` など）。

## 3. REST API（草案・パスは確認可）

認証は `Authorization: Bearer <session token>`。返却 todo は assignee/creator/tags/checklist 進捗/comment 数を hydrate。

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/api/auth/line/callback` | LINE OAuth コールバック（code→IDトークン検証→セッション発行） |
| POST | `/api/auth/register` `/login` | フォールバック（名前+パスワード） |
| GET  | `/api/auth/me` | 現在ユーザー |
| GET  | `/api/users` | メンバー一覧（担当選択用） |
| GET/POST/DELETE | `/api/tags` | カテゴリ |
| GET  | `/api/todos?status=&assignee=&tag=` | 一覧（フィルタ） |
| POST | `/api/todos` | 作成（is_checklist, tagIds, items[] 同時可） |
| GET/PATCH/DELETE | `/api/todos/:id` | 取得/更新/削除 |
| GET/POST | `/api/todos/:id/items` | チェックリスト項目（連続追加） |
| PATCH/DELETE | `/api/items/:id` | 項目の done 切替/削除 |
| GET/POST | `/api/todos/:id/comments` | コメント |
| GET  | `/api/todos/reminders` | 期限切れ/間近（in-app 表示用） |
| POST | `/api/line/webhook` | LINE Webhook（署名検証必須） |
| GET  | `/api/liff/config` | LIFF 用設定（必要なら） |

## 4. 認証フロー

**LINE ログイン（主）**
- LINE 内（LIFF）：`liff.init()`→`liff.getProfile()` で userId/表示名/画像取得 → バックエンドでセッション発行。
- ブラウザ/PWA：OAuth 2.0/OIDC。`/api/auth/line/callback` で code を IDトークンに交換し**署名・aud・nonce を検証** → users を find/create → セッション発行。
- ログインチャンネルと Messaging API チャンネルを**同一プロバイダー**にし、`userId` を一致させる（自動紐付け）。
- ログイン時に「友だち追加」プロンプトを有効化し、push 受信に必要な友だち登録を促す。

**フォールバック（軽量）**
- 名前＋パスワード（PBKDF2 ハッシュ＋ソルト）。LINE を使わない人向け。push は紐付け後に有効。

**セッション**
- ランダムトークンを `sessions` に保存し、HttpOnly Cookie で送る。Secure / SameSite=Lax を付け、有効期限と失効を実装。

## 5. 機能詳細

- **担当者＝色アバター**：各ユーザーは色＋イニシャルのアバター。割当はタップ選択（将来ドラッグ）。
- **期限**：日時。`due_soon`(24h以内)/`overdue` を計算し、in-app では色（オレンジ/赤）で強調。
- **カテゴリ（タグ）**：多対多。初期タグ例：家事/買い物/育児/手続き/お出かけ。
- **コメント**：タスク単位のスレッド。
- **チェックリスト**：`is_checklist=1` のタスクに項目を複数。詳細画面で Enter 連続追加、タップで done、進捗バー＋「n/m」。改行で一括登録も可。
- **連続追加の軽減**：
  - クイック追加バー（ホーム上部）：入力→Enter で即追加。担当・カテゴリは**前回値を引き継ぎ**。
  - 新規作成の「保存して続けて追加」：担当・期限・カテゴリを保持したまま次へ。
- **状態**：todo/doing/done。詳細の3分割トグルで変更。
- **公開範囲**：作成時に「家族と共有／自分だけ」を選択（既定＝共有）。非公開は作成者のみ閲覧でき、行に**ロックの目印**を表示。作成者は後から共有へ切替可。

## 6. LINE 連携

**Webhook**
- `/api/line/webhook`。`X-Line-Signature` = base64(HMAC-SHA256(channelSecret, 生ボディ))を**生ボディで検証→後でパース**。素早く 200 応答、重い処理は `ctx.waitUntil()`。
- 扱うイベント：`follow`/`unfollow`/`message`/`postback`。

**コマンド（Phase 3）**
- `一覧`：自分の担当タスクを Flex で表示（クイックリプライで「全部」切替）。
- `追加 <タイトル>`：即追加（作成者＝連携ユーザー）。詳細は Web/LIFF。
- 完了：**postback ボタン**（`todoId` をデータに埋める）。番号テキストは使わない。
- 未知の文章：「これを追加しますか?」とクイックリプライで確認。

**Flex メッセージ**
- petabo 配色（オレンジ系）でカード化。担当は**アバター画像**（色＋イニシャルの小画像を生成しホスト）。期限切れ=赤系、日付=オレンジ。
- 制約：任意フォント不可（LINE 標準）。凝った見た目は LIFF に逃がす。

**リッチメニュー**
- 自前画像（petabo 調）で常設。ショートカット：一覧 / メモを貼る / きょう / 連携設定。

**LIFF**
- LINE 内ブラウザで Web 本体をそのまま表示（フォント含め完全再現）。userId 取得で連携が滑らか。

**リマインダー（Cron）**
- Cron Trigger で定期実行 → D1 から期限が近い/過ぎた未完了を抽出 → **担当者の line_user_id へ push**。
- `todo_reminders` で重複防止（期限変更時はリセット）。**静かな時間帯（JST 23:00–09:00）は通知しない**。
- 宛先：担当者がいれば**担当者のみ**へ push。**未担当は全アクティブメンバーへ一斉（multicast）**。担当者通知は1件1通で無料枠に優しいが、未担当は人数分の通数を消費する点に注意。**非公開（private）タスクは作成者のみへ通知**し、一斉送信の対象外。

## 7. フェーズと受け入れ基準

**Phase 1：Web/PWA コア**（LINE 設定不要）
- Worker+Hono+D1、REST API、軽量認証＋セッション、petabo UI 一式（リスト/クイック追加/続けて追加/チェックリスト消し込み/担当アバター/期限色分け/公開範囲/コメント）、PWA 化、Cloudflare デプロイ。
- 受け入れ：家族が URL 共有で利用可。CRUD・チェックリスト・担当・期限・タグ・コメントが動作。in-app リマインダー表示。`docs/TESTING.md` の機能/UI/セキュリティ/性能チェックを通過。

**Phase 2：LINE ログイン＋リマインダー通知**
- LINE Login（主）＋自動紐付け＋友だち追加プロンプト、フォールバック維持。Cron→担当者 push（重複防止・静かな時間帯）。
- 受け入れ：LINE でログインでき、期限接近で担当者の LINE に通知が届く。

**Phase 3：LINE 操作＋リッチメニュー＋LIFF**
- webhook コマンド（一覧/追加/完了ボタン）、Flex カード、リッチメニュー、LIFF。
- 受け入れ：チャットだけで一覧・追加・完了。LIFF で本体表示。

**Phase 4（任意）**
- 繰り返しタスク、項目ごとの担当・期限、通知設定、複数グループ、LINE アバター利用 等。

## 8. 決定事項（このセッションで確定）

1. **権限**：家族内はフルオープン。アクティブメンバーなら**誰でも**他人のタスクを編集・完了・削除できる。アクセス制御は「そのスペースのメンバーか」だけで行う。
2. **参加の入口**：**招待リンク**方式。最初の利用者＝オーナー。オーナーが発行したリンク/合言葉を持つ人が LINE ログインで自動参加。オーナーはメンバー削除・リンク再発行が可能。スペースは当面1つ（複数家族対応は Phase 4）。
3. **完了・削除**：完了は**アーカイブ**（残して「完了」フィルタで表示）。削除は**ハード削除**（行を削除）。
4. **環境**：dev/staging/prod は**分けない（単一環境）**。CI 導入は未定。
5. **リマインダー**：担当者がいれば**担当者のみへ push**。**未担当はグループ一斉**（全アクティブメンバーへ multicast）。※未担当通知は人数分の通数を消費する点に留意（無料枠 200通/月）。
6. **空状態**：初回・空チェックリスト・フィルタ結果ゼロ・未参加の状態を設計する。
7. **データ保全**（バックアップ/エクスポート/アカウント削除）：**後日検討**。
8. **ログ/監視**：**後日検討**（Cloudflare ログ or 使い慣れた Datadog 等）。
9. **タスクの公開範囲**：既定は家族共有。**作成者のみ見える「非公開（private）」タスク**を追加できる（詳細 §9）。
10. **デザイン**：Claude Design で検討したオレンジ系・モバイルファーストの方向性を採用。生成元素材は公開リポジトリには含めず、実装済みのデザイントークンとコンポーネントを正とする。

## 9. 参加・権限・データモデル追補

§2 に加えて以下を持つ。

```sql
CREATE TABLE households (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT, created_at TEXT NOT NULL
); -- 当面は1行（単一スペース）

CREATE TABLE memberships (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'member'
  status       TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'removed'
  joined_at    TEXT NOT NULL,
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE invite_tokens (
  token        TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at   TEXT,
  created_at   TEXT NOT NULL
);
```

- 将来の複数家族化に備え、共有エンティティ（`todos`/`tags`）に `household_id` を持たせておくと楽（単一スペースでは固定値）。判断は着手時に確認。
- **認可ルール**：アクティブな membership があれば、その家族のタスク/チェックリスト/コメントを全て読み書き可。**オーナー限定**操作＝招待リンクの発行/失効・メンバー削除。
- **公開範囲（visibility）**：`shared` は上記どおり家族全員が読み書き可。`private` は**作成者のみ**が閲覧・編集・完了・削除でき、他メンバー（オーナー含む）には**一覧・個別取得・通知のいずれにも現れない**。サーバ側で `creator_id` により厳格にフィルタし、ID 直打ちの取得も拒否する。非公開タスクは**他人を担当に設定しない（自分専用）**。作成者は後から `shared` に切替（家族へ公開）できる。〔オーナーにも非表示／他人を担当不可／後から共有化可：いずれも確定〕
- **参加フロー**：招待リンク（`/join/<token>`）を開く→LINE ログインまたはフォールバック登録→token を検証（存在・未失効）→`memberships` に active で追加。token 無し＆メンバーでない人には**未参加画面**（招待を待つ/コード入力/新規作成）を出す＝「自分だけ/未参加」の空状態。
- **完了/削除**：`todos.status='done'` がアーカイブ相当（一覧から外し「完了」フィルタで表示）。削除はレコード削除（関連 `checklist_items`/`comments`/`todo_tags` は CASCADE）。

## 10. 実装の確定事項（着手前に決定済み）

1. **リポジトリ/構成**：新規リポジトリ＋**モノレポ**（`web`(React/Vite) と Worker を同居、1デプロイ）。設計時の Node/Express 検証コードは破棄し Workers/Hono で作り直す。
2. **パッケージマネージャ**：**npm**。
3. **Cloudflare**：プロジェクト名 **`petabo`**。独自ドメインは当面なし（`*.workers.dev`、後から追加可）。
4. **セッション**：**HttpOnly Cookie**（Secure / SameSite=Lax）、保存先 **D1**。OAuth は state/nonce で CSRF・リプレイ対策。
5. **フォント配信**：**Google Fonts**（`display=swap`）で開始。読込失敗時はシステムサンセリフ＋Noto へフォールバック。堅牢化が要れば後でセルフホストへ切替。
6. **初期タグ**：家事 / 買い物 / 育児 / 手続き / お出かけ。**アバター色**：`#FF7A4D, #4C8DF6, #3AA675, #9B7EDE, #E86FA0`（登録順に割当）。
7. **LINE**：Phase 1 は不要。Phase 2 着手時に公式アカウント用意（名称「**petabo**」）。リッチメニュー/LIFF 画像は Phase 3。
8. **静かな時間帯**：**23:00–09:00（JST）は push しない**。
9. **家族スペース名**：オーナーが作成時に入力（例「サンプル家」、後から変更可）。
10. **既定の並び順**：期限の近い順 → なければ作成順。手動ドラッグ並べ替えは Phase 4。
11. **PWA 名称/アイコン**：名称 **petabo**。アイコンはオレンジ基調で実装時に用意。

> 上記以外で迷う点が出たら、勝手に決めずユーザーに確認する。
