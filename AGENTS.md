# fa_ai — Project Conventions

Financial-data screener API. Node.js + Express backend that pulls fundamentals from the
Financial Modeling Prep (FMP) API, caches them in memory and (optionally) PostgreSQL, and
serves a static frontend from `public/`.

## Stack
- **Runtime**: Node.js >= 18, CommonJS (`require`, not ESM `import`).
- **Server**: Express 5 (`server.js`) — single entry point, `npm start`.
- **Data source**: FMP "stable" API at `https://financialmodelingprep.com/stable`.
- **Persistence**: PostgreSQL via `pg` (`db.js`); falls back to in-memory + JSON when `DATABASE_URL` is unset.
- **Deploy**: Railway (`railway.json`), NIXPACKS builder, healthcheck at `/health`.

## Key files
- `server.js` — all routes, middleware, FMP client, in-memory cache, rate limiting, CORS.
- `db.js` — Postgres pool, schema bootstrap, snapshot cache + filter-run history. Every export is a no-op when the DB is disabled.
- `russell-extra.json` — extra tickers loaded at startup (`{ "tickers": [...] }`).
- `data/fundamentals.json` — JSON fallback store.
- `public/index.html` — static frontend.

## Conventions to follow
- **Config via env vars**: `FMP_API_KEY`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `SNAPSHOT_TTL_DAYS`, `HISTORY_RETENTION_DAYS`, `PORT`. Read with `process.env` and provide sane defaults. Never hardcode secrets.
- **FMP access goes through `fmpGet(endpoint)`** — it injects the API key and handles errors. Don't build FMP URLs by hand elsewhere.
- **Cache before fetch**: check `apiCache` (in-memory, `CACHE_TTL`) and/or `getFreshSnapshot()` before calling FMP to conserve API quota.
- **DB code must stay optional**: guard new `db.js` functions with the `ready` flag and degrade gracefully (warn, don't throw) so the app runs without Postgres.
- **Routes are GET-only** under `/api/`, subject to rate limiting (`RATE_LIMIT_MAX`/min) and CORS allowlist. `/health` is exempt.
- **SQL**: parameterized queries only (`$1, $2 ...`). Never interpolate user input into SQL.
- **Style**: 4-space indentation, JSDoc comments on functions, section banners (`── SECTION`) like the existing code.
- **Logging**: concise `console.log`/`console.warn` with the existing `✓ / ⚠ / ℹ` prefixes.

## Commands
- `npm start` — run the server.
- `npm test` — placeholder (currently always passes).
