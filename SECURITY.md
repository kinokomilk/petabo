# Security Policy

petabo is published as a reference implementation for a personal project.

## Reporting

Please do not open a public issue for vulnerabilities that could expose secrets, user data, or authentication bypasses. Report them privately to the repository owner.

## Secrets

Do not commit real values for:

- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_LOGIN_CHANNEL_ID`
- `LINE_LOGIN_CHANNEL_SECRET`
- `APP_BASE_URL`
- `LIFF_ID`

Use `.dev.vars` locally and Workers Secrets in production. `.dev.vars.example` is safe to commit because it contains no real values.

## Production Use

This repository is not a hardened SaaS template. Review authentication, authorization, data retention, logging, rate limits, and backup requirements before adapting it for real users.
