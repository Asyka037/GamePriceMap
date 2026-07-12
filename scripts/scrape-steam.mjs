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
import { sameObservations } from './lib/snapshot.mjs';
import { recordSourceRun, completeSourceRun } from './lib/sourcehealth.mjs';

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

try {
  const rates = await fetchRates();
  fs.mkdirSync(path.dirname(RATES_FILE), { recursive: true });
  fs.writeFileSync(RATES_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), rates }, null, 2) + '\n');
} catch (err) {
  // Raw Steam observations do not need FX. Continue with price collection;
  // validate independently enforces that the last good rates file is fresh.
  console.warn(`  rates refresh failed: ${err.message}; continuing with Steam raw observations`);
}

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
let unchanged = 0;
let skipped = 0;
const today = new Date().toISOString().slice(0, 10);
for (const g of games) {
  const prices = regionPrices.get(g.slug);
  const snapPath = path.join(SNAP_DIR, `${g.slug}.json`);
  const old = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : null;

  // fetch 失败的区域（键缺失，区别于"该区无售"的显式 null）保留旧观测行
  for (const cc of STEAM_REGIONS) {
    if (cc in prices) continue;
    const oldRow = old?.regions?.find((r) => r.cc === cc.toUpperCase());
    if (oldRow) prices[cc] = { currency: oldRow.currency, amount: oldRow.amount, list: oldRow.list, discountPct: oldRow.discountPct };
  }

  const snap = buildSnapshot(g.slug, prices);
  if (snap.regions.length === 0) {
    console.warn(`  ${g.slug}: zero priced regions, keeping previous snapshot`);
    skipped++;
    continue;
  }
  if (old && sameObservations(old, snap)) {
    unchanged++;
    continue; // 语义未变：不写盘（git diff ∝ 真实变价）
  }
  snap.lastPriceChangeAt = today;
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n');
  written++;
}

const complete = completeSourceRun({ expected: games.length, changed: written, unchanged, skipped, failedRequests: failedRegionRequests });
recordSourceRun('steam-regional', { ok: complete, note: `changed ${written}, unchanged ${unchanged}, skipped ${skipped}, failed region requests ${failedRegionRequests}, expected ${games.length}` });
console.log(`Snapshots changed: ${written}, unchanged: ${unchanged}, skipped: ${skipped}, failed region requests: ${failedRegionRequests}`);
if (!complete) {
  console.warn('Steam run was incomplete; old observations were retained and lastSuccessAt was not advanced.');
}
