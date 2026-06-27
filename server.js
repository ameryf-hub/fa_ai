require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const db = require('./db');
const { runSkillRunner } = require('./skillRunner');
const { createServer } = require('http');
const { Server } = require('socket.io');

// ════════════════════════════════════════════════════════════════════════════════
// ── CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════════

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FMP_KEY = process.env.FMP_API_KEY || '';
const CACHE_TTL = 60 * 1000; // 1 minute cache for API responses
const ENRICH_LIMIT = 60; // Max candidates to enrich via per-symbol profile calls
let RUSSELL_EXTRA = []; // Will be loaded from russell-extra.json

/**
 * Load Russell extra tickers from JSON file
 */
async function loadRussellExtra() {
    try {
        const filePath = path.join(__dirname, 'russell-extra.json');
        const data = await fs.readFile(filePath, 'utf-8');
        const config = JSON.parse(data);
        RUSSELL_EXTRA = Array.isArray(config.tickers) ? config.tickers : [];
        console.log(`✓ Loaded ${RUSSELL_EXTRA.length} Russell extra tickers`);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('ℹ russell-extra.json not found; continuing without extra tickers.');
        } else {
            console.warn('⚠ Failed to load russell-extra.json:', error.message);
        }
        RUSSELL_EXTRA = [];
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// ── SCANNER STATE & SCHEDULER
// ════════════════════════════════════════════════════════════════════════════════

let isScanning = false; // Prevent overlapping scans
let lastAutoRunAt = null; // Last scheduled auto-run timestamp
let lastManualRunAt = null; // Last manual trigger timestamp
let scanScheduler = null; // Scheduler interval ID
let io = null; // Socket.IO instance (initialized with HTTP server)
const DEEP_DIVE_DB = path.join(__dirname, 'data', 'deep-dive-results.json');

/**
 * Save deep-dive results to DB and JSON file
 */
async function saveDeepDiveResults(results) {
    const payload = {
        timestamp: new Date().toISOString(),
        results
    };

    // Save to PostgreSQL if available
    if (db.isReady()) {
        try {
            await db.saveSnapshot('deep-dive', payload);
        } catch (e) {
            console.warn('  ⚠ Failed to save deep-dive to PostgreSQL:', e.message);
        }
    }

    // Always save to JSON file as fallback
    try {
        await fs.mkdir(path.dirname(DEEP_DIVE_DB), { recursive: true });
        await fs.writeFile(DEEP_DIVE_DB, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`  ✓ Saved deep-dive results to data/deep-dive-results.json`);
    } catch (e) {
        console.warn('  ⚠ Failed to save deep-dive results to file:', e.message);
    }
}

/**
 * Execute the full scanner pipeline: screener + skill runner
 */
async function executeScannerPipeline(isAutomatic = false) {
    if (isScanning) {
        console.log('  Scanner already running, skipping...');
        return null;
    }

    isScanning = true;
    const startTime = Date.now();
    const label = isAutomatic ? 'AUTO-RUN' : 'MANUAL-RUN';

    console.log(`\n[${label}] Starting full scanner pipeline [${getETTime()}]...`);
    if (io) io.emit('scanStarted', { label, startTime });

    try {
        // Step 1: Run screener
        if (io) io.emit('scanProgress', { step: 'screener', message: 'Fetching market data...' });
        
        console.log('  Fetching index constituents...');
        const universe = await fetchConstituents();

        const quotes = await batchQuotes(universe.map(u => u.ticker));
        console.log(`  Got quotes for ${Object.keys(quotes).length} tickers`);

        const profiles = await enrichProfiles(Object.keys(quotes).slice(0, ENRICH_LIMIT));

        const VOL_THRESHOLD = 1.3;
        const results = [];

        for (const ticker of Object.keys(quotes)) {
            const q = quotes[ticker];
            const p = profiles[ticker] || {};

            const price = p.price ?? q.price;
            const volume = p.volume ?? q.volume ?? 0;
            const avgVolume = p.averageVolume ?? 0;
            const volRatio = avgVolume > 0
                ? Math.round((volume / avgVolume) * 10) / 10
                : null;

            if (volRatio != null && volRatio < VOL_THRESHOLD) continue;

            let yearHigh = 0;
            let yearLow = 0;
            if (typeof p.range === 'string' && p.range.includes('-')) {
                const [lo, hi] = p.range.split('-').map(v => parseFloat(v));
                if (!Number.isNaN(lo)) yearLow = lo;
                if (!Number.isNaN(hi)) yearHigh = hi;
            }

            const pct52H = yearHigh > 0 ? Math.round((price / yearHigh) * 100) : 0;
            const beta = (p.beta ?? q.beta) != null
                ? Math.round((p.beta ?? q.beta) * 100) / 100
                : null;
            const mktCap = p.marketCap ?? q.marketCap ?? 0;

            const score = computeScore({ volRatio, revGrowth: null, pe: null, epsGrowth: null, pct52H, beta });

            results.push({
                ticker,
                companyName: p.companyName || q.companyName || ticker,
                exchange: p.exchange || q.exchange || '—',
                sector: p.sector || q.sector || '—',
                price,
                change: Math.round((p.changePercentage ?? q.changePercentage ?? 0) * 100) / 100,
                mktCap,
                volRatio,
                volume,
                avgVolume,
                pct52H,
                yearHigh,
                yearLow,
                beta,
                score
            });
        }

        results.sort((a, b) => b.score - a.score);
        const top20Symbols = results.slice(0, 20).map(r => r.ticker);

        console.log(`  ✓ Screener complete: ${results.length} stocks, top 20: ${top20Symbols.join(', ')}`);

        // Step 2: Run skill runner on top 20
        if (io) io.emit('scanProgress', { step: 'skill-runner', message: `Running AI analysis on ${top20Symbols.length} stocks...` });
        
        console.log(`  Running Skill Runner on top 20 symbols...`);
        const deepDiveResults = await runSkillRunner(top20Symbols);
        
        if (io) {
            deepDiveResults.forEach((result, idx) => {
                io.emit('scanProgress', {
                    step: 'skill-runner',
                    message: `Analyzed ${result.symbol}`,
                    progress: Math.round(((idx + 1) / deepDiveResults.length) * 100)
                });
            });
        }

        await saveDeepDiveResults(deepDiveResults);

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`  ✓ Scanner pipeline complete in ${elapsed}s [${getETTime()}]`);

        const response = {
            label,
            screenerResults: results,
            topStocks: results.slice(0, 20),
            deepDiveResults,
            elapsedSeconds: elapsed,
            completedAt: new Date().toISOString()
        };

        if (io) io.emit('scanCompleted', response);

        if (isAutomatic) lastAutoRunAt = new Date().toISOString();
        else lastManualRunAt = new Date().toISOString();

        return response;
    } catch (err) {
        console.error(`  ✗ Scanner pipeline failed: ${err.message}`);
        if (io) io.emit('scanError', { error: err.message });
        return null;
    } finally {
        isScanning = false;
    }
}

