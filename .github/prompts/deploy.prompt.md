---
description: "Deploy fa_ai to Railway with a pre-flight checklist"
argument-hint: "Optional: environment or notes"
agent: Mr_Shafiq
---
Walk through deploying this project to Railway. Delegate the work to the **Mr_Shafiq** agent so the deploy goes through its plan-then-approve gate. Use the `use-railway` skill for the actual Railway operations.

## Pre-flight checklist (verify before deploying)
1. **Working tree clean**: run `git status`; confirm changes are committed (or intentionally staged).
2. **Config present**: confirm `railway.json` exists with `startCommand: npm start` and `healthcheckPath: /health`.
3. **Required env vars** are set in the target Railway environment:
   - `FMP_API_KEY` (required for live data)
   - `DATABASE_URL` (optional — app falls back to JSON if unset)
   - `ALLOWED_ORIGINS` (CORS allowlist for production frontend)
   - Optional tuning: `SNAPSHOT_TTL_DAYS`, `HISTORY_RETENTION_DAYS`, `PORT`
4. **Local sanity**: run `npm start` and hit `/health` to confirm the server boots.

## Deploy
- Summarize what will be deployed (branch, commit, environment) and the exact commands you will run.
- **Wait for my authorization**, then proceed with the Railway deploy.
- After deploy, report the deployment status, the service URL, and the result of the `/health` healthcheck.

$ARGUMENTS
