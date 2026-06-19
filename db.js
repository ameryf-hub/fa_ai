// ════════════════════════════════════════════════════════════════════════════
// ── PostgreSQL persistence layer (Railway)
// ────────────────────────────────────────────────────────────────────────────
// Provides two capabilities:
//   1. A time-bounded snapshot cache (fundamentals / screener) so repeated
//      filters reuse stored data instead of re-fetching from FMP.
//   2. A filter-run history log for later analysis, auto-pruned after 90 days.
//
// If DATABASE_URL is not set, every function becomes a no-op and the caller
// falls back to its existing behaviour (in-memory cache + JSON file).
// ════════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || '';

// Retention / TTL configuration (overridable via env).
const SNAPSHOT_TTL_DAYS = parseInt(process.env.SNAPSHOT_TTL_DAYS || '7', 10);   // cache freshness
const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || '90', 10); // filter history

let pool = null;
let ready = false;

function isEnabled() {
    return Boolean(DATABASE_URL);
}

/**
 * Initialise the connection pool and ensure the schema exists.
 * Safe to call once at startup. Returns true if the DB is usable.
 */
async function initDb() {
    if (!DATABASE_URL) {
        console.log('ℹ DATABASE_URL not set — running without PostgreSQL (JSON fallback).');
        return false;
    }

    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
        console.warn('⚠ PostgreSQL pool error:', err.message);
    });

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id          BIGSERIAL PRIMARY KEY,
                kind        TEXT NOT NULL,
                payload     JSONB NOT NULL,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                expires_at  TIMESTAMPTZ NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_snapshots_kind_created
                ON snapshots (kind, created_at DESC);

            CREATE TABLE IF NOT EXISTS filter_runs (
                id           BIGSERIAL PRIMARY KEY,
                label        TEXT,
                criteria     JSONB,
                result_count INTEGER,
                results      JSONB,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_filter_runs_created
                ON filter_runs (created_at DESC);

            CREATE TABLE IF NOT EXISTS watchlist (
                id          BIGSERIAL PRIMARY KEY,
                symbol      TEXT NOT NULL UNIQUE,
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_watchlist_created ON watchlist (created_at DESC);
        `);
        ready = true;
        console.log(`✓ PostgreSQL connected — snapshot TTL ${SNAPSHOT_TTL_DAYS}d, history retention ${HISTORY_RETENTION_DAYS}d`);
        // Prune stale rows on boot, then schedule periodic cleanup.
        await cleanup();
        setInterval(() => cleanup().catch(() => {}), 6 * 60 * 60 * 1000); // every 6h
        return true;
    } catch (err) {
        console.warn('⚠ PostgreSQL init failed — falling back to JSON:', err.message);
        ready = false;
        return false;
    }
}

/**
 * Store a snapshot payload of a given kind with a freshness window.
 */
async function saveSnapshot(kind, payload, ttlDays = SNAPSHOT_TTL_DAYS) {
    if (!ready) return;
    try {
        await pool.query(
            `INSERT INTO snapshots (kind, payload, expires_at)
             VALUES ($1, $2::jsonb, NOW() + ($3 || ' days')::interval)`,
            [kind, JSON.stringify(payload), String(ttlDays)]
        );
    } catch (err) {
        console.warn(`⚠ saveSnapshot(${kind}) failed:`, err.message);
    }
}

/**
 * Return the most recent non-expired snapshot of a kind, or null.
 */
async function getFreshSnapshot(kind) {
    if (!ready) return null;
    try {
        const r = await pool.query(
            `SELECT payload, created_at, expires_at
             FROM snapshots
             WHERE kind = $1 AND expires_at > NOW()
             ORDER BY created_at DESC
             LIMIT 1`,
            [kind]
        );
        return r.rows[0] ? r.rows[0].payload : null;
    } catch (err) {
        console.warn(`⚠ getFreshSnapshot(${kind}) failed:`, err.message);
        return null;
    }
}

/**
 * Persist a filter run for later analysis. Returns the new row id (or null).
 */
async function saveFilterRun({ label, criteria, results }) {
    if (!ready) return null;
    try {
        const count = Array.isArray(results) ? results.length : null;
        const r = await pool.query(
            `INSERT INTO filter_runs (label, criteria, result_count, results)
             VALUES ($1, $2::jsonb, $3, $4::jsonb)
             RETURNING id, created_at`,
            [
                label || null,
                criteria != null ? JSON.stringify(criteria) : null,
                count,
                results != null ? JSON.stringify(results) : null
            ]
        );
        return r.rows[0];
    } catch (err) {
        console.warn('⚠ saveFilterRun failed:', err.message);
        return null;
    }
}

/**
 * List recent filter-run history (without the heavy results blob).
 */
async function listFilterRuns(limit = 50) {
    if (!ready) return [];
    try {
        const r = await pool.query(
            `SELECT id, label, criteria, result_count, created_at
             FROM filter_runs
             ORDER BY created_at DESC
             LIMIT $1`,
            [Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)]
        );
        return r.rows;
    } catch (err) {
        console.warn('⚠ listFilterRuns failed:', err.message);
        return [];
    }
}

/**
 * Fetch a single stored filter run including its results.
 */
async function getFilterRun(id) {
    if (!ready) return null;
    try {
        const r = await pool.query(
            `SELECT id, label, criteria, result_count, results, created_at
             FROM filter_runs WHERE id = $1`,
            [parseInt(id, 10)]
        );
        return r.rows[0] || null;
    } catch (err) {
        console.warn('⚠ getFilterRun failed:', err.message);
        return null;
    }
}

/**
 * Fetch recent filter runs INCLUDING their full results blob, ordered newest
 * first.  Used by the AI trend-prediction endpoint.
 *
 * @param {number} limit - Max rows to return (capped at 50)
 * @returns {Promise<object[]>}
 */
async function getRecentFilterRuns(limit = 10) {
    if (!ready) return [];
    try {
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
        const r = await pool.query(
            `SELECT id, label, criteria, result_count, results, created_at
             FROM filter_runs
             ORDER BY created_at DESC
             LIMIT $1`,
            [safeLimit]
        );
        return r.rows;
    } catch (err) {
        console.warn('⚠ getRecentFilterRuns failed:', err.message);
        return [];
    }
}

/**
 * Return the most recent non-expired fundamentals snapshot payload, or null.
 * Thin wrapper around getFreshSnapshot('fundamentals') for explicit naming.
 *
 * @returns {Promise<object|null>}
 */
async function getFundamentalsSnapshot() {
    return getFreshSnapshot('fundamentals');
}

/**
 * Global watchlist helpers
 */
async function listWatchlist() {
    if (!ready || !pool) return [];
    const { rows } = await pool.query(`
        SELECT symbol, created_at
        FROM watchlist
        ORDER BY created_at DESC
    `);
    return rows;
}

async function addToWatchlist(symbol) {
    if (!ready || !pool) return null;
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) throw new Error('symbol is required');

    const { rows } = await pool.query(
        `INSERT INTO watchlist (symbol)
         VALUES ($1)
         ON CONFLICT (symbol) DO NOTHING
         RETURNING symbol, created_at`,
        [normalized]
    );

    if (rows[0]) return rows[0];

    const existing = await pool.query(
        `SELECT symbol, created_at FROM watchlist WHERE symbol = $1`,
        [normalized]
    );
    return existing.rows[0] || null;
}

async function removeFromWatchlist(symbol) {
    if (!ready || !pool) return false;
    const normalized = String(symbol || '').trim().toUpperCase();
    if (!normalized) return false;
    const { rowCount } = await pool.query(
        `DELETE FROM watchlist WHERE symbol = $1`,
        [normalized]
    );
    return rowCount > 0;
}

/**
 * Delete expired snapshots and filter runs older than the retention window.
 */
async function cleanup() {
    if (!ready) return;
    try {
        const snap = await pool.query(`DELETE FROM snapshots WHERE expires_at <= NOW()`);
        const hist = await pool.query(
            `DELETE FROM filter_runs WHERE created_at < NOW() - ($1 || ' days')::interval`,
            [String(HISTORY_RETENTION_DAYS)]
        );
        if (snap.rowCount || hist.rowCount) {
            console.log(`  DB cleanup: removed ${snap.rowCount} expired snapshots, ${hist.rowCount} old filter runs`);
        }
    } catch (err) {
        console.warn('⚠ DB cleanup failed:', err.message);
    }
}

module.exports = {
    isEnabled,
    isReady: () => ready,
    initDb,
    saveSnapshot,
    getFreshSnapshot,
    saveFilterRun,
    listFilterRuns,
    getFilterRun,
    getRecentFilterRuns,
    getFundamentalsSnapshot,
    listWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    cleanup,
    SNAPSHOT_TTL_DAYS,
    HISTORY_RETENTION_DAYS,
};
