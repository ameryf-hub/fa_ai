// ════════════════════════════════════════════════════════════════════════════
// ── AI Analyzer — Claude-powered stock analysis
// ────────────────────────────────────────────────────────────────────────────
// Provides three capabilities:
//   1. analyzeFilterResults  — summarise screener output, surface patterns
//   2. predictTrends         — analyse historical filter runs for trends
//   3. answerQuestion        — natural-language Q&A over stored data
//
// All functions return a structured object so callers never have to parse
// raw Claude text.  If ANTHROPIC_API_KEY is absent every function rejects
// with a typed error that the route layer converts to a 503 response.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const Anthropic = require('@anthropic-ai/sdk');

// ── Client initialisation ────────────────────────────────────────────────────

let _client = null;

/**
 * Lazily create (and cache) the Anthropic client.
 * Throws a typed error when the key is absent so callers can return 503.
 */
function getClient() {
    if (_client) return _client;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        const err = new Error(
            'ANTHROPIC_API_KEY environment variable is not set. ' +
            'Add it in Railway → Variables before using AI features.'
        );
        err.code = 'MISSING_API_KEY';
        throw err;
    }

    _client = new Anthropic({ apiKey });
    return _client;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const MODEL = 'claude-opus-4-5';
const MAX_TOKENS = 1024;

/**
 * Send a single-turn message to Claude and return the text content.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
async function callClaude(systemPrompt, userMessage) {
    const client = getClient(); // throws if key missing
    const message = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
    });
    // Extract the first text block from the response
    const block = message.content.find(b => b.type === 'text');
    return block ? block.text : '';
}

/**
 * Parse a JSON block from Claude's response text.
 * Claude is instructed to return JSON; this is a safety net for any
 * surrounding prose it might add.
 * @param {string} text
 * @returns {object}
 */
function extractJson(text) {
    // Try a fenced code block first, then bare JSON
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fenced ? fenced[1].trim() : text.trim();
    return JSON.parse(raw);
}

// ── analyzeFilterResults ─────────────────────────────────────────────────────

const ANALYZE_SYSTEM = `\
You are a senior quantitative equity analyst. You receive stock screening results
and the filter criteria that produced them. Your job is to:
  1. Write a concise executive summary (2–4 sentences).
  2. Identify up to 5 notable patterns (sector concentration, valuation clusters,
     momentum signals, volume anomalies, etc.).
  3. Provide 3–5 actionable insights a portfolio manager could act on.

Respond ONLY with valid JSON matching this exact schema — no prose outside the JSON:
{
  "summary": "string",
  "patterns": ["string", ...],
  "insights": ["string", ...]
}`;

/**
 * Analyse a set of screener results against the criteria that produced them.
 *
 * @param {object[]} results   - Array of stock objects from the screener
 * @param {object}   criteria  - The filter criteria used (thresholds, etc.)
 * @returns {Promise<{ summary: string, patterns: string[], insights: string[] }>}
 */
async function analyzeFilterResults(results, criteria) {
    if (!Array.isArray(results) || results.length === 0) {
        return { summary: 'No results to analyse.', patterns: [], insights: [] };
    }

    // Trim the payload to avoid token bloat — top 30 stocks, key fields only
    const slim = results.slice(0, 30).map(s => ({
        ticker:      s.ticker,
        sector:      s.sector,
        price:       s.price,
        change:      s.change,
        volRatio:    s.volRatio,
        pct52H:      s.pct52H,
        score:       s.score,
        mktCap:      s.mktCap,
        revGrowth:   s.revGrowth,
        pe:          s.pe,
        beta:        s.beta,
    }));

    const userMessage = `
Filter criteria applied:
${JSON.stringify(criteria ?? {}, null, 2)}

Screener results (${results.length} total, showing top ${slim.length}):
${JSON.stringify(slim, null, 2)}

Analyse these results and return the JSON response described in your instructions.
`.trim();

    const text = await callClaude(ANALYZE_SYSTEM, userMessage);
    try {
        return extractJson(text);
    } catch {
        // Fallback: return raw text wrapped in the expected shape
        return { summary: text, patterns: [], insights: [] };
    }
}

