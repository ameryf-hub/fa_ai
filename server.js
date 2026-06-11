require('dotenv').config();
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

// ════════════════════════════════════════════════════════════════════════════════
// ── CONFIGURATION & CONSTANTS
// ════════════════════════════════════════════════════════════════════════════════

const FMP_BASE = 'https://financialmodelingprep.com/stable';
const FMP_KEY = process.env.FMP_API_KEY || '';
const CACHE_TTL = 60 * 1000; // 1 minute cache for API responses
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

        const VOL_THRESHOLD = 1.3;
        const results = [];

        for (const s of raw) {
            if (!s.symbol || s.price == null) continue;

            const volume = s.volume || 0;
            const avgVolume = s.averageVolume || 0;
            const volRatio = avgVolume > 0
                ? Math.round((volume / avgVolume) * 10) / 10
                : 1.0;

            if (volRatio < VOL_THRESHOLD) continue;

            const yearHigh = s.yearHigh || s['52WeekHigh'] || 0;
            const yearLow = s.yearLow || s['52WeekLow'] || 0;
            const pct52H = yearHigh > 0 ? Math.round((s.price / yearHigh) * 100) : 0;
            const pe = s.pe != null ? Math.round(s.pe * 10) / 10 : null;
            const beta = s.beta != null ? Math.round(s.beta * 100) / 100 : null;
            const mktCap = s.marketCap || 0;

            // These metrics aren't available from screener endpoint
            const revGrowth = null;
            const epsGrowth = null;

            const score = computeScore({ volRatio, revGrowth, pe, epsGrowth, pct52H, beta });

            results.push({
                ticker: s.symbol,
                companyName: s.companyName || s.symbol,
                exchange: s.exchange || '—',
                index: s.index || '—',
                sector: s.sector || '—',
                price: s.price,
                change: Math.round((s.changesPercentage || s.changePercentage || 0) * 100) / 100,
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
                description: s.description || '',
                website: s.website || ''
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
 * Endpoint to get approximate universe size for progress indication
 */
app.get('/api/universe-size', (req, res) => {
    res.json({ size: 1600 }); // Approximate; adjust based on actual data
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
    
    // Load Russell extra tickers before starting server
    loadRussellExtra().then(() => {
        app.listen(PORT, () => {
            console.log(`\n🚀 Apex Core Engine running on port ${PORT}`);
            console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
            console.log(`   FMP API Key: ${FMP_KEY ? '✓ Set' : '✗ Not set'}`);
            console.log(`   Rate Limiting: ✓ Enabled (30 req/min)\n`);
        });
    });
}