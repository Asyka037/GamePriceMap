/**
 * Shared HTTP helpers for all scrapers.
 * Every outbound request in this repo MUST go through fetchJson —
 * CheapShark rejects generic User-Agents with HTTP 400, and a single
 * descriptive UA keeps us identifiable and throttleable by upstreams.
 */

export const USER_AGENT =
  'GamePriceMapBot/0.1 (+https://gamepricemap.com/about; contact: yiyi22331999@gmail.com)';

export const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * GET a JSON document with timeout, exponential backoff and 3 attempts.
 * Throws after the final failed attempt; callers decide fail-soft policy.
 */
export async function fetchJson(url, { label = url, timeoutMs = 30000, attempts = 3, headers = {} } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { ...HEADERS, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      const finalAttempt = attempt === attempts;
      console.warn(`  ${label}: ${err.message}${finalAttempt ? '' : ', retrying...'}`);
      if (finalAttempt) throw err;
      await sleep(2000 * attempt);
    }
  }
}
