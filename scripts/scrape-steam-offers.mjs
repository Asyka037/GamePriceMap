/**
 * Weekly supplemental Steam package scraper (curated editions/add-ons only).
 *
 * Usage:
 *   node scripts/scrape-steam-offers.mjs           # complete source run
 *   node scripts/scrape-steam-offers.mjs slug ...  # partial diagnostic run
 *
 * Writes: data/offers/steam/{slug}.json
 * Endpoint constraint: Steam packagedetails accepts one package id per call.
 * Failed requests preserve the last good row; explicit unavailable responses
 * remove that region.  Package observations never enter base-game snapshots.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';
import { STEAM_REGIONS } from './lib/steam.mjs';
import {
  buildSteamOfferSnapshot,
  buildSteamPackageUrl,
  parseSteamPackageDetail,
  preserveFailedSteamOfferRows,
  sameSteamOfferObservations,
  sameSteamOfferPrices,
} from './lib/steam-offers.mjs';
import { completeSourceRun, recordSourceRun } from './lib/sourcehealth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'data', 'offers', 'steam');
const REQUEST_DELAY_MS = 650;

const catalogDoc = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'offer-catalog.json'), 'utf8'));
const allOffers = catalogDoc.offers.filter((offer) => offer.channel === 'steam');
const onlySlugs = process.argv.slice(2);
const offers = allOffers.filter((offer) => onlySlugs.length === 0 || onlySlugs.includes(offer.slug));
const partialRun = offers.length !== allOffers.length;

if (offers.length === 0) {
  console.error('No curated Steam offers matched.');
  process.exit(1);
}

const observations = new Map(offers.map((offer) => [offer.packageId, {}]));
let failedRequests = 0;

for (const offer of offers) {
  process.stdout.write(`${offer.packageId} `);
  for (const cc of STEAM_REGIONS) {
    try {
      const body = await fetchJson(buildSteamPackageUrl(offer.packageId, cc), {
        label: `steam package ${offer.packageId} ${cc}`,
      });
      observations.get(offer.packageId)[cc] = parseSteamPackageDetail(body[String(offer.packageId)], offer);
    } catch (err) {
      failedRequests++;
      console.warn(`  steam package ${offer.packageId} ${cc}: preserving previous row (${err.message})`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}
console.log('');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const offersBySlug = Map.groupBy(offers, (offer) => offer.slug);
let changed = 0;
let unchanged = 0;
let filesWritten = 0;
const today = new Date().toISOString().slice(0, 10);

for (const [slug, slugOffers] of offersBySlug) {
  const file = path.join(OUTPUT_DIR, `${slug}.json`);
  const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;

  const safeObservations = preserveFailedSteamOfferRows(slugOffers, observations, old, STEAM_REGIONS);
  const raw = buildSteamOfferSnapshot(slug, slugOffers, safeObservations);
  for (const item of raw.offers) {
    const previous = old?.offers?.find((candidate) => candidate.packageId === item.packageId);
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) unchanged++;
    else changed++;
  }

  if (old && sameSteamOfferObservations(old, raw)) continue;
  raw.lastPriceChangeAt = old && sameSteamOfferPrices(old, raw)
    ? old.lastPriceChangeAt ?? null
    : today;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  filesWritten++;
}

const complete = completeSourceRun({
  expected: offers.length,
  changed,
  unchanged,
  failedRequests,
});
if (!partialRun) {
  recordSourceRun('steam-offers', {
    ok: complete,
    note: `changed ${changed}, unchanged ${unchanged}, files written ${filesWritten}, failed requests ${failedRequests}, expected ${offers.length}`,
  });
} else {
  console.log('Partial diagnostic run: global steam-offers source health was left unchanged.');
}
console.log(`Offers changed: ${changed}, unchanged: ${unchanged}, files written: ${filesWritten}, failed requests: ${failedRequests}`);
if (!partialRun && !complete) {
  console.warn('Steam offers run was incomplete; lastSuccessAt was not advanced.');
}
