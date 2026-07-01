---
layout: default
title: Setup Guide
---

# Setup Guide

## Prerequisites
- Node.js 20+
- npm or yarn
- Financial Modeling Prep API key

## Local Development

### 1. Clone the repository
```bash
git clone https://github.com/ameryf-hub/fa_ai.git
cd fa_ai
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
Create a `.env` file in the root directory:
```
FMP_API_KEY=your_fmp_api_key_here
PORT=3000
NODE_ENV=development
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5000
```

### 4. Start the development server
```bash
npm start
```

### 5. Open in browser
Navigate to `http://localhost:3000`

---

## Production Deployment on Railway

### Prerequisites
- Railway account (connected to your GitHub)
- Financial Modeling Prep API key

### Deployment Steps

1. **Connect your GitHub repo to Railway**
   - Go to [Railway.app](https://railway.app)
   - Create new project from GitHub
   - Select `ameryf-hub/fa_ai` repository

2. **Set Environment Variables in Railway**
   - Go to your project → Variables
   - Add `FMP_API_KEY` with your API key
   - Add `NODE_ENV=production`
   - Railway automatically detects Node.js and deploys

3. **Deploy on every push**
   - Railway watches your `main` branch
   - Automatic deployment on every push
   - View logs in Railway dashboard

4. **Get your live URL**
   - Railway generates a unique URL: `https://<your-app>.railway.app`
   - Frontend will be available at this URL

---

## Getting an FMP API Key

1. Visit [Financial Modeling Prep](https://financialmodelingprep.com/)
2. Sign up for a free account
3. Go to your dashboard → API section
4. Copy your API key
5. Add to your `.env` file (locally) or Railway variables (production)

---

## Housing Search Feature

### Overview
The **Housing Search** page is accessible via the top-left menu (🏠 Housing Search). It provides a
mobile-friendly AI chat interface powered by Google Gemini that helps users search for homes,
understand markets, estimate costs, and navigate the buying/renting process.

### Required Environment Variable
| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API key. Get one at [aistudio.google.com](https://aistudio.google.com/app/apikey) |

**Optional:**

| Variable | Default | Description |
|---|---|---|
| `GEMINI_MODEL` | `gemini-1.5-flash` | Gemini model name to use |

#### Adding to Railway
Go to your project → Variables → Add Variable:
- Name: `GEMINI_API_KEY`
- Value: your key from Google AI Studio

#### Adding to GitHub Secrets (for CI workflows)
Go to your repository → Settings → Secrets and variables → Actions → New repository secret:
- Name: `GEMINI_API_KEY`

---

## Red Bricks MCP Integration

The app includes a ready-to-use adapter (`redbricks-mcp.js`) for connecting to a
[Red Bricks MCP server](https://modelcontextprotocol.io/). When configured, the
Housing Agent will automatically fetch live property listing data and inject it into
the Gemini conversation context.

### Configuration

Set these environment variables (in Railway → Variables or your `.env`):

| Variable | Required | Description |
|---|---|---|
| `REDBRICKS_MCP_URL` | Yes (to enable) | Base URL of the Red Bricks MCP HTTP endpoint, e.g. `https://mcp.redbricks.example.com` |
| `REDBRICKS_MCP_TOKEN` | No | ****** for authentication |
| `REDBRICKS_MCP_TRANSPORT` | No (default: `http`) | Transport mode: `http` |

### Assumed MCP Tool Contract

The adapter calls these MCP tools. The Red Bricks server must expose them with these names and parameter shapes:

| Tool | Input | Output |
|---|---|---|
| `search_listings` | `{ query: string, maxResults?: number }` | `{ listings: [...] }` |
| `neighborhood_stats` | `{ location: string }` | `{ ... }` |

If the Red Bricks server uses different tool names or schemas, update the
`callMcpTool(...)` wrappers in `redbricks-mcp.js`.

### Status Endpoint

Visit `/api/housing-chat/status` to verify configuration:
```json
{
  "geminiConfigured": true,
  "mcpConfigured": false,
  "mcpTransport": "http"
}
```

---

## Troubleshooting

### Issue: "FMP_API_KEY environment variable is not set"
**Solution:** 
- Locally: Check `.env` file has the API key
- Railway: Add `FMP_API_KEY` to project variables

### Issue: Frontend won't load
**Solution:**
- Check server is running: `http://localhost:3000`
- Verify Express is serving `/public/index.html`
- Check browser console for errors

### Issue: "Too many requests" error
**Solution:**
- Rate limiting is set to 30 requests/minute
- Wait 60 seconds and try again
- Or upgrade FMP API plan

### Issue: No stocks returned from screener
**Solution:**
- Verify FMP API key is valid
- Check that FMP API is not down
- Verify your API plan includes company-screener endpoint

---

## Next Steps
- Read the [Methodology](methodology.md) to understand the screening criteria
- Check [API Reference](api.md) for available endpoints
- Deploy to Railway for live screening
