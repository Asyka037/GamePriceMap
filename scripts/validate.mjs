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

if (errors.length) {
  console.error(`✗ Validation failed with ${errors.length} error(s):`);
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ Validation passed');
