/**
 * Weekly catalog candidates: popular games not yet tracked.
 * Sources: SteamSpy top100in2weeks (fail-soft — often slow) and Steam
 * featuredcategories top_sellers. Human reviews and merges into catalog;
 * this script NEVER touches catalog.json (plan §4.1 governance).
 *
 * Writes: data/suggestions/catalog-candidates.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'data', 'suggestions');
fs.mkdirSync(OUT_DIR, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const known = new Set(catalog.games.map((g) => g.steamAppId).filter(Boolean));

const NOISE = /\b(steam deck|steam machine|steam frame|upgrade kit|upgrade pack|season pass|soundtrack|dlc|demo|playtest)\b/i;

const candidates = new Map(); // appId -> {name, steamAppId, sources[]}
function add(appId, name, source) {
  if (!appId || known.has(appId) || NOISE.test(name ?? '')) return;
  const c = candidates.get(appId) ?? { name, steamAppId: appId, sources: [] };
  if (!c.sources.includes(source)) c.sources.push(source);
  c.name ??= name;
  candidates.set(appId, c);
}

try {
  const body = await fetchJson('https://steamspy.com/api.php?request=top100in2weeks', { label: 'steamspy', timeoutMs: 45000 });
  for (const [appId, g] of Object.entries(body)) add(Number(appId), g.name, 'steamspy-top100-2w');
  console.log('steamspy: ok');
} catch (err) {
  console.warn(`steamspy FAILED (${err.message}) — continuing`);
}
await sleep(1500);

try {
  const fc = await fetchJson('https://store.steampowered.com/api/featuredcategories?cc=us&l=english', { label: 'featuredcategories' });
  for (const it of fc.top_sellers?.items ?? []) add(it.id, it.name, 'steam-top-sellers');
  console.log('top_sellers: ok');
} catch (err) {
  console.warn(`top_sellers FAILED (${err.message})`);
}

const list = [...candidates.values()].sort((a, b) => b.sources.length - a.sources.length || a.name.localeCompare(b.name));
fs.writeFileSync(
  path.join(OUT_DIR, 'catalog-candidates.json'),
  JSON.stringify({ updatedAt: new Date().toISOString(), note: 'Human review required — merge into catalog.json manually.', candidates: list }, null, 2) + '\n',
);
console.log(`candidates: ${list.length}`);
