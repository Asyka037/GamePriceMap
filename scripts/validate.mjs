/**
 * Data gate — runs after every scrape, before every commit.
 * Any failure exits 1 so CI keeps the previous good data.
 *
 * Written from scratch per plan §4.4 (the reference project's validator is
 * existence-only and NOT sufficient as a production gate).
 *
 * Checks:
 *   catalog    — schema, unique slugs/appids
 *   snapshots  — raw-only schema, price > 0, 0 < discountPct <= 100,
 *                currency-rate coverage, US-native-USD invariant, and region
 *                coverage >= 80% of the previous committed snapshot
 *   history    — schema, ATL <= all observed event prices for same channel
 *   rates      — fresh (< 48h) and plausible
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DERIVED_REGION_FIELDS } from './lib/snapshot.mjs';
import { DERIVED_STEAM_OFFER_FIELDS } from './lib/steam-offers.mjs';
import { hasNativeUsObservation, isNintendoBaseGameNsuid } from './lib/validation.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const fail = (msg) => errors.push(msg);

function readJson(p) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
}
function gitHeadJson(repoPath) {
  try {
    const out = execFileSync('git', ['show', `HEAD:${repoPath}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch {
    return null; // new file or not a repo — coverage check skipped
  }
}

// --- rates ---
const ratesDoc = readJson('data/rates/usd.json');
const rates = ratesDoc.rates ?? {};
if (!rates.EUR || rates.EUR < 0.5 || rates.EUR > 2) fail(`rates: implausible EUR rate ${rates.EUR}`);
const ratesAgeH = (Date.now() - Date.parse(ratesDoc.updatedAt)) / 3600e3;
if (!(ratesAgeH < 48)) fail(`rates: stale (${ratesAgeH.toFixed(1)}h old)`);

// --- catalog ---
const catalog = readJson('data/catalog.json');
const catalogBySlug = new Map(catalog.games.map((game) => [game.slug, game]));
const steamAppOwners = new Map(catalog.games
  .filter((game) => Number.isInteger(game.steamAppId))
  .map((game) => [game.steamAppId, game.slug]));
const slugs = new Set();
const appIds = new Set();
const xboxIds = new Set();
for (const g of catalog.games) {
  if (!/^[a-z0-9-]+$/.test(g.slug)) fail(`catalog: bad slug "${g.slug}"`);
  if (slugs.has(g.slug)) fail(`catalog: duplicate slug ${g.slug}`);
  if (g.steamAppId !== null && !Number.isInteger(g.steamAppId)) fail(`catalog ${g.slug}: bad steamAppId`);
  if (g.steamAppId && appIds.has(g.steamAppId)) fail(`catalog: duplicate appid ${g.steamAppId}`);
  if (g.xboxBigId != null && !/^[A-Z0-9]{12}$/.test(g.xboxBigId)) fail(`catalog ${g.slug}: malformed xboxBigId ${g.xboxBigId}`);
  if (g.xboxBigId != null && g.xboxEdition !== 'standard') fail(`catalog ${g.slug}: Xbox POC requires xboxEdition "standard"`);
  if (g.xboxBigId && xboxIds.has(g.xboxBigId)) fail(`catalog: duplicate xboxBigId ${g.xboxBigId}`);
  if (!['core', 'extended'].includes(g.tier)) fail(`catalog ${g.slug}: bad tier`);
  if (g.primaryRegionalChannel != null && !['steam', 'eshop'].includes(g.primaryRegionalChannel)) fail(`catalog ${g.slug}: bad primaryRegionalChannel ${g.primaryRegionalChannel}`);
  if (g.primaryRegionalChannel === 'steam' && !Number.isInteger(g.steamAppId)) fail(`catalog ${g.slug}: primaryRegionalChannel steam requires steamAppId`);
  if (g.primaryRegionalChannel === 'eshop' && !(g.nsuids && Object.values(g.nsuids).some(Boolean))) fail(`catalog ${g.slug}: primaryRegionalChannel eshop requires an NSUID`);
  slugs.add(g.slug);
  appIds.add(g.steamAppId);
  if (g.xboxBigId) xboxIds.add(g.xboxBigId);
}

// --- supplemental offer catalog (physically separate from base snapshots) ---
const offerCatalog = fs.existsSync(path.join(ROOT, 'data/offer-catalog.json'))
  ? readJson('data/offer-catalog.json')
  : { offers: [] };
if (!Array.isArray(offerCatalog.offers)) fail('offer-catalog: offers must be an array');
const offerPackageIds = new Set();
const offerByPackageId = new Map();
const offersBySlug = new Map();
for (const offer of offerCatalog.offers ?? []) {
  const game = catalogBySlug.get(offer.slug);
  if (!game) fail(`offer-catalog package ${offer.packageId}: unknown slug ${offer.slug}`);
  if (offer.channel !== 'steam') fail(`offer-catalog package ${offer.packageId}: unsupported channel ${offer.channel}`);
  if (!(Number.isInteger(offer.packageId) && offer.packageId > 0)) fail(`offer-catalog ${offer.slug}: bad packageId ${offer.packageId}`);
  if (offerPackageIds.has(offer.packageId)) fail(`offer-catalog: duplicate packageId ${offer.packageId}`);
  if (!(typeof offer.name === 'string' && offer.name.trim())) fail(`offer-catalog package ${offer.packageId}: missing name`);
  if (!['edition', 'add-on'].includes(offer.kind)) fail(`offer-catalog package ${offer.packageId}: bad kind ${offer.kind}`);
  if (typeof offer.includesBaseGame !== 'boolean') fail(`offer-catalog package ${offer.packageId}: includesBaseGame must be boolean`);
  if (offer.includesBaseGame !== (offer.kind === 'edition')) fail(`offer-catalog package ${offer.packageId}: edition/base-game semantics disagree`);
  if (offer.kind === 'add-on' && (!(typeof offer.expectedStoreName === 'string' && offer.expectedStoreName.trim()) || !(typeof offer.requiredPageText === 'string' && offer.requiredPageText.trim()))) {
    fail(`offer-catalog package ${offer.packageId}: add-on requires fail-closed store-name and content guards`);
  }
  if (!Number.isInteger(offer.baseAppId) || offer.baseAppId !== game?.steamAppId) fail(`offer-catalog package ${offer.packageId}: baseAppId does not match ${offer.slug}`);
  if (!Array.isArray(offer.expectedAppIds) || offer.expectedAppIds.some((id) => !(Number.isInteger(id) && id > 0))) {
    fail(`offer-catalog package ${offer.packageId}: bad expectedAppIds`);
  } else {
    if (new Set(offer.expectedAppIds).size !== offer.expectedAppIds.length) fail(`offer-catalog package ${offer.packageId}: duplicate expectedAppIds`);
    if (offer.includesBaseGame && !offer.expectedAppIds.includes(offer.baseAppId)) fail(`offer-catalog package ${offer.packageId}: expectedAppIds omits base app`);
    if (!offer.includesBaseGame && offer.expectedAppIds.includes(offer.baseAppId)) fail(`offer-catalog package ${offer.packageId}: add-on expectedAppIds contains base app`);
    for (const appId of offer.expectedAppIds) {
      const otherOwner = steamAppOwners.get(appId);
      if (otherOwner && otherOwner !== offer.slug) fail(`offer-catalog package ${offer.packageId}: includes another catalog game (${otherOwner})`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(offer.reviewedAt ?? '') || Number.isNaN(Date.parse(offer.reviewedAt))) fail(`offer-catalog package ${offer.packageId}: bad reviewedAt`);
  if (!(typeof offer.note === 'string' && offer.note.trim())) fail(`offer-catalog package ${offer.packageId}: missing human-review note`);
  offerPackageIds.add(offer.packageId);
  offerByPackageId.set(offer.packageId, offer);
  if (!offersBySlug.has(offer.slug)) offersBySlug.set(offer.slug, []);
  offersBySlug.get(offer.slug).push(offer);
}

const offerDirRel = 'data/offers/steam';
const offerDir = path.join(ROOT, offerDirRel);
for (const slug of offersBySlug.keys()) {
  if (!fs.existsSync(path.join(offerDir, `${slug}.json`))) fail(`missing required supplemental offer snapshot ${offerDirRel}/${slug}.json`);
}
if (fs.existsSync(offerDir)) {
  for (const file of fs.readdirSync(offerDir).filter((name) => name.endsWith('.json'))) {
    const rel = `${offerDirRel}/${file}`;
    const raw = readJson(rel);
    const expectedOffers = offersBySlug.get(raw.slug) ?? [];
    if (!slugs.has(raw.slug)) fail(`${rel}: slug not in catalog`);
    if (file !== `${raw.slug}.json`) fail(`${rel}: filename does not match slug ${raw.slug}`);
    if (!offersBySlug.has(raw.slug)) fail(`${rel}: slug has no approved supplemental offers`);
    if (!Array.isArray(raw.offers)) { fail(`${rel}: offers must be an array`); continue; }
    const actualIds = raw.offers.map((offer) => offer.packageId);
    const expectedIds = expectedOffers.map((offer) => offer.packageId).sort((a, b) => a - b);
    if (actualIds.join() !== [...actualIds].sort((a, b) => a - b).join()) fail(`${rel}: offers not sorted by packageId`);
    if (actualIds.join() !== expectedIds.join()) fail(`${rel}: package IDs differ from reviewed offer catalog`);
    if (raw.lastPriceChangeAt != null && Number.isNaN(Date.parse(raw.lastPriceChangeAt))) fail(`${rel}: bad lastPriceChangeAt`);

    const previous = gitHeadJson(rel);
    for (const item of raw.offers) {
      const approved = offerByPackageId.get(item.packageId);
      if (!approved || approved.slug !== raw.slug) { fail(`${rel}: unapproved package ${item.packageId}`); continue; }
      for (const field of ['name', 'kind', 'includesBaseGame']) {
        if (item[field] !== approved[field]) fail(`${rel} package ${item.packageId}: ${field} differs from reviewed catalog`);
      }
      const leakedCatalogFields = ['columnLabel', 'note', 'reviewedAt', 'channel', 'baseAppId', 'expectedAppIds', 'expectedStoreName', 'requiredPageText']
        .filter((field) => field in item);
      if (leakedCatalogFields.length) fail(`${rel} package ${item.packageId}: catalog display/review fields persisted (${leakedCatalogFields.join('/')})`);
      if (!Array.isArray(item.regions) || item.regions.length === 0) { fail(`${rel} package ${item.packageId}: no priced regions`); continue; }
      const ccs = item.regions.map((region) => region.cc);
      if (new Set(ccs).size !== ccs.length) fail(`${rel} package ${item.packageId}: duplicate regions`);
      if (ccs.join() !== [...ccs].sort().join()) fail(`${rel} package ${item.packageId}: regions not sorted by cc`);
      for (const region of item.regions) {
        if (!/^[A-Z]{2}$/.test(region.cc ?? '')) fail(`${rel} package ${item.packageId}: bad cc ${region.cc}`);
        if (!(region.amount > 0)) fail(`${rel} package ${item.packageId} ${region.cc}: non-positive price`);
        if (region.discountPct !== null && !(region.discountPct > 0 && region.discountPct <= 100)) fail(`${rel} package ${item.packageId} ${region.cc}: bad discountPct ${region.discountPct}`);
        if (region.discountPct !== null && !(region.list > region.amount)) fail(`${rel} package ${item.packageId} ${region.cc}: discount requires a higher list price`);
        if (region.discountPct === null && region.list !== null) fail(`${rel} package ${item.packageId} ${region.cc}: list price without a discount`);
        if (region.saleEndsAt !== null) fail(`${rel} package ${item.packageId} ${region.cc}: Steam package saleEndsAt must be null`);
        const leaked = DERIVED_STEAM_OFFER_FIELDS.filter((field) => field in region);
        if (leaked.length) fail(`${rel} package ${item.packageId} ${region.cc}: comparison/derived fields persisted (${leaked.join('/')})`);
        if (region.currency !== 'USD' && !(rates[region.currency] > 0)) fail(`${rel} package ${item.packageId} ${region.cc}: no exchange rate for ${region.currency}`);
      }
      const us = item.regions.find((region) => region.cc === 'US');
      if (!us || us.currency !== 'USD') fail(`${rel} package ${item.packageId}: missing native US/USD observation`);
      const previousItem = previous?.offers?.find((candidate) => candidate.packageId === item.packageId);
      if (previousItem?.regions?.length && item.regions.length < previousItem.regions.length * 0.8) {
        fail(`${rel} package ${item.packageId}: region coverage dropped ${previousItem.regions.length} -> ${item.regions.length} (>20%)`);
      }
    }
  }
}

// --- required artifacts derived from catalog (a deleted snapshot must FAIL) ---
const seenNsuids = new Map();
for (const g of catalog.games) {
  if (Number.isInteger(g.steamAppId) && !fs.existsSync(path.join(ROOT, `data/snapshots/steam/${g.slug}.json`))) {
    fail(`missing required snapshot data/snapshots/steam/${g.slug}.json (game has steamAppId)`);
  }
  const hasNsuid = g.nsuids && (g.nsuids.americas || g.nsuids.europe || g.nsuids.japan);
  const eshopRel = `data/snapshots/eshop/${g.slug}.json`;
  const eshopExists = fs.existsSync(path.join(ROOT, eshopRel));
  if (hasNsuid && !eshopExists) {
    fail(`missing required snapshot ${eshopRel} (game has nsuids)`);
  }
  if (g.nsuids?.americas && eshopExists && !hasNativeUsObservation(readJson(eshopRel))) {
    fail(`${eshopRel}: catalog has Americas nsuid but snapshot lacks a native US/USD observation`);
  }
  if (g.xboxBigId && !fs.existsSync(path.join(ROOT, `data/snapshots/xbox/${g.slug}.json`))) {
    fail(`missing required snapshot data/snapshots/xbox/${g.slug}.json (game has xboxBigId)`);
  }
  for (const [group, nsuid] of Object.entries(g.nsuids ?? {})) {
    if (nsuid === null) continue;
    if (!isNintendoBaseGameNsuid(nsuid)) fail(`catalog ${g.slug}: ${group} nsuid ${nsuid} is not a 7001 base-game ID`);
    const owner = seenNsuids.get(String(nsuid));
    if (owner && owner !== g.slug) fail(`catalog: nsuid ${nsuid} shared by ${owner} and ${g.slug}`);
    seenNsuids.set(String(nsuid), g.slug);
  }
}

// --- snapshots ---
function validateSnapshotDir(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.json'))) {
    const rel = `${dir}/${file}`;
    const snap = readJson(rel);
    const id = snap.slug;
    if (!slugs.has(id)) fail(`${rel}: slug not in catalog`);
    if (!Array.isArray(snap.regions) || snap.regions.length === 0) { fail(`${rel}: no regions`); continue; }

    for (const r of snap.regions) {
      if (!(r.amount > 0)) fail(`${rel} ${r.cc}: non-positive price`);
      if (r.discountPct !== null && !(r.discountPct > 0 && r.discountPct <= 100)) fail(`${rel} ${r.cc}: discountPct ${r.discountPct} out of range`);
      if (r.discountPct !== null && !(r.list > 0)) fail(`${rel} ${r.cc}: discount without list price`);
      const leaked = DERIVED_REGION_FIELDS.filter((field) => field in r);
      if (leaked.length) fail(`${rel} ${r.cc}: derived field(s) persisted (${leaked.join('/')} belong to build time)`);
      // 缺失汇率 = 构建期该区域会消失，硬失败
      if (r.currency !== 'USD' && !(rates[r.currency] > 0)) fail(`${rel} ${r.cc}: no exchange rate for ${r.currency}`);
    }
    // US 行必须原生 USD（history 事件 FX 免疫的前提）
    const usRow = snap.regions.find((r) => r.cc === 'US');
    if (usRow && usRow.currency !== 'USD') fail(`${rel}: US row currency ${usRow.currency} breaks the native-USD invariant`);
    // 稳定字典序（写盘守卫的语义比较依赖它）
    const ccs = snap.regions.map((r) => r.cc);
    if (ccs.join() !== [...ccs].sort().join()) fail(`${rel}: regions not sorted by cc`);

    const prev = gitHeadJson(rel);
    if (prev?.regions?.length && snap.regions.length < prev.regions.length * 0.8) {
      fail(`${rel}: region coverage dropped ${prev.regions.length} -> ${snap.regions.length} (>20%)`);
    }
  }
}
validateSnapshotDir('data/snapshots/steam');
validateSnapshotDir('data/snapshots/eshop');
validateSnapshotDir('data/snapshots/xbox');

// Cross-channel edition sanity: warn, do not block (platform pricing can truly differ).
for (const g of catalog.games) {
  const prices = ['steam', 'eshop', 'xbox'].flatMap((channel) => {
    const p = path.join(ROOT, `data/snapshots/${channel}/${g.slug}.json`);
    if (!fs.existsSync(p)) return [];
    const us = JSON.parse(fs.readFileSync(p, 'utf8')).regions?.find((r) => r.cc === 'US' && r.currency === 'USD');
    const comparable = us?.list > us?.amount ? us.list : us?.amount;
    return comparable > 0 ? [{ channel, amount: comparable }] : [];
  });
  if (prices.length >= 2) {
    const sorted = prices.toSorted((a, b) => a.amount - b.amount);
    if (sorted.at(-1).amount / sorted[0].amount > 3) {
      console.warn(`! ${g.slug}: cross-channel US price ratio >3x (${sorted.map((p) => `${p.channel} $${p.amount}`).join(', ')}); review edition mapping`);
    }
  }
}

// --- history ---
const histDir = path.join(ROOT, 'data/history');
if (fs.existsSync(histDir)) {
  for (const file of fs.readdirSync(histDir).filter((f) => f.endsWith('.json'))) {
    const rel = `data/history/${file}`;
    const h = readJson(rel);
    if (!slugs.has(h.slug)) fail(`${rel}: slug not in catalog`);
    for (const [key, atl] of Object.entries(h.atl ?? {})) {
      if (!(atl.usd > 0)) fail(`${rel}: atl.${key} non-positive`);
      if (!['self', 'cheapshark', 'eshop-eu'].includes(atl.seed)) fail(`${rel}: atl.${key} unknown seed ${atl.seed}`);
    }
    const chKey = { steam: 'pc', eshop: 'eshop-us', xbox: 'xbox-us' };
    for (const e of h.events ?? []) {
      if (!(e.usd > 0)) fail(`${rel}: event with non-positive usd`);
      const atl = h.atl?.[chKey[e.ch]];
      if (atl && e.usd < atl.usd - 0.005) fail(`${rel}: event ${e.d} usd ${e.usd} below recorded ATL ${atl.usd}`);
    }
  }
}

// --- feeds ---
const FEED_DEALS = ['deals-steam.json', 'deals-eshop.json', 'deals-stores.json'];
for (const name of FEED_DEALS) {
  const p = path.join(ROOT, 'data/feeds', name);
  if (!fs.existsSync(p)) continue;
  const feed = readJson(`data/feeds/${name}`);
  if (!Array.isArray(feed.items) || feed.items.length === 0) { fail(`${name}: empty deals feed`); continue; }
  for (const it of feed.items) {
    if (!(it.price > 0) || !(it.list > 0)) fail(`${name} "${it.title}": non-positive price`);
    if (!(it.pct > 0 && it.pct <= 100)) fail(`${name} "${it.title}": pct ${it.pct} out of range`);
    if (!/^https:\/\//.test(it.url ?? '')) fail(`${name} "${it.title}": bad url`);
  }
}
const freePath = path.join(ROOT, 'data/feeds/free-games.json');
if (fs.existsSync(freePath)) {
  for (const it of readJson('data/feeds/free-games.json').items) {
    if (!['free-now', 'upcoming'].includes(it.status)) fail(`free-games "${it.title}": bad status ${it.status}`);
    if (it.price !== 0) fail(`free-games "${it.title}": price must be 0`);
  }
}
const calPath = path.join(ROOT, 'data/feeds/calendar.json');
if (fs.existsSync(calPath)) {
  const cal = readJson('data/feeds/calendar.json');
  let calendarEntries = 0;
  let calendarImages = 0;
  for (const [month, list] of Object.entries(cal.months ?? {})) {
    if (!/^\d{4}-\d{2}$/.test(month)) fail(`calendar: bad month key ${month}`);
    if (!Array.isArray(list) || list.length === 0) fail(`calendar ${month}: empty month`);
    for (const e of list) {
      calendarEntries++;
      if (e.date && !e.date.startsWith(month)) fail(`calendar ${month} "${e.title}": date ${e.date} outside month`);
      if (typeof e.image === 'string' && /^https:\/\//.test(e.image)) calendarImages++;
    }
  }
  if (calendarEntries > 0 && calendarImages / calendarEntries < 0.8) {
    fail(`calendar: artwork coverage ${calendarImages}/${calendarEntries} below 80%`);
  }
}

// --- meta ---
const metaDir = path.join(ROOT, 'data/meta');
if (fs.existsSync(metaDir)) {
  for (const file of fs.readdirSync(metaDir).filter((f) => f.endsWith('.json'))) {
    const m = readJson(`data/meta/${file}`);
    if (!slugs.has(m.slug)) fail(`meta/${file}: slug not in catalog`);
    if (m.reviewPercent !== null && !(m.reviewPercent >= 0 && m.reviewPercent <= 100)) fail(`meta/${file}: reviewPercent out of range`);
  }
}

// --- source-health（新鲜度账本，v2.1）：在闸门判定之前校验 ---
const sourceHealthPath = path.join(ROOT, 'data/source-health.json');
const sourceHealth = fs.existsSync(sourceHealthPath) ? readJson('data/source-health.json') : { sources: {} };
if (!sourceHealth.updatedAt || Number.isNaN(Date.parse(sourceHealth.updatedAt))) fail('source-health: bad updatedAt');
for (const [name, e] of Object.entries(sourceHealth.sources ?? {})) {
  if (!e || typeof e !== 'object') { fail(`source-health ${name}: entry must be an object`); continue; }
  if (!e.lastAttemptAt || Number.isNaN(Date.parse(e.lastAttemptAt))) fail(`source-health ${name}: bad lastAttemptAt`);
  if (e.lastSuccessAt != null && Number.isNaN(Date.parse(e.lastSuccessAt))) fail(`source-health ${name}: bad lastSuccessAt`);
  if (e.lastSuccessAt && e.lastAttemptAt && Date.parse(e.lastSuccessAt) > Date.parse(e.lastAttemptAt)) fail(`source-health ${name}: success is after attempt`);
  if (!(Number.isInteger(e.consecutiveFailures) && e.consecutiveFailures >= 0)) fail(`source-health ${name}: bad consecutiveFailures`);
  if (typeof e.note !== 'string') fail(`source-health ${name}: note must be a string`);
}
for (const required of ['steam-regional', 'eshop-regional', ...(offerCatalog.offers?.length ? ['steam-offers'] : []), ...(xboxIds.size ? ['xbox-us'] : [])]) {
  if (!sourceHealth.sources?.[required]) fail(`source-health: missing required source ${required}`);
}
if (offerCatalog.offers?.length && !sourceHealth.sources?.['steam-offers']?.lastSuccessAt) {
  fail('source-health: steam-offers has no complete successful run');
}

if (errors.length) {
  console.error(`✗ Validation failed with ${errors.length} error(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

// Passing gate emits the health snapshot consumed by the /status page.
function newestStamp(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return null;
  let max = null;
  for (const f of fs.readdirSync(abs).filter((x) => x.endsWith('.json'))) {
    const t = JSON.parse(fs.readFileSync(path.join(abs, f), 'utf8')).updatedAt ?? null;
    if (t && (!max || t > max)) max = t;
  }
  return max;
}
const health = {
  updatedAt: new Date().toISOString(),
  games: catalog.games.length,
  sources: {
    rates: ratesDoc.updatedAt ?? null,
    'steam-regional': sourceHealth.sources?.['steam-regional']?.lastSuccessAt ?? null,
    ...(offerCatalog.offers?.length && { 'steam-offers': sourceHealth.sources?.['steam-offers']?.lastSuccessAt ?? null }),
    'eshop-regional': sourceHealth.sources?.['eshop-regional']?.lastSuccessAt ?? null,
    ...(xboxIds.size && { 'xbox-us': sourceHealth.sources?.['xbox-us']?.lastSuccessAt ?? null }),
    'deals-steam': fs.existsSync(path.join(ROOT, 'data/feeds/deals-steam.json')) ? readJson('data/feeds/deals-steam.json').updatedAt : null,
    'deals-eshop': fs.existsSync(path.join(ROOT, 'data/feeds/deals-eshop.json')) ? readJson('data/feeds/deals-eshop.json').updatedAt : null,
    'deals-stores': fs.existsSync(path.join(ROOT, 'data/feeds/deals-stores.json')) ? readJson('data/feeds/deals-stores.json').updatedAt : null,
    'free-games': fs.existsSync(freePath) ? readJson('data/feeds/free-games.json').updatedAt : null,
    calendar: fs.existsSync(calPath) ? readJson('data/feeds/calendar.json').updatedAt : null,
    meta: newestStamp('data/meta'),
  },
};
fs.writeFileSync(path.join(ROOT, 'data/health.json'), JSON.stringify(health, null, 2) + '\n');
console.log('✓ Validation passed (health.json refreshed)');
