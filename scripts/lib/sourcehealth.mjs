/**
 * Per-source freshness ledger (data-v2.1 §1) — the ONLY place freshness
 * lives now that raw snapshots carry no timestamps unless prices change.
 *
 * data/source-health.json:
 *   { updatedAt, sources: { <name>: { lastAttemptAt, lastSuccessAt,
 *     consecutiveFailures, note } } }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'source-health.json');

export function readSourceHealth() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { updatedAt: null, sources: {} };
  }
}

/** A source-wide success means every expected item was verified this run. */
export function completeSourceRun({ expected, changed, unchanged, skipped = 0, failedRequests = 0, failedItems = 0 }) {
  return expected > 0
    && changed + unchanged === expected
    && skipped === 0
    && failedRequests === 0
    && failedItems === 0;
}

/** Scheduled runs fail soft; targeted/staging runs must surface incomplete coverage. */
export function sourceRunExitCode({ targeted, complete }) {
  return targeted && !complete ? 1 : 0;
}

/**
 * Record one scraper run. `ok` means every expected observation was verified
 * (even if all were unchanged); partial/failed runs increment the streak and
 * keep lastSuccessAt untouched while callers retain old observations.
 *
 * `targeted: true` (slug-filtered invocations) records NOTHING: a one-slug
 * prefetch says nothing about source-wide freshness, and advancing
 * lastSuccessAt from it would silently corrupt every trend-chart end date.
 */
export function recordSourceRun(name, { ok, note = '', targeted = false }) {
  if (targeted) {
    console.log(`  (targeted run: ${name} source-health untouched)`);
    return null;
  }
  const doc = readSourceHealth();
  const now = new Date().toISOString();
  const prev = doc.sources[name] ?? { lastSuccessAt: null, consecutiveFailures: 0 };
  doc.sources[name] = {
    lastAttemptAt: now,
    lastSuccessAt: ok ? now : prev.lastSuccessAt,
    consecutiveFailures: ok ? 0 : (prev.consecutiveFailures ?? 0) + 1,
    note,
  };
  doc.updatedAt = now;
  fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
  return doc.sources[name];
}
