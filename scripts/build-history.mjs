/**
 * Evolve data/history/{slug}.json from the latest snapshots.
 *
 * - Appends price-change events (US region per channel).
 * - Seeds PC all-time lows from CheapShark cheapestPriceEver (one-time per
 *   game; resolved gameID is cached in the history file).
 *
 * Usage:
 *   node scripts/build-history.mjs [slug ...]
 *   node scripts/build-history.mjs --observations-only [slug ...]
 * The observations-only mode skips all external CheapShark work and is used
 * by the weekly Xbox POC job; daily keeps the full seed refresh behavior.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep, chunk } from './lib/http.mjs';
import { lookupUrl, batchUrl, parseGameLookup, parseCheapestEver, lookupIsDue, seedCheckIsDue, plusDays, RECHECK_DAYS, GAMES_BATCH_SIZE } from './lib/cheapshark.mjs';
import { applySnapshot, seedAtl, emptyHistory } from './lib/history.mjs';
import { usObservation } from './lib/snapshot.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIST_DIR = path.join(ROOT, 'data', 'history');
const STEAM_SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'steam');
const ESHOP_SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'eshop');
const XBOX_SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'xbox');
const EU_SEEDS_FILE = path.join(ROOT, 'data', 'seeds', 'eshop-eu-lows.json');
const RATES_FILE = path.join(ROOT, 'data', 'rates', 'usd.json');
const REQUEST_DELAY_MS = 1000;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const args = process.argv.slice(2);
const observationsOnly = args.includes('--observations-only');
const onlySlugs = args.filter((a) => a !== '--observations-only');
const games = catalog.games.filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));
const today = new Date().toISOString().slice(0, 10);

fs.mkdirSync(HIST_DIR, { recursive: true });

function loadHistory(slug) {
  const p = path.join(HIST_DIR, `${slug}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function saveHistory(h) {
  fs.writeFileSync(path.join(HIST_DIR, `${h.slug}.json`), JSON.stringify(h, null, 2) + '\n');
}

// Pass 1: apply steam + eshop snapshots.
const channels = [
  { dir: STEAM_SNAP_DIR, channel: 'steam', atlKey: 'pc' },
  { dir: ESHOP_SNAP_DIR, channel: 'eshop', atlKey: 'eshop-us' },
  { dir: XBOX_SNAP_DIR, channel: 'xbox', atlKey: 'xbox-us' },
];
const histories = new Map();
let events = 0;
for (const g of games) {
  let h = loadHistory(g.slug) ?? emptyHistory(g.slug);
  for (const { dir, channel, atlKey } of channels) {
    const snapPath = path.join(dir, `${g.slug}.json`);
    if (!fs.existsSync(snapPath)) continue;
    const raw = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const us = usObservation(raw); // US 行原生 USD（validate 强制），FX 免疫
    if (!us) continue;
    const snapshot = { slug: raw.slug, regions: [{ cc: 'US', usd: us.usd, discountPct: us.discountPct ?? null }] };
    const res = applySnapshot(h, snapshot, { channel, atlKey, today });
    if (res.changed) events++;
    h = res.history;
  }
  histories.set(g.slug, h);
}

// Pass 1b: EU GBP historical-low seeds from discovery (price_lowest_f, GBP).
if (fs.existsSync(EU_SEEDS_FILE)) {
  const seeds = JSON.parse(fs.readFileSync(EU_SEEDS_FILE, 'utf8'));
  const gbp = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')).rates?.GBP;
  if (gbp > 0) {
    for (const [slug, s] of Object.entries(seeds)) {
      if (!histories.has(slug) || s.currency !== 'GBP' || !(s.amount > 0)) continue;
      const usd = Math.round((s.amount / gbp) * 100) / 100;
      const res = seedAtl(histories.get(slug), 'eshop-eu', { price: usd, date: null, seed: 'eshop-eu' });
      histories.set(slug, res.history);
    }
  }
}

// CheapShark seed-status ledger: lookup misses and cheapest-ever checks are
// persisted separately from history (which stores observations, not attempts).
const STATUS_FILE = path.join(ROOT, 'data', 'seeds', 'cheapshark-status.json');
const status = fs.existsSync(STATUS_FILE)
  ? JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
  : { updatedAt: null, games: {} };
const statusOf = (slug) => (status.games[slug] ??= {});
const maxLookupsArg = args.find((a) => a.startsWith('--max-lookups='));
const maxLookups = maxLookupsArg ? Number(maxLookupsArg.split('=')[1]) : 150;

// Pass 2: resolve missing CheapShark gameIDs (misses retry after 30 days,
// network failures record nothing and retry next run; capped per run so
// import waves spread their one-time lookups across daily runs).
const needLookup = observationsOnly ? [] : games
  .filter((g) => Number.isInteger(g.steamAppId) && !histories.get(g.slug).cheapsharkGameId)
  .filter((g) => lookupIsDue(status.games[g.slug], today))
  .slice(0, maxLookups);
if (!observationsOnly) {
  for (const g of needLookup) {
    try {
      const body = await fetchJson(lookupUrl(g.steamAppId), { label: `cheapshark lookup ${g.slug}` });
      const id = parseGameLookup(body, g.steamAppId);
      if (id) {
        histories.get(g.slug).cheapsharkGameId = id;
        delete statusOf(g.slug).lookupMissUntil;
      } else {
        statusOf(g.slug).lookupMissUntil = plusDays(today, RECHECK_DAYS);
        console.warn(`  ${g.slug}: not on CheapShark, next lookup after ${statusOf(g.slug).lookupMissUntil}`);
      }
    } catch { /* fail-soft: retry on a future run */ }
    await sleep(REQUEST_DELAY_MS);
  }
}

// Pass 3: batch-fetch cheapestPriceEver. Due when never checked or older than
// the recheck window — NOT "until CheapShark wins the ATL", which re-queried
// self-observed-ATL games forever.
const needSeed = observationsOnly ? [] : games.filter((g) => {
  const h = histories.get(g.slug);
  return h.cheapsharkGameId && seedCheckIsDue(status.games[g.slug], today);
});
if (!observationsOnly) {
  for (const group of chunk(needSeed, GAMES_BATCH_SIZE)) {
    try {
      const ids = group.map((g) => histories.get(g.slug).cheapsharkGameId);
      const body = await fetchJson(batchUrl(ids), { label: 'cheapshark batch' });
      for (const g of group) {
        // The batch answered: the check happened even when this game carries
        // no usable cheapestPriceEver (giveaway-only or absent entry).
        statusOf(g.slug).seedCheckedAt = today;
        const cpe = parseCheapestEver(body, histories.get(g.slug).cheapsharkGameId);
        if (!cpe) continue;
        const res = seedAtl(histories.get(g.slug), 'pc', { price: cpe.price, date: cpe.date, seed: 'cheapshark' });
        histories.set(g.slug, res.history);
      }
    } catch { /* fail-soft */ }
    await sleep(REQUEST_DELAY_MS);
  }
}

for (const h of histories.values()) saveHistory(h);
if (!observationsOnly) {
  status.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(STATUS_FILE), { recursive: true });
  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n');
}
console.log(`Histories written: ${histories.size}, games with new events: ${events}, cheapshark lookups: ${needLookup.length}, seeded: ${needSeed.length}`);
