/**
 * Fetch USD exchange rates with fallback sources and retry.
 * Ported from game-regional-pricing-core/src/lib/fetch-rates.mjs with one
 * change: throws instead of process.exit(1) so callers own fail-soft policy.
 */
import { HEADERS } from './http.mjs';

export async function fetchRates() {
  const apis = [
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (data) => (data.result === 'success' ? data.rates : null),
    },
    {
      url: 'https://api.exchangerate-api.com/v4/latest/USD',
      parse: (data) => data.rates || null,
    },
  ];

  for (const { url, parse } of apis) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        console.log(`Trying ${new URL(url).hostname} (attempt ${attempt})...`);
        const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          console.warn(`  HTTP ${res.status}, ${attempt < 2 ? 'retrying...' : 'trying next source'}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        const data = await res.json();
        const rates = parse(data);
        if (rates) {
          console.log(`✓ Rates fetched from ${new URL(url).hostname}`);
          return rates;
        }
        console.warn('  Invalid response format, trying next source');
        break;
      } catch (err) {
        console.warn(`  ${err.message}, ${attempt < 2 ? 'retrying...' : 'trying next source'}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('All exchange rate sources failed');
}