/**
 * Initialize the scheduler for auto-runs at 9:30 AM and 3:30 PM ET
 */
function initializeScheduler() {
    const schedule = () => {
        const now = new Date();
        const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const hours = etTime.getHours();
        const minutes = etTime.getMinutes();

        // Check if it's 9:30 AM or 3:30 PM ET
        const is9_30 = hours === 9 && minutes === 30;
        const is3_30 = hours === 15 && minutes === 30;

        if (is9_30 || is3_30) {
            console.log(`\n[SCHEDULER] Triggering auto-run at ${hours}:${minutes < 10 ? '0' : ''}${minutes} ET`);
            executeScannerPipeline(true).catch(err => {
                console.error('[SCHEDULER] Auto-run failed:', err.message);
            });
        }
    };

    // Check every minute
    scanScheduler = setInterval(schedule, 60 * 1000);
    console.log('✓ Scanner scheduler initialized (9:30 AM & 3:30 PM ET)');
}

// ════════════════════════════════════════════════════════════════════════════════
// ── UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Sleep for specified milliseconds
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Get current time in ET (Eastern Time)
 */
function getETTime() {
    return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' });
}

/**
 * Make a GET request to FMP API with automatic key injection
 */
async function fmpGet(endpoint) {
    if (!FMP_KEY) {
        throw new Error('FMP_API_KEY environment variable is not set');
    }
    const sep = endpoint.includes('?') ? '&' : '?';
    const url = `${FMP_BASE}/${endpoint}${sep}apikey=${FMP_KEY}`;
    try {
        const res = await axios.get(url, { timeout: 15000 });
        return res.data;
    } catch (error) {
        const errorMsg = error.response?.status === 401 
            ? 'Invalid FMP API key' 
            : error.message;
        throw new Error(`FMP API error: ${errorMsg}`);
    }
}

/**
 * Simple in-memory cache for API responses
 */
class SimpleCache {
    constructor(ttl = CACHE_TTL) {
        this.cache = new Map();
        this.ttl = ttl;
    }

    get(key) {
        const cached = this.cache.get(key);
        if (!cached) return null;
        if (Date.now() - cached.timestamp > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        return cached.data;
    }

    set(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    clear() {
        this.cache.clear();
    }
}

const apiCache = new SimpleCache();

// ════════════════════════════════════════════════════════════════════════════════
// ── EXPRESS APP SETUP
// ════════════════════════════════════════════════════════════════════════════════

const app = express();

// Socket.IO setup for real-time updates (will be attached to HTTP server on startup)
// io instance will be initialized when server starts

// Middleware: JSON parsing
app.use(express.json());

// Middleware: Rate limiting
// Limits API requests to prevent abuse and API quota depletion.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX = 30; // 30 requests per minute

app.use('/api/', (req, res, next) => {
    if (req.path === '/health') return next();

    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, start: now };

    if (now - entry.start > RATE_LIMIT_WINDOW_MS) {
        entry.count = 1;
        entry.start = now;
    } else {
        entry.count += 1;
    }

    rateLimitMap.set(ip, entry);

    res.setHeader('RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - entry.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.start + RATE_LIMIT_WINDOW_MS - now) / 1000)));

    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            error: 'Too many requests from this IP, please try again later.'
        });
    }
    next();
});

