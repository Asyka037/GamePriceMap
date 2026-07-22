/**
 * Shared HTTP helpers for all scrapers.
 * Every outbound request in this repo MUST go through fetchJson/fetchText —
 * CheapShark rejects generic User-Agents with HTTP 400, and a single
 * descriptive UA keeps us identifiable and throttleable by upstreams.
 *
 * Retry policy (Phase S3):
 *   - 4xx except 408/429 is permanent: no retry, fail fast with err.status.
 *   - 429 / 408 / 5xx / network / timeout retry with exponential backoff and
 *     jitter; a Retry-After header (seconds or HTTP-date, capped at 120s)
 *     overrides the computed backoff.
 *   - A 429 also puts its host on a penalty interval (3s, doubling to 30s)
 *     for the rest of the process, on top of the callers' own sleeps.
 *   - An optional per-run request budget aborts runaway retry storms; the
 *     thrown error has .budget = true so callers can distinguish it.
 */

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

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

let nowFn = () => Date.now();
let waitFn = sleep;
let randomFn = () => Math.random();

/** Test-only dependency injection so retry pacing can be asserted without wall-clock sleeps. */
export function setHttpTestHooks({ now = () => Date.now(), wait = sleep, random = () => Math.random() } = {}) {
  nowFn = now;
  waitFn = wait;
  randomFn = random;
}

export function resetHttpTestHooks() {
  setHttpTestHooks();
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// --- per-run request budget -------------------------------------------------
let requestBudget = Infinity;
let requestCount = 0;

/** Cap total outbound attempts for this process; call once at scraper start. */
export function setRequestBudget(limit) {
  requestBudget = limit;
  requestCount = 0;
}

export function requestsMade() {
  return requestCount;
}

/** Normal calls plus bounded retry headroom; unlike attempts*planned, this can actually trip. */
export function requestBudgetFor(plannedRequests, retryHeadroom = 0.5) {
  if (!(Number.isInteger(plannedRequests) && plannedRequests >= 0)) {
    throw new TypeError('plannedRequests must be a non-negative integer');
  }
  return plannedRequests + Math.max(10, Math.ceil(plannedRequests * retryHeadroom));
}

/** Shared >20% source circuit policy after enough logical samples. */
export function shouldTripCircuit(attempted, failed, { minSamples = 10, threshold = 0.2 } = {}) {
  return attempted >= minSamples && failed > attempted * threshold;
}

// --- per-host 429 penalty pacing ---------------------------------------------
const hostState = new Map(); // host -> { minIntervalMs, notBeforeEpochMs }

function penalizeHost(host) {
  const state = hostState.get(host) ?? { minIntervalMs: 0, notBeforeEpochMs: 0 };
  state.minIntervalMs = Math.min(Math.max(state.minIntervalMs * 2, 3000), 30000);
  state.notBeforeEpochMs = Math.max(state.notBeforeEpochMs, nowFn() + state.minIntervalMs);
  hostState.set(host, state);
  console.warn(`  ${host}: rate limited — host penalty interval now ${state.minIntervalMs}ms`);
}

async function paceHost(host) {
  const state = hostState.get(host);
  if (!state) return;
  const wait = state.notBeforeEpochMs - nowFn();
  if (wait > 0) await waitFn(wait);
}

function markHostRequest(host) {
  const state = hostState.get(host);
  if (state?.minIntervalMs) state.notBeforeEpochMs = nowFn() + state.minIntervalMs;
}

/** Test hook: clear penalty/pacing state between test cases. */
export function resetHostState() {
  hostState.clear();
}

// --- retry core ---------------------------------------------------------------
function parseRetryAfter(res) {
  const header = res.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 120000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.min(Math.max(at - nowFn(), 0), 120000) : null;
}

async function request(url, { label, timeoutMs, attempts, headers }, consume) {
  const host = new URL(url).host;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (requestCount >= requestBudget) {
      const err = new Error(`request budget exhausted (${requestBudget}) at ${label}`);
      err.budget = true;
      throw err;
    }
    await paceHost(host);
    requestCount++;
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      markHostRequest(host);
      if (!res.ok) {
        if (res.status === 429) penalizeHost(host);
        const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
        const err = new Error(`HTTP ${res.status}${retryable ? '' : ' (permanent, not retried)'}`);
        err.status = res.status;
        if (!retryable) err.permanent = true;
        else err.retryAfterMs = parseRetryAfter(res);
        throw err;
      }
      return await consume(res);
    } catch (err) {
      if (err.permanent || err.budget) {
        console.warn(`  ${label}: ${err.message}`);
        throw err;
      }
      const finalAttempt = attempt === attempts;
      console.warn(`  ${label}: ${err.message}${finalAttempt ? '' : ', retrying...'}`);
      if (finalAttempt) throw err;
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 60000);
      const jittered = backoff * (0.7 + randomFn() * 0.6);
      await waitFn(err.retryAfterMs ?? jittered);
    }
  }
}

