# FindAllEasy — Backend

Express + MongoDB backend powering search, vitrin, auth and affiliate click-out.

## Quick start

1) Create `.env` (see `.env.example`)

2) Install + run:

```bash
npm ci
npm run test:system
npm run start
```

## Health & ops endpoints

- `GET /healthz` → plain `ok`
- `GET /api/healthz` → JSON health
- `GET /api/version` → build + runtime info

## Notes for reviewers

- The backend **requires MongoDB** (`MONGO_URI` / `MONGODB_URI`).
- All sensitive keys live in environment variables; do not commit `.env`.