// Middleware: CORS (restricted to specific origins)
app.use((req, res, next) => {
    const allowedOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : ['http://localhost:3000', 'http://localhost:5000'];

    const origin = req.headers.origin;
    if (allowedOrigins.includes('*')) {
        res.header('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Middleware: Static files
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════════════════════════════════
// ── BUSINESS LOGIC FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Fetch index constituents from FMP (SP500, NASDAQ, Russell)
 */
async function fetchConstituents() {
    console.log('  Fetching index constituents...');
    let sp500 = [];
    let ndx = [];

    try {
        const d = await fmpGet('sp500-constituent');
        sp500 = Array.isArray(d) 
            ? d.map(x => ({ ticker: x.symbol, index: 'SP500', sector: x.sector || '—' })) 
            : [];
        console.log(`  SP500: ${sp500.length} tickers`);
    } catch (e) {
        console.warn('  SP500 constituents failed:', e.message);
    }

    try {
        const d = await fmpGet('nasdaq-constituent');
        ndx = Array.isArray(d)
            ? d.map(x => ({ ticker: x.symbol, index: 'NDX', sector: x.sector || '—' }))
            : [];
        console.log(`  NDX: ${ndx.length} tickers`);
    } catch (e) {
        console.warn('  NDX constituents failed:', e.message);
    }

    // Merge: prefer NDX label for dual-listed tickers; add Russell extras
    const seen = new Set();
    const universe = [];

    for (const s of ndx) {
        if (!seen.has(s.ticker)) {
            seen.add(s.ticker);
            universe.push(s);
        }
    }

    // Then SP500
    for (const s of sp500) {
        if (!seen.has(s.ticker)) {
            seen.add(s.ticker);
            universe.push(s);
        }
    }

    // Then Russell extras
    for (const ticker of RUSSELL_EXTRA) {
        if (!seen.has(ticker)) {
            seen.add(ticker);
            universe.push({ ticker, index: 'RUT', sector: '—' });
        }
    }

    console.log(`  Universe: ${universe.length} unique tickers`);
    return universe;
}

/**
 * Fetch quotes for tickers with parallelization and throttling
 */
async function batchQuotes(tickers) {
    const results = {};
    const batchSize = 10; // Parallel requests per batch
    const throttleDelay = 100; // ms between batches

    for (let i = 0; i < tickers.length; i += batchSize) {
        const batch = tickers.slice(i, i + batchSize);
        
        const promises = batch.map(ticker =>
            fmpGet(`quote/${ticker}`)
                .then(data => {
                    const q = Array.isArray(data) ? data[0] : data;
                    if (q && q.symbol && q.price) {
                        results[q.symbol] = q;
                    }
                })
                .catch(e => {
                    console.warn(`  Quote fetch for ${ticker} failed:`, e.message);
                })
        );

        await Promise.all(promises);
        
        // Throttle between batches to avoid rate limiting
        if (i + batchSize < tickers.length) {
            await sleep(throttleDelay);
        }
    }

    return results;
}

/**
 * Fetch detailed company info (profile + financial-growth)
 */
async function fetchDetail(sym) {
    let beta = null;
    let exchange = '—';
    let companyName = sym;
    let description = '';
    let website = '';
    let revGrowth = null;
    let epsGrowth = null;

    try {
        const data = await fmpGet(`profile?symbol=${sym}`);
        const p = Array.isArray(data) ? data[0] : null;
        if (p) {
            beta = p.beta != null ? Math.round(p.beta * 100) / 100 : null;
            exchange = p.exchange || '—';
            companyName = p.companyName || sym;
            description = p.description || '';
            website = p.website || '';
        }
    } catch (e) {
        console.warn(`  Profile fetch for ${sym} failed:`, e.message);
    }

    try {
        const data = await fmpGet(`financial-growth?symbol=${sym}&limit=1`);
        const g = Array.isArray(data) ? data[0] : null;
        if (g) {
            revGrowth = g.revenueGrowth != null ? Math.round(g.revenueGrowth * 1000) / 10 : null;
            epsGrowth = g.epsgrowth != null ? Math.round(g.epsgrowth * 1000) / 10 : null;
        }
    } catch (e) {
        console.warn(`  Financial growth fetch for ${sym} failed:`, e.message);
    }

    return { beta, exchange, companyName, description, website, revGrowth, epsGrowth };
}

/**
 * Enrich a list of symbols with profile data (averageVolume, 52-week range,
 * beta, etc.) using the /stable/profile endpoint. Profile only accepts a
 * single symbol per request, so calls are batched with light throttling.
 */
async function enrichProfiles(symbols) {
    const profiles = {};
    const batchSize = 10;
    const throttleDelay = 100;

    for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);

        await Promise.all(batch.map(async (sym) => {
            try {
                const data = await fmpGet(`profile?symbol=${encodeURIComponent(sym)}`);
                const p = Array.isArray(data) ? data[0] : data;
                if (p && p.symbol) {
                    profiles[p.symbol] = p;
                }
            } catch (e) {
                console.warn(`  Profile fetch for ${sym} failed:`, e.message);
            }
        }));

        if (i + batchSize < symbols.length) {
            await sleep(throttleDelay);
        }
    }

    return profiles;
}

/**
 * Compute stock screening score based on multiple factors
 */
function computeScore({ volRatio, revGrowth, pe, epsGrowth, pct52H, beta }) {
    // Volume ratio score (0-40 points)
    const volScore = Math.min(40, (volRatio / 6) * 40);

    // Fundamental score (0-35 points)
    const fundScore = Math.min(35,
        (revGrowth != null ? Math.min(25, (revGrowth / 50) * 25) : 8) +
        (pe != null && pe > 0 && pe < 80 ? 5 : 0) +
        ((epsGrowth || 0) > 0 ? 5 : 0)
    );

    // Base score (0-25 points)
    const baseScore = Math.min(25,
        (pct52H >= 95 ? 15 : pct52H >= 85 ? 10 : pct52H >= 70 ? 5 : 2) +
        (beta != null ? (beta < 1.0 ? 10 : beta < 1.5 ? 6 : beta < 2.0 ? 3 : 0) : 3)
    );

    return Math.max(0, Math.min(100, Math.round(volScore + fundScore + baseScore)));
}

// ════════════════════════════════════════════════════════════════════════════════
// ── FUNDAMENTALS ANALYSIS (Data Explorer)
// ════════════════════════════════════════════════════════════════════════════════

// Simple JSON file "database" for the analysis snapshot.
const DATA_DIR = path.join(__dirname, 'data');
const FUNDAMENTALS_DB = path.join(DATA_DIR, 'fundamentals.json');

// How many of the largest companies to analyse per refresh. Kept modest to
// stay within FMP rate limits (each symbol triggers several endpoint calls).
const FUNDAMENTALS_LIMIT = 50;

/**
 * Read the first numeric value found across a list of candidate keys.
 */
function pickNum(obj, keys) {
    if (!obj) return null;
    for (const k of keys) {
        const v = obj[k];
        if (v != null && v !== '' && Number.isFinite(Number(v))) {
            return Number(v);
        }
    }
    return null;
}

const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

/**
 * Fetch a single endpoint and return the first object (or null on failure).
 */
async function fmpFirst(endpoint) {
    try {
        const data = await fmpGet(endpoint);
        if (Array.isArray(data)) return data[0] || null;
        return data || null;
    } catch (e) {
        return null;
    }
}

/**
 * Fetch the full fundamentals bundle for one symbol and compute scores.
 */
async function fetchFundamentals(sym) {
    const enc = encodeURIComponent(sym);

    const [profile, ratios, keyMetrics, growth, dcf, scores, estimatesRaw] = await Promise.all([
        fmpFirst(`profile?symbol=${enc}`),
        fmpFirst(`ratios-ttm?symbol=${enc}`),
        fmpFirst(`key-metrics-ttm?symbol=${enc}`),
        fmpFirst(`financial-growth?symbol=${enc}&limit=1`),
        fmpFirst(`discounted-cash-flow?symbol=${enc}`),
        fmpFirst(`financial-scores?symbol=${enc}`),
        (async () => {
            try {
                const d = await fmpGet(`analyst-estimates?symbol=${enc}&period=annual&limit=6`);
                return Array.isArray(d) ? d : [];
            } catch (e) { return []; }
        })()
    ]);

    const price = pickNum(profile, ['price']) ?? pickNum(dcf, ['Stock Price', 'price']);
    const mktCap = pickNum(profile, ['marketCap', 'mktCap']);

    // Current (trailing) P/E.
    const pe = pickNum(ratios, ['priceToEarningsRatioTTM', 'peRatioTTM'])
        ?? pickNum(keyMetrics, ['peRatioTTM'])
        ?? pickNum(profile, ['pe']);

    // Revenue growth (trailing YoY) as a percentage.
    const revGrowth = (() => {
        const g = pickNum(growth, ['revenueGrowth']);
        return g == null ? null : round(g * 100, 1);
    })();

    // Discounted cash flow fair value.
    const dcfValue = pickNum(dcf, ['dcf', 'discountedCashFlow']);
    const dcfUpside = (dcfValue != null && price) ? round(((dcfValue - price) / price) * 100, 1) : null;

    // Altman Z-Score and Piotroski F-Score.
    const altman = pickNum(scores, ['altmanZScore', 'altmanZ']);
    const piotroski = pickNum(scores, ['piotroskiScore', 'piotroski']);

    // Forward estimates: pull annual analyst estimates sorted ascending by date.
    const estimates = estimatesRaw
        .map(e => ({
            year: (e.date || '').slice(0, 4),
            eps: pickNum(e, ['estimatedEpsAvg', 'epsAvg', 'estimatedEps']),
            rev: pickNum(e, ['estimatedRevenueAvg', 'revenueAvg', 'estimatedRevenue'])
        }))
        .filter(e => e.year)
        .sort((a, b) => a.year - b.year);

    const nowYear = new Date().getFullYear();
    const future = estimates.filter(e => Number(e.year) >= nowYear);

    // Forward P/E from the nearest future-year EPS estimate.
    let forwardPE = null;
    const nextEps = future.find(e => e.eps != null && e.eps > 0);
    if (nextEps && price) forwardPE = round(price / nextEps.eps, 2);

    // Expected revenue growth (CAGR) across available forward estimates.
    let fwdRevGrowth = null;
    const revPts = future.filter(e => e.rev != null && e.rev > 0);
    if (revPts.length >= 2) {
        const first = revPts[0];
        const last = revPts[revPts.length - 1];
        const yrs = Number(last.year) - Number(first.year);
        if (yrs > 0) {
            fwdRevGrowth = round((Math.pow(last.rev / first.rev, 1 / yrs) - 1) * 100, 1);
        }
    }

    // ── Composite scores (0–100) ──
    // Growth: trailing revenue growth + forward revenue growth.
    const growthScore = (() => {
        const a = revGrowth != null ? Math.min(50, Math.max(0, (revGrowth / 40) * 50)) : 15;
        const b = fwdRevGrowth != null ? Math.min(50, Math.max(0, (fwdRevGrowth / 25) * 50)) : 15;
        return Math.round(a + b);
    })();

    // Value: lower P/E and DCF upside score higher.
    const valueScore = (() => {
        let peScore = 25;
        if (pe != null && pe > 0) peScore = Math.max(0, Math.min(50, 50 - (pe - 10) * 1.2));
        let dcfScore = 25;
        if (dcfUpside != null) dcfScore = Math.max(0, Math.min(50, 25 + dcfUpside * 0.5));
        return Math.round(peScore + dcfScore);
    })();

    // Quality: Altman Z (solvency) + Piotroski F (fundamental health).
    const qualityScore = (() => {
        let z = 20;
        if (altman != null) z = Math.max(0, Math.min(50, (altman / 6) * 50));
        let f = 25;
        if (piotroski != null) f = Math.max(0, Math.min(50, (piotroski / 9) * 50));
        return Math.round(z + f);
    })();

    return {
        ticker: sym,
        companyName: profile?.companyName || sym,
        sector: profile?.sector || '—',
        exchange: profile?.exchange || '—',
        price: round(price, 2),
        mktCap: mktCap || 0,
        pe: round(pe, 2),
        forwardPE,
        dcf: round(dcfValue, 2),
        dcfUpside,
        revGrowth,
        fwdRevGrowth,
        altman: round(altman, 2),
        piotroski: piotroski != null ? Math.round(piotroski) : null,
        growthScore,
        valueScore,
        qualityScore
    };
}

/**
 * Build the fundamentals dataset for the largest companies and persist it.
 */
async function buildFundamentals() {
    console.log('  Building fundamentals dataset...');
    const url = `${FMP_BASE}/company-screener?apikey=${FMP_KEY}`;
    const response = await axios.get(url, { timeout: 30000 });
    const raw = Array.isArray(response.data) ? response.data : [];

    const candidates = raw
        .filter(s =>
            s.symbol &&
            s.price != null &&
            s.isActivelyTrading !== false &&
            !s.isEtf &&
            !s.isFund &&
            (s.country == null || s.country === 'US') &&
            (s.marketCap || 0) > 0
        )
        .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
        .slice(0, FUNDAMENTALS_LIMIT);

    const stocks = [];
    const batchSize = 5;
    for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const rows = await Promise.all(batch.map(c => fetchFundamentals(c.symbol)));
        stocks.push(...rows.filter(Boolean));
        if (i + batchSize < candidates.length) await sleep(120);
    }

    // Sort by market cap descending by default.
    stocks.sort((a, b) => (b.mktCap || 0) - (a.mktCap || 0));

    const payload = {
        lastUpdated: getETTime(),
        generatedAt: new Date().toISOString(),
        count: stocks.length,
        stocks
    };

    // Persist to PostgreSQL (time-bounded snapshot) when available...
    await db.saveSnapshot('fundamentals', payload);

    // ...and always keep a local JSON copy as a fallback / export source.
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(FUNDAMENTALS_DB, JSON.stringify(payload, null, 2), 'utf-8');
        console.log(`  ✓ Saved ${stocks.length} rows to data/fundamentals.json`);
    } catch (e) {
        console.warn('  ⚠ Failed to persist fundamentals DB:', e.message);
    }

    return payload;
}

