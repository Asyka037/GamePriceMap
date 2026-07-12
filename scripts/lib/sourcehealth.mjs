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

/**
 * Record one scraper run. `ok` means the run produced usable data (even if
 * every observation was unchanged); a failed run increments the streak and
 * keeps lastSuccessAt untouched.
 */
export function recordSourceRun(name, { ok, note = '' }) {
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
