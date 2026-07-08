/**
 * Fetch USD exchange rates with fallback sources and retry.
 */
export async function fetchRates() {
  const apis = [
    {
      url: 'https://open.er-api.com/v6/latest/USD',
      parse: (data) => data.result === 'success' ? data.rates : null,
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
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
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
  console.error('All exchange rate sources failed');
  process.exit(1);
}
