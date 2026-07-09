/**
 * Data gate — runs after every scrape, before every commit.
 * Any failure exits 1 so CI keeps the previous good data.
 *
 * Written from scratch per plan §4.4 (the reference project's validator is
 * existence-only and NOT sufficient as a production gate).
 *
 * Checks:
 *   catalog    — schema, unique slugs/appids
 *   snapshots  — schema, price > 0, 0 < discountPct <= 100, USD conversion
 *                within 2% of rates file, region coverage >= 80% of the
 *                previous committed snapshot (via `git show HEAD:...`)
 *   history    — schema, ATL <= all observed event prices for same channel
 *   rates      — fresh (< 48h) and plausible
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
const slugs = new Set();
const appIds = new Set();
for (const g of catalog.games) {
  if (!/^[a-z0-9-]+$/.test(g.slug)) fail(`catalog: bad slug "${g.slug}"`);
  if (slugs.has(g.slug)) fail(`catalog: duplicate slug ${g.slug}`);
  if (g.steamAppId !== null && !Number.isInteger(g.steamAppId)) fail(`catalog ${g.slug}: bad steamAppId`);
  if (g.steamAppId && appIds.has(g.steamAppId)) fail(`catalog: duplicate appid ${g.steamAppId}`);
  if (!['core', 'extended'].includes(g.tier)) fail(`catalog ${g.slug}: bad tier`);
  slugs.add(g.slug);
  appIds.add(g.steamAppId);
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
      if (!(r.amount > 0) || !(r.usd > 0)) fail(`${rel} ${r.cc}: non-positive price`);
      if (r.discountPct !== null && !(r.discountPct > 0 && r.discountPct <= 100)) fail(`${rel} ${r.cc}: discountPct ${r.discountPct} out of range`);
      if (r.discountPct !== null && !(r.list > 0)) fail(`${rel} ${r.cc}: discount without list price`);
      // conversion re-check against committed rates
      const rate = r.currency === 'USD' ? 1 : rates[r.currency];
      if (rate) {
        const expect = r.amount / rate;
        if (Math.abs(expect - r.usd) / expect > 0.02) fail(`${rel} ${r.cc}: usd ${r.usd} deviates >2% from ${expect.toFixed(2)}`);
      }
    }
    const ranks = snap.regions.map((r) => r.rank).sort((a, b) => a - b);
    if (ranks[0] !== 1 || ranks[ranks.length - 1] !== ranks.length) fail(`${rel}: broken rank sequence`);

    const prev = gitHeadJson(rel);
    if (prev?.regions?.length && snap.regions.length < prev.regions.length * 0.8) {
      fail(`${rel}: region coverage dropped ${prev.regions.length} -> ${snap.regions.length} (>20%)`);
    }
  }
}
validateSnapshotDir('data/snapshots/steam');
validateSnapshotDir('data/snapshots/eshop');

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
    const chKey = { steam: 'pc', eshop: 'eshop-us' };
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
  for (const [month, list] of Object.entries(cal.months ?? {})) {
    if (!/^\d{4}-\d{2}$/.test(month)) fail(`calendar: bad month key ${month}`);
    if (!Array.isArray(list) || list.length === 0) fail(`calendar ${month}: empty month`);
    for (const e of list) {
      if (e.date && !e.date.startsWith(month)) fail(`calendar ${month} "${e.title}": date ${e.date} outside month`);
    }
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
    'steam-regional': newestStamp('data/snapshots/steam'),
    'eshop-regional': newestStamp('data/snapshots/eshop'),
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