/** GET a JSON document. Throws after the final failed attempt; callers own fail-soft policy. */
export function fetchJson(url, { label = url, timeoutMs = 30000, attempts = 3, headers = {} } = {}) {
  return request(url, { label, timeoutMs, attempts, headers: { ...HEADERS, ...headers } }, (res) => res.json());
}

/** Same retry policy for official HTML pages used by metadata scrapers. */
export function fetchText(url, { label = url, timeoutMs = 30000, attempts = 3, headers = {} } = {}) {
  return request(
    url,
    { label, timeoutMs, attempts, headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml', ...headers } },
    async (res) => ({ text: await res.text(), finalUrl: res.url }),
  );
}

const CURL_META = '__GPM_CURL_META__';

function safeCurlHeaders(headers) {
  const args = [];
  for (const [name, value] of Object.entries(headers)) {
    if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/u.test(name)
      || /[\r\n]/u.test(String(value))) throw new Error('unsafe HTTP header for curl transport');
    args.push('--header', `${name}: ${value}`);
  }
  return args;
}

async function curlTextResponse(url, {
  timeoutMs,
  headers,
  execFileImpl = execFile,
}) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const marker = `\n${CURL_META}%{http_code}\t%{url_effective}\t%header{retry-after}`;
  const { stdout } = await execFileImpl('curl', [
    '--silent', '--show-error',
    // Microsoft's storefront intermittently resets long HTTP/2 HTML streams;
    // HTTP/1.1 is stable and still uses the same HTTPS endpoint.
    '--http1.1',
    '--connect-timeout', String(Math.min(seconds, 15)),
    '--max-time', String(seconds),
    ...safeCurlHeaders(headers),
    '--write-out', marker,
    url,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const markerAt = stdout.lastIndexOf(`\n${CURL_META}`);
  if (markerAt < 0) throw new Error('curl transport returned no response metadata');
  const [statusText, finalUrl, retryAfter = ''] = stdout.slice(markerAt + CURL_META.length + 1).split('\t');
  const status = Number(statusText);
  if (!Number.isInteger(status) || status < 100 || status > 599 || !finalUrl) {
    throw new Error('curl transport returned invalid response metadata');
  }
  return { status, finalUrl, retryAfter, text: stdout.slice(0, markerAt) };
}

/**
 * HTML transport for official storefronts that stall Node/undici at the TLS
 * edge but answer curl normally. It keeps the same budget, host pacing,
 * 4xx/429 and retry policy as fetchText, and does not follow redirects so the
 * caller can retain exact-final-URL identity guards.
 */
export async function fetchTextViaCurl(url, {
  label = url,
  timeoutMs = 45000,
  attempts = 3,
  headers = {},
  execFileImpl = execFile,
} = {}) {
  const host = new URL(url).host;
  const requestHeaders = { ...HEADERS, Accept: 'text/html,application/xhtml+xml', ...headers };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (requestCount >= requestBudget) {
      const error = new Error(`request budget exhausted (${requestBudget}) at ${label}`);
      error.budget = true;
      throw error;
    }
    await paceHost(host);
    requestCount += 1;
    try {
      const response = await curlTextResponse(url, { timeoutMs, headers: requestHeaders, execFileImpl });
      markHostRequest(host);
      if (response.status < 200 || response.status >= 300) {
        if (response.status === 429) penalizeHost(host);
        const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        const error = new Error(`HTTP ${response.status}${retryable ? '' : ' (permanent, not retried)'}`);
        error.status = response.status;
        if (!retryable) error.permanent = true;
        else if (response.retryAfter) {
          const seconds = Number(response.retryAfter);
          const at = Date.parse(response.retryAfter);
          error.retryAfterMs = Number.isFinite(seconds)
            ? Math.min(Math.max(seconds, 0) * 1000, 120000)
            : (Number.isFinite(at) ? Math.min(Math.max(at - nowFn(), 0), 120000) : null);
        }
        throw error;
      }
      return { text: response.text, finalUrl: response.finalUrl };
    } catch (error) {
      if (error?.code === 'ENOENT') error.permanent = true;
      if (error.permanent || error.budget) {
        console.warn(`  ${label}: ${error.message}`);
        throw error;
      }
      const finalAttempt = attempt === attempts;
      console.warn(`  ${label}: ${error.message}${finalAttempt ? '' : ', retrying...'}`);
      if (finalAttempt) throw error;
      const backoff = Math.min(2000 * 2 ** (attempt - 1), 60000);
      const jittered = backoff * (0.7 + randomFn() * 0.6);
      await waitFn(error.retryAfterMs ?? jittered);
    }
  }
}
