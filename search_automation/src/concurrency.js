'use strict';

// Runs worker(item, index) over items with at most `limit` in flight, and
// returns results in the original item order regardless of finish order.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

module.exports = { runWithConcurrency, envInt };
