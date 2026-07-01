const axios = require('axios');
const pLimit = require('p-limit');

const FMP_KEY = process.env.FMP_KEY;
const PPLX_KEY = process.env.PERPLEXITY_KEY;

// Your permanent skill prompt — edit this anytime
const SYSTEM_PROMPT = `
You are a stock analysis assistant for a personal trading scanner.
For each stock provided, using the FMP data given AND your live web knowledge:
1. Summarize the 2-3 most relevant news items from the last 48 hours
2. Give a Fundamental Health Score (1-10) based on the FMP metrics provided
3. Interpret analyst consensus as: Bullish / Mixed / Bearish
4. Assess options flow: Unusual Calls / Unusual Puts / Normal / No Data
5. Write a 2-sentence "Verdict" combining all signals
Return ONLY a valid JSON object. No extra text.
`;

// Fetch fundamentals, analyst ratings, and news from FMP
async function fetchFMPData(symbol) {
  const base = 'https://financialmodelingprep.com/api/v3';
  const params = { apikey: FMP_KEY };

  const [metrics, ratings, news] = await Promise.all([
    axios.get(`${base}/key-metrics/${symbol}`, { params }),
    axios.get(`${base}/analyst-stock-recommendations/${symbol}`, { params }),
    axios.get(`${base}/stock_news`, { params: { ...params, tickers: symbol, limit: 5 } })
  ]);

  return {
    metrics: metrics.data?.[0] || {},
    ratings: ratings.data?.[0] || {},
    news: news.data?.map(n => n.title) || []
  };
}

// Send FMP data + symbol to Perplexity for analysis
async function analyzeWithPerplexity(symbol, fmpData) {
  const response = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: 'sonar',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Symbol: ${symbol}\nFMP Data: ${JSON.stringify(fmpData)}`
        }
      ]
    },
    { headers: { Authorization: `Bearer ${PPLX_KEY}` } }
  );

  return JSON.parse(response.data.choices[0].message.content);
}

// Process one stock end-to-end
async function processStock(symbol) {
  try {
    const fmpData = await fetchFMPData(symbol);
    const analysis = await analyzeWithPerplexity(symbol, fmpData);
    return { symbol, analysis, updatedAt: new Date().toISOString(), error: null };
  } catch (err) {
    console.error(`Error processing ${symbol}:`, err.message);
    return { symbol, analysis: null, updatedAt: new Date().toISOString(), error: err.message };
  }
}

// Main entry point — called by your scanner at end of each cycle
async function runSkillRunner(symbols) {
  console.log(`[SkillRunner] Starting for ${symbols.length} symbols...`);

  const limit = pLimit(5); // max 5 stocks at once — prevents rate limits
  const tasks = symbols.map(symbol => limit(() => processStock(symbol)));
  const results = await Promise.all(tasks);

  console.log(`[SkillRunner] Completed ${results.length} stocks.`);
  return results; // caller saves this to DB or file
}

module.exports = { runSkillRunner };