// ════════════════════════════════════════════════════════════════════════════════
// ── ROUTES
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Root route: Serve index.html
 */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * Health check endpoint
 * Returns server status without exposing API keys
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        uptime: process.uptime()
    });
});

/**
 * Main screener refresh endpoint
 * Fetches and scores stocks from FMP company-screener
 */
app.get('/api/screener-refresh', async (req, res) => {
    console.log(`\n=== APEX SCREENER REFRESH [${getETTime()}] ===`);

    try {
        // Check cache first
        const cacheKey = 'screener-results';
        const cached = apiCache.get(cacheKey);
        if (cached) {
            console.log('  Returning cached results');
            return res.json(cached);
        }

        // Fetch from FMP company-screener
        console.log('  Calling FMP company-screener...');
        const url = `${FMP_BASE}/company-screener?apikey=${FMP_KEY}`;
        const response = await axios.get(url, { timeout: 30000 });
        const raw = Array.isArray(response.data) ? response.data : [];
        console.log(`  company-screener returned ${raw.length} stocks`);

        // The /stable/company-screener payload only carries basic fields (no
        // averageVolume or 52-week range). Narrow to tradable common stocks,
        // then enrich the most liquid candidates via /stable/profile, which
        // does include averageVolume, the 52-week range and beta.
        const candidates = raw
            .filter(s =>
                s.symbol &&
                s.price != null &&
                s.isActivelyTrading !== false &&
                !s.isEtf &&
                !s.isFund &&
                (s.country == null || s.country === 'US') &&
                (s.volume || 0) > 0
            )
            .sort((a, b) => (b.volume || 0) - (a.volume || 0))
            .slice(0, ENRICH_LIMIT);

        console.log(`  Enriching ${candidates.length} candidates via /stable/profile...`);
        const profiles = await enrichProfiles(candidates.map(c => c.symbol));

        const VOL_THRESHOLD = 1.3;
        const results = [];

        for (const s of candidates) {
            const p = profiles[s.symbol] || {};

            const price = p.price ?? s.price;
            const volume = p.volume ?? s.volume ?? 0;
            const avgVolume = p.averageVolume ?? 0;
            const volRatio = avgVolume > 0
                ? Math.round((volume / avgVolume) * 10) / 10
                : null;

            if (volRatio != null && volRatio < VOL_THRESHOLD) continue;

            // 52-week range arrives as a "low-high" string on the profile.
            let yearHigh = 0;
            let yearLow = 0;
            if (typeof p.range === 'string' && p.range.includes('-')) {
                const [lo, hi] = p.range.split('-').map(v => parseFloat(v));
                if (!Number.isNaN(lo)) yearLow = lo;
                if (!Number.isNaN(hi)) yearHigh = hi;
            }

            const pct52H = yearHigh > 0 ? Math.round((price / yearHigh) * 100) : 0;
            const pe = null; // not exposed by these endpoints
            const beta = (p.beta ?? s.beta) != null
                ? Math.round((p.beta ?? s.beta) * 100) / 100
                : null;
            const mktCap = p.marketCap ?? s.marketCap ?? 0;

            // Not available without additional per-symbol financial calls.
            const revGrowth = null;
            const epsGrowth = null;

            const score = computeScore({ volRatio, revGrowth, pe, epsGrowth, pct52H, beta });

            results.push({
                ticker: s.symbol,
                companyName: p.companyName || s.companyName || s.symbol,
                exchange: p.exchange || s.exchange || '—',
                index: s.index || '—',
                sector: p.sector || s.sector || '—',
                price,
                change: Math.round((p.changePercentage ?? s.changesPercentage ?? s.changePercentage ?? 0) * 100) / 100,
                mktCap,
                volRatio,
                volume,
                avgVolume,
                revGrowth,
                epsGrowth,
                pct52H,
                yearHigh,
                yearLow,
                beta,
                pe,
                score,
                description: p.description || '',
                website: p.website || ''
            });
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        const responseData = {
            lastUpdated: getETTime(),
            total: raw.length,
            stocks: results
        };

        // Cache the results
        apiCache.set(cacheKey, responseData);

        console.log(`\n✓ ${results.length} stocks returned (from ${raw.length} screener results). [${getETTime()}]`);
        res.json(responseData);

    } catch (err) {
        console.error('Pipeline error:', err.message);
        res.status(500).json({
            error: 'Screener refresh failed',
            message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
        });
    }
});

/**
 * Fundamentals dataset endpoint (Data Explorer).
 * Returns the cached/saved snapshot. Pass ?refresh=1 to rebuild from FMP.
 */
app.get('/api/fundamentals', async (req, res) => {
    console.log(`\n=== FUNDAMENTALS REQUEST [${getETTime()}] ===`);
    try {
        const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';

        if (!forceRefresh) {
            // 1) In-memory cache (fastest)
            const cached = apiCache.get('fundamentals');
            if (cached) {
                console.log('  Returning cached fundamentals');
                return res.json(cached);
            }
            // 2) PostgreSQL snapshot within its freshness window
            const snap = await db.getFreshSnapshot('fundamentals');
            if (snap) {
                apiCache.set('fundamentals', snap);
                console.log('  Returning fundamentals from PostgreSQL snapshot');
                return res.json(snap);
            }
            // 3) On-disk JSON database (local fallback)
            try {
                const disk = await fs.readFile(FUNDAMENTALS_DB, 'utf-8');
                const parsed = JSON.parse(disk);
                apiCache.set('fundamentals', parsed);
                console.log('  Returning fundamentals from disk DB');
                return res.json(parsed);
            } catch (e) {
                // No saved DB yet — fall through to build it.
            }
        }

        const payload = await buildFundamentals();
        apiCache.set('fundamentals', payload);
        res.json(payload);
    } catch (err) {
        console.error('Fundamentals error:', err.message);
        res.status(500).json({
            error: 'Fundamentals build failed',
            message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
        });
    }
});

/**
 * Save a filter run to the history log for later analysis.
 * Body: { label?, criteria?, results: [...] }
 * Auto-deleted after the retention window (default 90 days).
 */
app.post('/api/filter-runs', async (req, res) => {
    if (!db.isReady()) {
        return res.status(503).json({ error: 'History database not configured' });
    }
    try {
        const { label, criteria, results } = req.body || {};
        if (!Array.isArray(results)) {
            return res.status(400).json({ error: 'results array is required' });
        }
        const row = await db.saveFilterRun({ label, criteria, results });
        res.json({ saved: true, id: row?.id ?? null, createdAt: row?.created_at ?? null });
    } catch (err) {
        res.status(500).json({ error: 'Failed to save filter run', message: err.message });
    }
});

/**
 * List recent filter-run history (metadata only, newest first).
 */
app.get('/api/filter-runs', async (req, res) => {
    if (!db.isReady()) return res.json({ runs: [], dbEnabled: false });
    const runs = await db.listFilterRuns(req.query.limit);
    res.json({ runs, dbEnabled: true, retentionDays: db.HISTORY_RETENTION_DAYS });
});

/**
 * Fetch a single stored filter run (including its full results).
 */
app.get('/api/filter-runs/:id', async (req, res) => {
    if (!db.isReady()) return res.status(503).json({ error: 'History database not configured' });
    const run = await db.getFilterRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Filter run not found' });
    res.json(run);
});

// ════════════════════════════════════════════════════════════════════════════════
// ── SCANNER ENDPOINTS (Scheduled + Manual Trigger)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Manual trigger: Start a scanner run immediately
 * Frontend calls this to run on-demand
 */
app.post('/api/scanner-run', async (req, res) => {
    if (isScanning) {
        return res.status(429).json({ 
            running: true, 
            message: 'Scanner already running. Please wait for completion.' 
        });
    }

    // Start scan in background (don't wait for response)
    res.json({ 
        running: true, 
        message: 'Scanner started. Updates will be sent via WebSocket.',
        label: 'MANUAL-RUN'
    });

    // Execute asynchronously without blocking response
    setImmediate(() => {
        executeScannerPipeline(false).catch(err => {
            console.error('Manual scanner run failed:', err.message);
            if (io) io.emit('scanError', { error: err.message, label: 'MANUAL-RUN' });
        });
    });
});

/**
 * Get current scanner status (running/idle, last run times, next scheduled run)
 */
app.get('/api/scanner-status', (req, res) => {
    const now = new Date();
    const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    
    // Calculate next scheduled run times
    let nextRunAt = null;
    const hours = etTime.getHours();
    const minutes = etTime.getMinutes();
    
    if (hours < 9 || (hours === 9 && minutes < 30)) {
        // Next run is 9:30 AM today
        const next = new Date(etTime);
        next.setHours(9, 30, 0, 0);
        nextRunAt = next.toISOString();
    } else if (hours < 15 || (hours === 15 && minutes < 30)) {
        // Next run is 3:30 PM today
        const next = new Date(etTime);
        next.setHours(15, 30, 0, 0);
        nextRunAt = next.toISOString();
    } else {
        // Next run is 9:30 AM tomorrow
        const next = new Date(etTime);
        next.setDate(next.getDate() + 1);
        next.setHours(9, 30, 0, 0);
        nextRunAt = next.toISOString();
    }

    res.json({
        isRunning: isScanning,
        lastAutoRunAt,
        lastManualRunAt,
        nextAutoRunAt: nextRunAt,
        currentTimeET: etTime.toISOString()
    });
});

/**
 * Get saved deep-dive results
 */
app.get('/api/deep-dive-results', async (req, res) => {
    try {
        const data = await fs.readFile(DEEP_DIVE_DB, 'utf-8');
        const payload = JSON.parse(data);
        res.json(payload);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return res.json({ error: 'No deep-dive results yet', results: [] });
        }
        res.status(500).json({ error: 'Failed to load deep-dive results', message: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── WATCHLIST HELPERS (JSON fallback when DB unavailable)
// ════════════════════════════════════════════════════════════════════════════

const WATCHLIST_FILE = path.join(__dirname, 'data', 'watchlist.json');

async function loadWatchlistJSON() {
    try {
        const data = await fs.readFile(WATCHLIST_FILE, 'utf-8');
        return JSON.parse(data).items || [];
    } catch (e) {
        return [];
    }
}

async function saveWatchlistJSON(items) {
    try {
        await fs.mkdir(path.dirname(WATCHLIST_FILE), { recursive: true });
        await fs.writeFile(WATCHLIST_FILE, JSON.stringify({ items }, null, 2));
    } catch (e) {
        console.warn('⚠ Failed to save watchlist JSON:', e.message);
    }
}

/**
 * Global watchlist endpoints (Railway PostgreSQL backed, with JSON fallback)
 */
app.get('/api/watchlist', async (req, res) => {
    try {
        if (db.isReady()) {
            const items = await db.listWatchlist();
            return res.json({ items, dbEnabled: true });
        } else {
            const items = await loadWatchlistJSON();
            return res.json({ items, dbEnabled: false });
        }
    } catch (err) {
        console.warn('⚠ Watchlist load failed:', err.message);
        return res.status(500).json({ error: 'Failed to load watchlist', message: err.message });
    }
});

app.post('/api/watchlist', async (req, res) => {
    try {
        const symbol = String(req.body?.symbol || '').trim().toUpperCase();
        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required' });
        }

        if (db.isReady()) {
            const item = await db.addToWatchlist(symbol);
            return res.json({ saved: true, item, dbEnabled: true });
        } else {
            // JSON fallback
            const items = await loadWatchlistJSON();
            // Check if already exists
            if (!items.some(i => i.symbol === symbol)) {
                items.push({ symbol, created_at: new Date().toISOString() });
                await saveWatchlistJSON(items);
            }
            return res.json({ 
                saved: true, 
                item: { symbol, created_at: new Date().toISOString() },
                dbEnabled: false 
            });
        }
    } catch (err) {
        console.warn('⚠ Add to watchlist failed:', err.message);
        return res.status(500).json({ error: 'Failed to add symbol', message: err.message });
    }
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
    try {
        const symbol = String(req.params.symbol || '').trim().toUpperCase();
        if (!symbol) {
            return res.status(400).json({ error: 'symbol is required' });
        }

        if (db.isReady()) {
            const removed = await db.removeFromWatchlist(symbol);
            return res.json({ removed, symbol, dbEnabled: true });
        } else {
            // JSON fallback
            const items = await loadWatchlistJSON();
            const beforeLen = items.length;
            const filtered = items.filter(i => i.symbol !== symbol);
            const removed = filtered.length < beforeLen;
            if (removed) {
                await saveWatchlistJSON(filtered);
            }
            return res.json({ removed, symbol, dbEnabled: false });
        }
    } catch (err) {
        console.warn('⚠ Remove from watchlist failed:', err.message);
        return res.status(500).json({ error: 'Failed to remove symbol', message: err.message });
    }
});

/**
 * Endpoint to get approximate universe size for progress indication
 */
app.get('/api/universe-size', (req, res) => {
    res.json({ size: 1600 }); // Approximate; adjust based on actual data
});

/**
 * AI Agent endpoint: parse natural language queries and fetch FMP data
 */
app.post('/api/ai-agent', async (req, res) => {
    try {
        const query = String(req.body?.query || '').trim();
        if (!query) {
            return res.status(400).json({ error: 'query is required' });
        }

        // Simple natural language parsing: extract ticker symbols and keywords
        const upperQuery = query.toUpperCase();
        const tickerPattern = /\b([A-Z]{1,5})\b/g;
        const tickers = [];
        let match;
        while ((match = tickerPattern.exec(upperQuery)) !== null) {
            const ticker = match[1];
            if (ticker.length <= 5 && !['FROM', 'FOR', 'THE', 'AND', 'GET', 'SHOW', 'FETCH'].includes(ticker)) {
                tickers.push(ticker);
            }
        }

        if (!tickers.length) {
            return res.json({
                error: 'No ticker symbols found in query (e.g., "Get earnings for AAPL" or "Show revenue for TSLA")',
                section: 'Error'
            });
        }

        const ticker = tickers[0]; // Use first ticker for now
        const sections = [];

        // Determine what data to fetch based on keywords
        const hasEarnings = /earnings|eps|net income|income/i.test(query);
        const hasRevenue = /revenue|sales|income/i.test(query);
        const hasProfile = /profile|sector|industry|company|description/i.test(query);
        const hasGrowth = /growth|grow/i.test(query);
        const hasPricing = /price|pe|valuation|value/i.test(query);
        const defaultFetch = !hasEarnings && !hasRevenue && !hasProfile && !hasGrowth && !hasPricing;

        try {
            // Fetch profile
            if (hasProfile || defaultFetch) {
                try {
                    const profileData = await fmpGet(`profile?symbol=${encodeURIComponent(ticker)}`);
                    const p = Array.isArray(profileData) ? profileData[0] : profileData;
                    if (p) {
                        sections.push({
                            title: `Company Profile: ${ticker}`,
                            data: {
                                'Company Name': p.companyName || '—',
                                'Sector': p.sector || '—',
                                'Industry': p.industry || '—',
                                'Exchange': p.exchange || '—',
                                'Market Cap': p.marketCap ? `$${(p.marketCap / 1e9).toFixed(2)}B` : '—',
                                'Website': p.website || '—',
                                'CEO': p.ceo || '—'
                            }
                        });
                    }
                } catch (e) {
                    console.warn(`Profile fetch for ${ticker} failed:`, e.message);
                }
            }

            // Fetch financial growth (revenue, EPS)
            if (hasRevenue || hasGrowth || hasEarnings || defaultFetch) {
                try {
                    const growthData = await fmpGet(`financial-growth?symbol=${encodeURIComponent(ticker)}&limit=1`);
                    const g = Array.isArray(growthData) ? growthData[0] : growthData;
                    if (g) {
                        const growthSection = {
                            title: `Financial Growth: ${ticker}`,
                            data: {}
                        };
                        if (g.revenueGrowth != null) {
                            growthSection.data['Revenue Growth (YoY)'] = `${(g.revenueGrowth * 100).toFixed(2)}%`;
                        }
                        if (g.epsgrowth != null) {
                            growthSection.data['EPS Growth'] = `${(g.epsgrowth * 100).toFixed(2)}%`;
                        }
                        if (g.grossProfitGrowth != null) {
                            growthSection.data['Gross Profit Growth'] = `${(g.grossProfitGrowth * 100).toFixed(2)}%`;
                        }
                        if (Object.keys(growthSection.data).length > 0) {
                            sections.push(growthSection);
                        }
                    }
                } catch (e) {
                    console.warn(`Growth fetch for ${ticker} failed:`, e.message);
                }
            }

            // Fetch key metrics (P/E, market cap, etc.)
            if (hasPricing || defaultFetch) {
                try {
                    const metricsData = await fmpGet(`key-metrics-ttm?symbol=${encodeURIComponent(ticker)}`);
                    const m = Array.isArray(metricsData) ? metricsData[0] : metricsData;
                    if (m) {
                        const metricsSection = {
                            title: `Key Metrics: ${ticker}`,
                            data: {}
                        };
                        if (m.peRatioTTM != null) {
                            metricsSection.data['P/E Ratio'] = m.peRatioTTM.toFixed(2);
                        }
                        if (m.pbRatioTTM != null) {
                            metricsSection.data['P/B Ratio'] = m.pbRatioTTM.toFixed(2);
                        }
                        if (m.roeTTM != null) {
                            metricsSection.data['ROE'] = `${(m.roeTTM * 100).toFixed(2)}%`;
                        }
                        if (m.roaTTM != null) {
                            metricsSection.data['ROA'] = `${(m.roaTTM * 100).toFixed(2)}%`;
                        }
                        if (Object.keys(metricsSection.data).length > 0) {
                            sections.push(metricsSection);
                        }
                    }
                } catch (e) {
                    console.warn(`Metrics fetch for ${ticker} failed:`, e.message);
                }
            }

            // Fetch current quote (price, volume)
            try {
                const quoteData = await fmpGet(`quote/${ticker}`);
                const q = Array.isArray(quoteData) ? quoteData[0] : quoteData;
                if (q && q.price) {
                    sections.push({
                        title: `Current Quote: ${ticker}`,
                        data: {
                            'Price': `$${q.price.toFixed(2)}`,
                            'Change': `${q.change != null ? q.change.toFixed(2) : '—'}%`,
                            'Volume': q.volume ? q.volume.toLocaleString() : '—',
                            'Avg Volume': q.avgVolume ? q.avgVolume.toLocaleString() : '—',
                            'High 52W': q.yearHigh != null ? `$${q.yearHigh.toFixed(2)}` : '—',
                            'Low 52W': q.yearLow != null ? `$${q.yearLow.toFixed(2)}` : '—'
                        }
                    });
                }
            } catch (e) {
                console.warn(`Quote fetch for ${ticker} failed:`, e.message);
            }

            if (sections.length === 0) {
                return res.json({
                    error: `No data found for ticker ${ticker}. Please verify the symbol is valid.`,
                    section: 'Error'
                });
            }

            res.json({
                title: `AI Agent: ${query}`,
                query,
                ticker,
                sections
            });
        } catch (err) {
            res.json({
                error: `Error fetching data for ${ticker}: ${err.message}`,
                section: 'Error'
            });
        }
    } catch (err) {
        res.status(500).json({
            error: `AI Agent error: ${err.message}`,
            section: 'Error'
        });
    }
});

/**
 * 404 handler — must come before the error handler so unknown routes fall through here.
 */
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'production' ? undefined : err.message
    });
});

