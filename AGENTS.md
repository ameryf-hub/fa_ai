# fa_ai Agent Guide

Minimal instructions for AI coding agents working in this repository.

## Workspace scope
- Canonical project root is this folder: `/workspaces/fa_ai`.
- Treat the nested mirror folder `fa_ai/` as non-canonical and potentially stale.
- Prefer editing root-level files only unless the user explicitly requests otherwise.

## Fast start
- Install: `npm install`
- Run: `npm start` (starts `node server.js`)
- Test: `npm test` (placeholder script)

## Architecture map
- `server.js`: Express entry point, `/api/*` routes, FMP client helper, in-memory cache, CORS, rate limit.
- `db.js`: optional PostgreSQL persistence layer (must gracefully degrade when DB is unavailable).
- `public/index.html`: static frontend served by Express.
- `data/fundamentals.json`: JSON fallback store when DB is not used.
- `railway.json`: Railway deploy config, NIXPACKS builder, `/health` healthcheck.

## Non-negotiable conventions
- JavaScript is CommonJS on Node >= 18 (`require` / `module.exports`).
- Read configuration from `process.env` with safe defaults; never hardcode secrets.
- Required env names in this codebase: `FMP_API_KEY`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `SNAPSHOT_TTL_DAYS`, `HISTORY_RETENTION_DAYS`, `PORT`.
- Access Financial Modeling Prep only through `fmpGet(endpoint)`.
- Check cache before upstream fetch (`apiCache` and/or DB snapshot helpers).
- Keep DB optional: guard operations with readiness checks and warn instead of throwing when unavailable.
- Use parameterized SQL only (`$1`, `$2`, ...).
- Keep `/api/*` behavior aligned with existing GET-oriented, rate-limited, CORS-checked pattern; keep `/health` lightweight.

## Style and editing rules
- Follow `.github/instructions/node-style.instructions.md` for any `*.js` edits.
- Preserve 4-space indentation, existing section-banner style, and concise logging style.
- Avoid broad refactors unless explicitly requested.

## Reference docs
- Setup and deployment details: `docs/setup.md`
- Project docs home: `docs/index.md`

## Typical change workflow for agents
1. Read `server.js` and `db.js` sections related to the target change.
2. Implement smallest safe change in root-level files.
3. Run `npm test` (and any targeted checks if added).
4. Summarize behavior impact and env/config implications.