// ── predictTrends ────────────────────────────────────────────────────────────

const TRENDS_SYSTEM = `\
You are a quantitative research analyst specialising in systematic equity strategies.
You receive a time-ordered series of stock screening runs (metadata + top results).
Your job is to:
  1. Identify up to 5 trends across the runs (sector rotation, momentum persistence,
     volume patterns, score distribution shifts, etc.).
  2. Make 3–5 forward-looking predictions with a confidence level (low/medium/high)
     and a brief rationale for each.

Respond ONLY with valid JSON matching this exact schema — no prose outside the JSON:
{
  "trends": ["string", ...],
  "predictions": [
    { "prediction": "string", "confidence": "low|medium|high", "rationale": "string" },
    ...
  ]
}`;

/**
 * Identify trends and make predictions from historical filter-run data.
 *
 * @param {object[]} historicalData - Rows from getRecentFilterRuns()
 * @returns {Promise<{ trends: string[], predictions: Array<{prediction,confidence,rationale}> }>}
 */
async function predictTrends(historicalData) {
    if (!Array.isArray(historicalData) || historicalData.length === 0) {
        return { trends: [], predictions: [] };
    }

    // Slim each run: keep metadata + top-10 results (key fields only)
    const slim = historicalData.map(run => ({
        id:           run.id,
        label:        run.label,
        createdAt:    run.created_at,
        resultCount:  run.result_count,
        criteria:     run.criteria,
        topResults:   Array.isArray(run.results)
            ? run.results.slice(0, 10).map(s => ({
                ticker:   s.ticker,
                sector:   s.sector,
                score:    s.score,
                volRatio: s.volRatio,
                pct52H:   s.pct52H,
                change:   s.change,
              }))
            : [],
    }));

    const userMessage = `
Historical filter runs (${slim.length} runs, oldest first):
${JSON.stringify(slim, null, 2)}

Identify trends and make predictions. Return the JSON response described in your instructions.
`.trim();

    const text = await callClaude(TRENDS_SYSTEM, userMessage);
    try {
        return extractJson(text);
    } catch {
        return { trends: [text], predictions: [] };
    }
}

// ── answerQuestion ───────────────────────────────────────────────────────────

const QUESTION_SYSTEM = `\
You are a financial data analyst with deep expertise in equity markets and
fundamental analysis. You have been given a snapshot of data from a stock
screening platform. Answer the user's question accurately and concisely.

Rules:
  - Base your answer strictly on the provided data context.
  - If the data is insufficient to answer fully, say so explicitly.
  - Include your step-by-step reasoning.
  - Cite specific tickers, sectors, or metrics from the data where relevant.

Respond ONLY with valid JSON matching this exact schema — no prose outside the JSON:
{
  "answer": "string",
  "reasoning": "string",
  "sources": ["string", ...]
}`;

/**
 * Answer a natural-language question using the supplied data context.
 *
 * @param {string} question - The user's question
 * @param {object} context  - Relevant data (filter results, fundamentals, history)
 * @returns {Promise<{ answer: string, reasoning: string, sources: string[] }>}
 */
async function answerQuestion(question, context) {
    if (!question || typeof question !== 'string' || question.trim() === '') {
        return { answer: 'No question provided.', reasoning: '', sources: [] };
    }

    // Limit context size to avoid token overflow
    const safeContext = JSON.stringify(context ?? {}).slice(0, 12000);

    const userMessage = `
Data context:
${safeContext}

Question: ${question.trim()}

Answer the question and return the JSON response described in your instructions.
`.trim();

    const text = await callClaude(QUESTION_SYSTEM, userMessage);
    try {
        return extractJson(text);
    } catch {
        return { answer: text, reasoning: '', sources: [] };
    }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    analyzeFilterResults,
    predictTrends,
    answerQuestion,
    /** Expose for health-check / startup logging */
    isConfigured: () => Boolean(process.env.ANTHROPIC_API_KEY),
};
