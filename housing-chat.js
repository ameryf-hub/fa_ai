// ════════════════════════════════════════════════════════════════════════════
// ── Housing Chat — Gemini-powered real-estate search assistant
// ────────────────────────────────────────────────────────────────────────────
// Provides:
//   1. chat(messages, mcpContext)  — multi-turn housing Q&A using Gemini
//
// Requires: GEMINI_API_KEY environment variable.
// Optionally integrates with the Red Bricks MCP server (redbricks-mcp.js)
// when REDBRICKS_MCP_URL is configured.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const redbricksMcp = require('./redbricks-mcp');

// ── Client initialisation ────────────────────────────────────────────────────

let _genAI = null;

/**
 * Lazily create (and cache) the Gemini client.
 * Throws a typed error when the key is absent so callers can return 503.
 */
function getClient() {
    if (_genAI) return _genAI;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        const err = new Error(
            'GEMINI_API_KEY environment variable is not set. ' +
            'Add it in Railway → Variables before using the Housing Search chat.'
        );
        err.code = 'MISSING_API_KEY';
        throw err;
    }

    _genAI = new GoogleGenerativeAI(apiKey);
    return _genAI;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const MAX_OUTPUT_TOKENS = 1024;

const HOUSING_SYSTEM_PROMPT = `\
You are a knowledgeable and friendly housing search assistant named "FAAI Housing Agent".
Your specialty is helping users find homes, understand real-estate markets, and navigate
the home-buying or rental process.

You can help with:
- Finding properties based on location, budget, and preferences
- Explaining real-estate terms and processes
- Comparing neighborhoods, schools, and amenities
- Estimating costs (mortgage, taxes, fees)
- Guidance on home-buying steps and what to expect
- Rental vs. buying analysis

When property data from the Red Bricks MCP service is available, incorporate it directly
into your answers. Cite the data source as "Red Bricks MLS data".

Be concise, accurate, and practical. Always ask clarifying questions if the user's request
is ambiguous. Never fabricate specific listing prices or addresses — if real data is not
available, clearly state that and offer general guidance instead.`;

// ── chat ─────────────────────────────────────────────────────────────────────

/**
 * Send a multi-turn conversation to Gemini and return the assistant's reply.
 *
 * @param {Array<{role:'user'|'assistant', content:string}>} messages
 *   Prior conversation history plus the latest user message.
 * @param {object|null} mcpContext
 *   Optional data from the Red Bricks MCP server to include as context.
 * @returns {Promise<{reply: string, mcpUsed: boolean}>}
 */
async function chat(messages, mcpContext) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { reply: 'No messages provided.', mcpUsed: false };
    }

    const genAI = getClient(); // throws if key missing
    const model = genAI.getGenerativeModel({
        model: MODEL_NAME,
        systemInstruction: HOUSING_SYSTEM_PROMPT,
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    });

    // Build the Gemini history (all turns except the last user message)
    const lastMsg = messages[messages.length - 1];
    const history = messages.slice(0, -1).map(m => ({
        role:  m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
    }));

    // Optionally enrich the last user message with MCP context
    let userText = lastMsg.content;
    let mcpUsed = false;

    if (!mcpContext && redbricksMcp.isConfigured()) {
        try {
            const query = lastMsg.content.slice(0, 500);
            mcpContext = await redbricksMcp.queryListings(query);
            mcpUsed = true;
        } catch (e) {
            console.warn('⚠ Red Bricks MCP query failed:', e.message);
        }
    } else if (mcpContext) {
        mcpUsed = true;
    }

    if (mcpContext && typeof mcpContext === 'object') {
        const snippet = JSON.stringify(mcpContext).slice(0, 3000);
        userText = `[Red Bricks MLS context]\n${snippet}\n\n[User question]\n${userText}`;
    }

    const chatSession = model.startChat({ history });
    const result = await chatSession.sendMessage(userText);
    const reply = result.response.text();

    return { reply, mcpUsed };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    chat,
    /** Expose for health-check / startup logging */
    isConfigured: () => Boolean(process.env.GEMINI_API_KEY),
};
