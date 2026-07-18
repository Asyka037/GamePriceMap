/**
 * Apply a sealed day-one Steam cohort to the catalog (approval model v2,
 * user policy 2026-07-17: machine gates admit, the user audits after launch).
 *
 * Reads a --mode=day-one candidate document produced by
 * build-steam-candidates.mjs, re-checks its hard invariants, and appends
 * catalog entries (tier extended). Idempotent: already-imported appids are
 * skipped, so a rerun is a no-op. Price/meta/history prefetch, gates and the
 * commit stay with the operator — this script only performs the catalog merge.
 *
 * Usage: node scripts/apply-day-one-batch.mjs data/suggestions/steam-day-one.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAY_ONE_LIMIT, DAY_ONE_MIN_RECOMMENDATIONS } from './lib/steam-candidates.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');

const docPath = process.argv[2];
if (!docPath) {
  console.error('usage: node scripts/apply-day-one-batch.mjs <steam-day-one.json>');
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
if (doc.kind !== 'steam-candidates' || doc.mode !== 'day-one' || doc.provisional !== false) {
  throw new Error('input is not a sealed day-one Steam candidate document');
}
if (!Array.isArray(doc.candidates) || doc.candidates.length === 0 || doc.candidates.length > DAY_ONE_LIMIT) {
  throw new Error(`day-one cohort must contain 1..${DAY_ONE_LIMIT} candidates`);
}
for (const candidate of doc.candidates) {
  if (!(candidate.recommendationCount >= DAY_ONE_MIN_RECOMMENDATIONS)) {
    throw new Error(`${candidate.candidateId} is below the day-one recommendation floor`);
  }
}

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const knownAppIds = new Set(catalog.games.map((g) => g.steamAppId).filter(Number.isInteger));
const knownSlugs = new Set(catalog.games.map((g) => g.slug));
const today = new Date().toISOString().slice(0, 10);

const cleanTitle = (title) => title.replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
const added = [];
let skipped = 0;
for (const candidate of doc.candidates) {
  if (knownAppIds.has(candidate.steamAppId)) {
    skipped++;
    continue;
  }
  let slug = candidate.slugHint;
  if (knownSlugs.has(slug)) slug = `${candidate.slugHint}-${candidate.steamAppId}`;
  if (knownSlugs.has(slug)) throw new Error(`slug collision unresolved for ${candidate.candidateId}`);
  catalog.games.push({
    slug,
    title: cleanTitle(candidate.title),
    steamAppId: candidate.steamAppId,
    nsuids: null,
    platforms: ['pc'],
    tier: 'extended',
    addedAt: today,
  });
  knownAppIds.add(candidate.steamAppId);
  knownSlugs.add(slug);
  added.push(slug);
}

fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`catalog: +${added.length} games (skipped ${skipped} already present), total ${catalog.games.length}`);
console.log(added.join(' '));
