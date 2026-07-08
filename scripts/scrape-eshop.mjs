/**
 * Scrape Nintendo eShop regional prices for every catalog game with NSUIDs.
 *
 * Usage:
 *   node scripts/scrape-eshop.mjs           # all games with nsuids
 *   node scripts/scrape-eshop.mjs slug ...  # only listed slugs
 *
 * Writes: data/snapshots/eshop/{slug}.json
 * One batched price call per region (16 total for the whole catalog).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep, chunk } from './lib/http.mjs';
import { fetchRates } from './lib/rates.mjs';
import { ESHOP_REGIONS, PRICE_BATCH_SIZE, priceUrl, parsePriceEntry, indexPricesById, filterOutlierRegions } from './lib/eshop.mjs';
import { assembleSnapshot } from './lib/snapshot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'eshop');
const RATES_FILE = path.join(ROOT, 'data', 'rates', 'usd.json');
const REQUEST_DELAY_MS = 1200;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const onlySlugs = process.argv.slice(2);
const games = catalog.games
  .filter((g) => g.nsuids && (g.nsuids.americas || g.nsuids.europe || g.nsuids.japan))
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));

if (games.length === 0) {
  console.error('No catalog games with NSUIDs matched.');
  process.exit(1);
}

// Reuse the rates file when fresh (steam scrape writes it earlier in the
// daily pipeline); fetch only when missing or stale.
let rates;
try {
  const doc = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
  if (Date.now() - Date.parse(doc.updatedAt) < 24 * 3600e3) rates = doc.rates;
} catch { /* fall through */ }
if (!rates) {
  rates = await fetchRates();
  fs.mkdirSync(path.dirname(RATES_FILE), { recursive: true });
  fs.writeFileSync(RATES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), rates }, null, 2) + '\n');
}

// rows: slug -> [{cc, ...price fields}]
const rows = new Map(games.map((g) => [g.slug, []]));
let failedRegionRequests = 0;

for (const { cc, group } of ESHOP_REGIONS) {
  const inRegion = games.filter((g) => g.nsuids[group]);
  for (const batch of chunk(inRegion, PRICE_BATCH_SIZE)) {
    const nsuidToSlug = new Map(batch.map((g) => [String(g.nsuids[group]), g.slug]));
    try {
      const body = await fetchJson(priceUrl(cc, [...nsuidToSlug.keys()]), { label: `eshop ${cc}` });
      const byId = indexPricesById(body);
      for (const [nsuid, slug] of nsuidToSlug) {
        const parsed = parsePriceEntry(byId.get(nsuid));
        if (parsed) rows.get(slug).push({ cc, ...parsed });
      }
    } catch {
      failedRegionRequests++;
    }
    await sleep(REQUEST_DELAY_MS);
  }
  process.stdout.write(`${cc} `);
}
console.log('');

fs.mkdirSync(SNAP_DIR, { recursive: true });
let written = 0;
let skipped = 0;
for (const g of games) {
  const snap = filterOutlierRegions(assembleSnapshot(g.slug, rows.get(g.slug), rates));
  if (snap.regions.length === 0) {
    console.warn(`  ${g.slug}: zero priced regions, keeping previous snapshot`);
    skipped++;
    continue;
  }
  fs.writeFileSync(path.join(SNAP_DIR, `${g.slug}.json`), JSON.stringify(snap, null, 2) + '\n');
  written++;
}

console.log(`eShop snapshots written: ${written}, skipped: ${skipped}, failed region requests: ${failedRegionRequests}`);
if (written === 0) {
  console.error('Nothing written — treating as run failure.');
  process.exit(1);
}
