// ════════════════════════════════════════════════════════════════════════════
// ── Red Bricks MCP Adapter
// ────────────────────────────────────────────────────────────────────────────
// Provides a thin integration layer between the FAAI Housing Agent and a
// Red Bricks MCP (Model Context Protocol) server.
//
// Configuration (environment variables):
//   REDBRICKS_MCP_URL       — Base URL of the Red Bricks MCP HTTP endpoint
//                             e.g. https://mcp.redbricks.example.com
//   REDBRICKS_MCP_TOKEN     — ****** for authentication (optional)
//   REDBRICKS_MCP_TRANSPORT — Transport mode: "http" (default) | "sse"
//
// If REDBRICKS_MCP_URL is not set the adapter is considered unconfigured and
// all calls return null gracefully so the chat still works without MCP.
//
// Extension points:
//   - Add more tool wrappers (queryOpenHouses, getNeighborhoodStats, …)
//   - Swap the HTTP transport for stdio by setting REDBRICKS_MCP_TRANSPORT=stdio
//     and providing REDBRICKS_MCP_COMMAND for the child-process command.
// ════════════════════════════════════════════════════════════════════════════

'use strict';

const axios = require('axios');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build Axios request config for the MCP endpoint.
 * @returns {{ baseURL: string, headers: object, timeout: number }}
 */
function buildAxiosConfig() {
    const baseURL = process.env.REDBRICKS_MCP_URL || '';
    const token   = process.env.REDBRICKS_MCP_TOKEN || '';
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return { baseURL, headers, timeout: 10000 };
}

/**
 * Send a single MCP tool-call request and return its result.
 * Follows the JSON-RPC 2.0 framing used by MCP HTTP transports.
 *
 * @param {string} toolName   — MCP tool identifier
 * @param {object} params     — Tool input parameters
 * @returns {Promise<object|null>}
 */
async function callMcpTool(toolName, params) {
    const cfg = buildAxiosConfig();
    if (!cfg.baseURL) {
        console.warn('⚠ REDBRICKS_MCP_URL is not configured — MCP call skipped');
        return null;
    }

    const payload = {
        jsonrpc: '2.0',
        id:      Date.now(),
        method:  'tools/call',
        params:  { name: toolName, arguments: params },
    };

    try {
        const res = await axios.post('/mcp', payload, cfg);
        // MCP HTTP response: { jsonrpc, id, result: { content: [...] } }
        const result = res.data?.result;
        if (!result) {
            console.warn(`⚠ Red Bricks MCP: empty result for tool "${toolName}"`);
            return null;
        }
        return result;
    } catch (err) {
        const status = err.response?.status;
        console.warn(`⚠ Red Bricks MCP tool "${toolName}" failed (HTTP ${status ?? 'N/A'}):`, err.message);
        throw err;
    }
}

// ── Tool wrappers ────────────────────────────────────────────────────────────

/**
 * Query property listings from the Red Bricks MCP server.
 *
 * The MCP tool "search_listings" is assumed to accept:
 *   { query: string, maxResults?: number }
 * and return an object with a "listings" array.
 *
 * @param {string} query       — Natural-language or structured query string
 * @param {number} [maxResults=5]
 * @returns {Promise<object|null>}
 */
async function queryListings(query, maxResults) {
    return callMcpTool('search_listings', {
        query,
        maxResults: maxResults || 5,
    });
}

/**
 * Fetch neighborhood statistics (schools, walkability, crime index, etc.)
 * from the Red Bricks MCP server.
 *
 * The MCP tool "neighborhood_stats" is assumed to accept:
 *   { location: string }
 *
 * @param {string} location   — City, ZIP code, or neighborhood name
 * @returns {Promise<object|null>}
 */
async function getNeighborhoodStats(location) {
    return callMcpTool('neighborhood_stats', { location });
}

/**
 * Retrieve a list of available MCP tools from the Red Bricks server.
 * Useful for health-checks and dynamic capability discovery.
 *
 * @returns {Promise<string[]>}
 */
async function listTools() {
    const cfg = buildAxiosConfig();
    if (!cfg.baseURL) return [];

    try {
        const payload = {
            jsonrpc: '2.0',
            id:      Date.now(),
            method:  'tools/list',
            params:  {},
        };
        const res = await axios.post('/mcp', payload, cfg);
        const tools = res.data?.result?.tools ?? [];
        return tools.map(t => t.name);
    } catch (err) {
        console.warn('⚠ Red Bricks MCP tools/list failed:', err.message);
        return [];
    }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    queryListings,
    getNeighborhoodStats,
    listTools,
    /** True when REDBRICKS_MCP_URL is set */
    isConfigured: () => Boolean(process.env.REDBRICKS_MCP_URL),
};