// ════════════════════════════════════════════════════════════════════════════════
// ── EXPORT & SERVER STARTUP
// ════════════════════════════════════════════════════════════════════════════════

module.exports = app;

// Only start server if this file is run directly
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    
    // Load Russell extras and initialise the database before starting server
    Promise.all([loadRussellExtra(), db.initDb()]).then(([, dbOk]) => {
        // Create HTTP server and attach Socket.IO
        const httpServer = createServer(app);
        io = new Server(httpServer, {
            cors: {
                origin: process.env.ALLOWED_ORIGINS
                    ? process.env.ALLOWED_ORIGINS.split(',')
                    : ['http://localhost:3000', 'http://localhost:5000'],
                methods: ['GET', 'POST']
            }
        });

        // Socket.IO connection handler
        io.on('connection', (socket) => {
            console.log(`✓ WebSocket client connected: ${socket.id}`);
            
            // Send current status to newly connected client
            socket.emit('statusUpdate', {
                isRunning: isScanning,
                lastAutoRunAt,
                lastManualRunAt
            });

            socket.on('disconnect', () => {
                console.log(`✗ WebSocket client disconnected: ${socket.id}`);
            });
        });

        // Start the scheduler
        initializeScheduler();

        // Listen on HTTP server
        httpServer.listen(PORT, () => {
            console.log(`\n🚀 Apex Core Engine running on port ${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   FMP API Key: ${FMP_KEY ? '✓ Set' : '✗ Not set'}`);
            console.log(`   Database: ${dbOk ? '✓ PostgreSQL' : 'JSON fallback'}`);
            console.log(`   Rate Limiting: ✓ Enabled (30 req/min)`);
            console.log(`   Scanner: ✓ Scheduled (9:30 AM & 3:30 PM ET)`);
            console.log(`   WebSocket: ✓ Enabled\n`);
        });
    });
}