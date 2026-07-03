# セキュリティポリシー

petabo は個人開発アプリの参考実装として公開しています。

## 報告

秘密情報、ユーザーデータ、認証回避につながる可能性がある脆弱性は、公開 Issue ではなくリポジトリオーナーへ非公開で報告してください。

## 秘密情報

次の実値はコミットしないでください。

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_LOGIN_CHANNEL_ID`
- `LINE_LOGIN_CHANNEL_SECRET`
- `APP_BASE_URL`
- `LIFF_ID`

ローカルでは `.dev.vars`、本番では Workers Secrets を使います。`.dev.vars.example` には実値を含めないため、コミットして問題ありません。

## 本番利用について

このリポジトリは堅牢な SaaS テンプレートではありません。実運用に流用する場合は、認証、認可、データ保持、ログ、レート制限、バックアップなどを改めて確認してください。
