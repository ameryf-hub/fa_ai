const fs = require('fs');
const path = require('path');
const RESULTS_FILE = path.join(__dirname, 'data', 'deepDive.json');

function saveDeepDiveResults(results) {
  const payload = {
    lastRun: new Date().toISOString(),
    stocks: results
  };
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(payload, null, 2));
  console.log('[Storage] Deep dive results saved.');
}

function loadDeepDiveResults() {
  if (!fs.existsSync(RESULTS_FILE)) return null;
  return JSON.parse(fs.readFileSync(RESULTS_FILE));
}

module.exports = { saveDeepDiveResults, loadDeepDiveResults };
