/**
 * Xbox POC mapping discovery. Exact base-game matches only; --apply writes
 * review candidates and NEVER modifies catalog.json.
 *
 * Usage:
 *   node scripts/discover-xbox.mjs [slug ...]
 *   node scripts/discover-xbox.mjs --apply [slug ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';
import { xboxSuggestUrl, xboxProductsUrl, parseXboxSuggestion, parseXboxProduct } from './lib/xbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const SUGGEST_PATH = path.join(ROOT, 'data', 'suggestions', 'xbox-candidates.json');
const REQUEST_DELAY_MS = 900;

// B' is deliberately capped at 20 representative, already-catalogued games.
const POC_SLUGS = [
  'elden-ring', 'baldurs-gate-3', 'cyberpunk-2077', 'sekiro-shadows-die-twice',
  'stardew-valley', 'palworld', 'mount-and-blade-ii-bannerlord', 'red-dead-redemption-2',
  'dead-by-daylight', 'terraria', 'persona-3-reload', 'sea-of-stars', 'dredge',
  'metaphor-refantazio', 'monster-hunter-wilds', 'monster-hunter-world',
  'clair-obscur-expedition-33', 'balatro', 'hi-fi-rush', 'ori-and-the-will-of-the-wisps',
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const requested = args.filter((a) => a !== '--apply');
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const wanted = requested.length ? requested : POC_SLUGS;
const targets = catalog.games.filter((g) => wanted.includes(g.slug) && g.platforms?.includes('xbox') && !g.xboxBigId);

if (targets.length === 0) {
  console.log('No unmapped Xbox POC games matched.');
  process.exit(0);
}
if (targets.length > 20) throw new Error('Xbox POC may not exceed 20 games');

const discovered = [];
for (const game of targets) {
  let candidate = null;
  try {
    const body = await fetchJson(xboxSuggestUrl(game.title), { label: `xbox suggest ${game.slug}` });
    candidate = parseXboxSuggestion(body, game.title);
  } catch { /* printed by fetch helper; fail-soft per game */ }
  discovered.push({ game, candidate });
  console.log(`${game.slug.padEnd(36)} ${candidate ? `${candidate.bigId} · ${candidate.matchedTitle}` : '— no unique exact match'}`);
  await sleep(REQUEST_DELAY_MS);
}

// Duplicate bigIds mean at least one title mapping is unsafe: reject every use.
const counts = new Map();
for (const { candidate } of discovered) {
  if (candidate) counts.set(candidate.bigId, (counts.get(candidate.bigId) ?? 0) + 1);
}
for (const result of discovered) {
  if (result.candidate && counts.get(result.candidate.bigId) > 1) {
    console.warn(`  duplicate Xbox bigId ${result.candidate.bigId} on ${result.game.slug} — dropped`);
    result.candidate = null;
  }
}

const ids = discovered.flatMap((r) => r.candidate ? [r.candidate.bigId] : []);
let details = { Products: [] };
if (ids.length) {
  try {
    details = await fetchJson(xboxProductsUrl(ids), { label: 'xbox POC product verification' });
  } catch { /* all candidates fail closed below */ }
}

const candidates = [];
for (const { game, candidate } of discovered) {
  if (!candidate) continue;
  const verified = parseXboxProduct(details, {
    bigId: candidate.bigId,
    expectedTitle: game.title,
    edition: candidate.edition,
  });
  if (!verified) {
    console.warn(`  ${game.slug}: product/edition/paid-offer fingerprint failed — dropped`);
    continue;
  }
  candidates.push({
    slug: game.slug,
    xboxBigId: candidate.bigId,
    xboxEdition: 'standard',
    evidence: {
      queryTitle: game.title,
      productTitle: verified.matchedTitle,
      skuTitle: verified.skuTitle,
      skuId: verified.skuId,
      usPrice: verified.row.amount,
      currency: verified.row.currency,
      checkedAt: new Date().toISOString(),
    },
  });
}

console.log(`\nVerified candidates: ${candidates.length}/${targets.length}`);
if (!apply) {
  console.log('Dry run. Re-run with --apply to write data/suggestions/xbox-candidates.json.');
  process.exit(0);
}

fs.mkdirSync(path.dirname(SUGGEST_PATH), { recursive: true });
fs.writeFileSync(SUGGEST_PATH, JSON.stringify({
  updatedAt: new Date().toISOString(),
  note: 'Human review required. Verify standard edition, then merge xboxBigId + xboxEdition into catalog.json manually.',
  candidates,
}, null, 2) + '\n');
console.log(`${candidates.length} candidate(s) written to data/suggestions/xbox-candidates.json; catalog unchanged.`);
