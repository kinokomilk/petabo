# LINE / Cloudflare セットアップ手順（LINE_SETUP）

Phase 2 以降の前提。LINE Developers と Cloudflare のコンソール操作が必要。実際の画面項目名は変わりうるため、公式ドキュメントも併せて確認する。

---

## 1. Cloudflare（Phase 1 から）

1. Cloudflare アカウント作成（無料、カード不要の範囲で運用）。
2. `wrangler` ログイン：`npx wrangler login`。
3. D1 作成：`npx wrangler d1 create petabo` → 出力の `database_id` を `wrangler.toml` に記載。
4. `wrangler.toml` に D1 バインディング、Cron Triggers、静的アセット、（必要なら）KV を設定。
5. マイグレーション：`npx wrangler d1 migrations apply petabo`。
6. デプロイ：`npx wrangler deploy`。

## 2. LINE（Phase 2/3）

### 2.1 プロバイダーとチャンネル
- LINE Developers でプロバイダーを1つ作る。
- その配下に **Messaging API チャンネル**（公式アカウント）と **LINE ログインチャンネル**を作成。
  - **同一プロバイダーにすることが重要**（`userId` を共通化し、ログイン＝通知先の自動紐付けを成立させる）。

### 2.2 Messaging API
- チャンネルアクセストークン（長期）とチャンネルシークレットを取得。
- Webhook URL に `https://<worker-domain>/api/line/webhook` を設定し、Webhook 利用を ON。
- 応答メッセージ（自動応答）等は必要に応じて OFF。
- リッチメニュー画像（petabo 調）を用意して登録（Phase 3）。

### 2.3 LINE ログイン
- コールバック URL に本番/開発のコールバックを登録。
- 「友だち追加オプション（bot link）」を設定し、ログイン時に公式アカウントの友だち追加を促す。
- OpenID Connect を有効化（プロフィール取得）。
- petabo はログイン後に friendship status API で公式アカウントとの友だち状態を確認し、`users.line_followed` へ同期する。実機確認では、友だち追加済みなら `line_followed=1`、未追加なら `0` になることを見る。

### 2.4 LIFF（Phase 3）
- LIFF アプリを作成し、エンドポイント URL に LIFF 用のフロントを指定。
- LIFF ID を環境変数へ。

## 3. 環境変数 / シークレット

Workers Secrets（`npx wrangler secret put <KEY>`）。ローカルは `.dev.vars`（gitignore）。

| KEY | 用途 |
|---|---|
| `LINE_CHANNEL_SECRET` | Webhook 署名検証 |
| `LINE_CHANNEL_ACCESS_TOKEN` | push / 返信 |
| `LINE_LOGIN_CHANNEL_ID` | OAuth クライアントID |
| `LINE_LOGIN_CHANNEL_SECRET` | OAuth トークン交換 |
| `LIFF_ID` | LIFF 初期化 |
| `SESSION_SECRET` | セッション署名（採用方式による） |
| `APP_BASE_URL` | コールバック/絶対URL生成 |

`wrangler.toml`（非機密）には D1 バインディング・Cron 式・`vars`（公開可な設定）を記載。

## 4. 無料枠の目安（要・最新確認）

- Cloudflare Workers：約 10万リクエスト/日（無料・カード不要）。D1：約 5GB / 500万read・月。Cron Triggers 利用可。
- LINE Messaging API：push 約 200通/月（無料枠）。**担当者のみ通知**で消費を抑える。
- 数値は変動しうるため、本番前に各公式ドキュメントで再確認すること。

## 5. 注意

- 秘密情報は絶対にコミットしない。クライアント（フロント/LIFF）にシークレットを渡さない。
- webhook は公開 HTTPS が必須。開発時はトンネル（例：cloudflared/ngrok）か、`wrangler dev` のプレビュー URL を利用。
- 手順や項目名で不明点があれば、最新の LINE / Cloudflare 公式ドキュメントを確認する。
