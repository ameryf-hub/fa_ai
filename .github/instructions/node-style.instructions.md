---
description: "Node/Express coding style and safety rules for fa_ai .js files"
applyTo: "**/*.js"
---
# JavaScript / Node conventions for fa_ai

Apply these when writing or editing any `.js` file in this project.

## Language & modules
- Use **CommonJS** (`require` / `module.exports`). Do not introduce ESM `import`/`export`.
- Target Node >= 18 features only.

## Style
- 4-space indentation.
- Add a JSDoc block (`/** ... */`) describing the purpose of each new function.
- Group related code under section banners matching the existing style, e.g. `// ── SECTION NAME`.
- Use `console.log` / `console.warn` for logging, keeping the existing `✓` (success), `⚠` (warning), `ℹ` (info) prefixes.

## Configuration & secrets
- Read all configuration from `process.env` with a sensible default fallback.
- Never hardcode API keys, connection strings, or other secrets.
- Required env vars in this project: `FMP_API_KEY`, `DATABASE_URL`, `ALLOWED_ORIGINS`, `SNAPSHOT_TTL_DAYS`, `HISTORY_RETENTION_DAYS`, `PORT`.

## External APIs & caching
- Access FMP only through the `fmpGet(endpoint)` helper; do not construct FMP URLs elsewhere.
- Check the in-memory `apiCache` and/or `getFreshSnapshot()` before making network calls to conserve API quota.

## Database (db.js)
- Use **parameterized** queries (`$1`, `$2`, ...). Never interpolate user input into SQL.
- Guard DB operations with the `ready` flag so the app still works when `DATABASE_URL` is unset. Warn on failure; do not throw out of the persistence layer.

## HTTP
- New `/api/` routes should be GET-only and respect the existing rate-limit and CORS allowlist middleware.
- Keep `/health` lightweight and unauthenticated.
