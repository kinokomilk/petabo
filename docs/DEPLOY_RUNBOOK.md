# Deploy Runbook

petabo のデプロイ・検証・切り戻し手順。秘密情報の値はこのファイルに書かない。

## 1. 事前確認

```bash
npm test
npm run typecheck
npm --prefix web run typecheck
npm run build
npm audit --audit-level=moderate
npm --prefix web audit --audit-level=moderate
```

E2E も必要に応じて実行する。

```bash
npm run e2e
```

## 2. Secrets

本番に入れる。

```bash
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_LOGIN_CHANNEL_ID
npx wrangler secret put LINE_LOGIN_CHANNEL_SECRET
npx wrangler secret put APP_BASE_URL
```

Phase 3 で追加。

```bash
npx wrangler secret put LIFF_ID
```

## 3. Migration

ローカル。

```bash
npm run migrate:local
```

本番。

```bash
npm run migrate:remote
```

`0004_data_constraints.sql` は既存データを作り直さず、以後の不正値を trigger で拒否する。Phase 2 では `0005_line.sql` まで適用し、LINE 連携列・OAuth state・reminder 重複防止テーブルを作る。

## 4. Deploy

```bash
npm run deploy
```

デプロイ後に確認する。

```bash
curl -i https://<worker-domain>/api/health
```

## 5. LINE Console

- Messaging API Webhook URL: `https://<worker-domain>/api/line/webhook`
- Webhook を ON
- LINE Login callback URL: `https://<worker-domain>/api/auth/line/callback`
- 友だち追加オプションを ON

Webhook Verify は Phase 2 実装後に実行する。

## 6. Smoke Test

- ブラウザでトップを開く。
- 既存フォールバックログインが動く。
- todo 作成・更新・削除が動く。
- LINE Login でログインできる。
- `users.line_user_id` と `users.line_followed` がLINE側の状態と一致する。
- 期限通知が 1 件届く。
- private タスクが他人に見えず、通知もされない。
- removed member が担当者として残っていても通知されない。

LINE 実環境は LINE Developers Console の Webhook Verify と実機ログインで確認する。

## 7. Logs

```bash
npx wrangler tail
```

確認するもの。

- `/api/line/webhook` が 200 を返しているか。
- signature failure が大量発生していないか。
- push API 失敗がないか。
- LINE Login 後に friendship status API が失敗していないか。
- secrets の値や token をログに出していないか。

## 8. Rollback

コードだけ戻す場合。

```bash
npx wrangler rollback
```

DB migration は D1 に自動 rollback がない前提で扱う。破壊的 migration は避け、Phase 2 では列追加・trigger 追加中心にする。戻す必要がある場合は、逆 migration を明示的に作る。

## 9. 障害時の切り分け

- ログイン失敗: `APP_BASE_URL`、callback URL、state/nonce、LINE Login channel id/secret、token/verify endpoint を確認。
- ログイン後に通知されない: friendship status API、`line_followed`、公式アカウントの友だち状態を確認。
- webhook 失敗: `LINE_CHANNEL_SECRET`、raw body 署名検証、Webhook URL、HTTPS を確認。
- push 失敗: `LINE_CHANNEL_ACCESS_TOKEN`、友だち追加状態、unfollow 状態、送信数上限を確認。
- 通知されない: Cron 設定、JST 静かな時間帯、`todo_reminders`、`line_user_id`、`line_followed`、membership status を確認。
- private/removed への誤通知が疑われる: `visibility`、`creator_id`、`assignee_id`、`memberships.status` を確認。
