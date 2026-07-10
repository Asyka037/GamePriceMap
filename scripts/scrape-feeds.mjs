/**
 * Daily feeds: Steam specials, eShop-EU discounts, CheapShark multi-store
 * deals, Epic + Steam free games.
 *
 * Fail-soft per source: a failed source keeps its previous feed file and
 * logs a warning; the run only fails when EVERY source failed.
 *
 * Writes: data/feeds/{deals-steam,deals-eshop,deals-stores,free-games}.json
 *         data/stores.json (CheapShark store map, refreshed monthly)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';
import { parseSteamSpecials, parseEpicFree, parseEuDiscounts, parseCheapSharkDeals, parseStores } from './lib/feeds.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS_DIR = path.join(ROOT, 'data', 'feeds');
const STORES_FILE = path.join(ROOT, 'data', 'stores.json');
fs.mkdirSync(FEEDS_DIR, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const appIdToSlug = new Map(catalog.games.filter((g) => g.steamAppId).map((g) => [g.steamAppId, g.slug]));
const euNsuidToSlug = new Map(catalog.games.filter((g) => g.nsuids?.europe).map((g) => [g.nsuids.europe, g.slug]));

function writeFeed(name, items) {
  fs.writeFileSync(path.join(FEEDS_DIR, name), JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2) + '\n');
  console.log(`  ${name}: ${items.length} items`);
}

let okCount = 0;
async function source(label, fn) {
  try {
    await fn();
    okCount++;
  } catch (err) {
    console.warn(`  ${label} FAILED (${err.message}) — keeping previous feed`);
  }
  await sleep(1200);
}

// CheapShark store map (monthly refresh).
let storesById = new Map();
await source('stores', async () => {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8')); } catch { /* absent */ }
  if (!doc || Date.now() - Date.parse(doc.updatedAt) > 30 * 24 * 3600e3) {
    const body = await fetchJson('https://www.cheapshark.com/api/1.0/stores', { label: 'cheapshark stores' });
    doc = { updatedAt: new Date().toISOString(), stores: Object.fromEntries(parseStores(body)) };
    fs.writeFileSync(STORES_FILE, JSON.stringify(doc, null, 2) + '\n');
  }
  storesById = new Map(Object.entries(doc.stores));
});

const freeItems = [];
const freeSourceOk = { steam: false, epic: false };

await source('steam specials', async () => {
  const body = await fetchJson('https://store.steampowered.com/api/featuredcategories?cc=us&l=english', { label: 'featuredcategories' });
  const { deals, free } = parseSteamSpecials(body, appIdToSlug);
  if (deals.length === 0) throw new Error('empty specials — refusing to overwrite');
  writeFeed('deals-steam.json', deals);
  freeItems.push(...free);
  freeSourceOk.steam = true;
});

await source('eshop-eu discounts', async () => {
  const base = 'https://searching.nintendo-europe.com/en/select?q=*&fq=type%3AGAME%20AND%20price_has_discount_b%3Atrue&wt=json&rows=150';
  const byValue = await fetchJson(`${base}&sort=price_sorting_f%20desc`, { label: 'eu discounts (value)' });
  await sleep(1200);
  const byPct = await fetchJson(`${base}&sort=price_discount_percentage_f%20desc`, { label: 'eu discounts (pct)' });
  const seen = new Set();
  const items = [];
  for (const it of [...parseEuDiscounts(byValue, euNsuidToSlug), ...parseEuDiscounts(byPct, euNsuidToSlug)]) {
    const key = it.url;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }
  if (items.length === 0) throw new Error('empty eu discounts — refusing to overwrite');
  writeFeed('deals-eshop.json', items);
});

await source('cheapshark deals', async () => {
  const items = [];
  for (const page of [0, 1]) {
    const body = await fetchJson(`https://www.cheapshark.com/api/1.0/deals?sortBy=DealRating&pageSize=60&pageNumber=${page}`, { label: `cheapshark deals p${page}` });
    items.push(...parseCheapSharkDeals(body, storesById, appIdToSlug));
    await sleep(1200);
  }
  const seen = new Set();
  const deduped = items.filter((i) => {
    const key = `${i.storeId}|${i.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length === 0) throw new Error('empty cheapshark deals — refusing to overwrite');
  writeFeed('deals-stores.json', deduped);
});

await source('epic free games', async () => {
  const body = await fetchJson('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US', { label: 'epic promotions' });
  freeItems.push(...parseEpicFree(body));
  freeSourceOk.epic = true;
});

// Free feed merges Epic + Steam 100%-off. A failed source must not erase the
// other source's items: carry over the failed source's entries from the
// previous feed instead of silently dropping them (review finding).
if (freeSourceOk.steam || freeSourceOk.epic) {
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(path.join(FEEDS_DIR, 'free-games.json'), 'utf8')).items ?? []; } catch { /* first run */ }
  const carried = prev.filter((i) => (i.storeId === 'epic' && !freeSourceOk.epic) || (i.storeId !== 'epic' && !freeSourceOk.steam));
  if (carried.length) console.warn(`  free-games: carried ${carried.length} item(s) from previous feed (source failed this run)`);
  writeFeed('free-games.json', [...freeItems, ...carried]);
}

if (okCount === 0) {
  console.error('All feed sources failed.');
  process.exit(1);
}
console.log(`Feeds done (${okCount}/5 sources ok).`);
