/**
 * Scrape Steam regional prices for every catalog game with a steamAppId.
 *
 * Usage:
 *   node scripts/scrape-steam.mjs           # all games
 *   node scripts/scrape-steam.mjs slug ...  # only listed slugs
 *
 * Writes: data/rates/usd.json, data/snapshots/steam/{slug}.json
 * Fail-soft: a region that errors is skipped (old snapshot survives unless
 * this run writes one); a game with zero priced regions keeps its old file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep, chunk } from './lib/http.mjs';
import { fetchRates } from './lib/rates.mjs';
import { STEAM_REGIONS, APPDETAILS_BATCH_SIZE, buildPriceUrl, parsePriceOverview, buildSnapshot } from './lib/steam.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'steam');
const RATES_FILE = path.join(ROOT, 'data', 'rates', 'usd.json');
const REQUEST_DELAY_MS = 1500;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const onlySlugs = process.argv.slice(2);
const games = catalog.games
  .filter((g) => Number.isInteger(g.steamAppId))
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));

if (games.length === 0) {
  console.error('No catalog games matched.');
  process.exit(1);
}

const rates = await fetchRates();
fs.mkdirSync(path.dirname(RATES_FILE), { recursive: true });
fs.writeFileSync(RATES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), rates }, null, 2) + '\n');

const appIdToSlug = new Map(games.map((g) => [g.steamAppId, g.slug]));
const batches = chunk(games.map((g) => g.steamAppId), APPDETAILS_BATCH_SIZE);

// regionPrices: slug -> { cc -> parsed price | null }
const regionPrices = new Map(games.map((g) => [g.slug, {}]));
let failedRegionRequests = 0;

for (const cc of STEAM_REGIONS) {
  for (const ids of batches) {
    try {
      const body = await fetchJson(buildPriceUrl(ids, cc), { label: `steam ${cc} batch` });
      for (const id of ids) {
        const slug = appIdToSlug.get(id);
        regionPrices.get(slug)[cc] = parsePriceOverview(body[String(id)]);
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
  const snap = buildSnapshot(g.slug, regionPrices.get(g.slug), rates);
  if (snap.regions.length === 0) {
    console.warn(`  ${g.slug}: zero priced regions, keeping previous snapshot`);
    skipped++;
    continue;
  }
  fs.writeFileSync(path.join(SNAP_DIR, `${g.slug}.json`), JSON.stringify(snap, null, 2) + '\n');
  written++;
}

console.log(`Snapshots written: ${written}, skipped: ${skipped}, failed region requests: ${failedRegionRequests}`);
if (written === 0) {
  console.error('Nothing written — treating as run failure.');
  process.exit(1);
}
