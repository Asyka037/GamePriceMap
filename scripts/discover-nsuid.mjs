/**
 * Semi-automatic NSUID discovery (one-time per game).
 *
 * Sources:
 *   europe   searching.nintendo-europe.com Solr (also yields GBP price_lowest_f seed)
 *   japan    search.nintendo.jp
 *   americas nintendo.com product page embedded JSON (browser UA required)
 *
 * Disambiguation: only 7001-prefixed NSUIDs (7005 = upgrade pack, 7007 =
 * bundle); titles containing "Switch 2 Edition" are skipped so we track the
 * base game. Matches below "high" confidence are printed but never applied.
 *
 * Usage:
 *   node scripts/discover-nsuid.mjs                  # all switch games missing nsuids (dry run)
 *   node scripts/discover-nsuid.mjs slug ...         # only these slugs (dry run)
 *   node scripts/discover-nsuid.mjs --apply [slug..] # write candidates to data/suggestions/ (never touches catalog)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';
import { extractUsProductNsuid } from './lib/eshop.mjs';
import {
  selectEuropeDiscoveryCandidate,
  selectJapanDiscoveryCandidate,
} from './lib/nsuid-discovery.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const SUGGEST_PATH = path.join(ROOT, 'data', 'suggestions', 'nsuid-candidates.json');
const SEEDS_PATH = path.join(ROOT, 'data', 'seeds', 'eshop-eu-lows.json');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlySlugs = args.filter((a) => a !== '--apply');

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const targets = catalog.games.filter((g) =>
  (onlySlugs.length ? onlySlugs.includes(g.slug)
    : (g.platforms.some((p) => p.startsWith('switch')) && !g.nsuids)));

async function discoverEurope({ title, platforms }) {
  const url = `https://searching.nintendo-europe.com/en/select?q=${encodeURIComponent(title)}&fq=type%3AGAME&rows=8&wt=json`;
  const body = await fetchJson(url, { label: 'eu search' });
  const candidate = selectEuropeDiscoveryCandidate(body.response?.docs, { title, platforms });
  return candidate ? { ...candidate, confidence: 'high' } : null;
}

async function discoverJapan({ title, platforms }) {
  const url = `https://search.nintendo.jp/nintendo_soft/search.json?q=${encodeURIComponent(title)}&limit=8`;
  const body = await fetchJson(url, { label: 'jp search' });
  const candidate = selectJapanDiscoveryCandidate(body.result?.items, { title, platforms });
  return candidate ? { ...candidate, confidence: 'high' } : null;
}

async function discoverAmericas(slug, title) {
  for (const candidate of [`${slug}-switch`, slug]) {
    try {
      const res = await fetch(`https://www.nintendo.com/us/store/products/${candidate}/`, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      // Guessed URLs can 200-redirect to a generic or different product page.
      // Require the requested product path itself to survive the redirect.
      const finalPath = new URL(res.url).pathname.replace(/\/+$/, '');
      if (finalPath !== `/us/store/products/${candidate}`) continue;
      const html = await res.text();
      const product = extractUsProductNsuid(html, { title, urlKey: candidate });
      if (product) return { ...product, matchedTitle: candidate, confidence: 'high' };
    } catch { /* try next candidate */ }
  }
  return null;
}

const results = [];
for (const g of targets) {
  const [eu, jp, us] = [
    await discoverEurope(g).catch(() => null),
    await discoverJapan(g).catch(() => null),
    await discoverAmericas(g.slug, g.title).catch(() => null),
  ];
  results.push({ slug: g.slug, eu, jp, us });
  const fmt = (r) => (r ? `${r.nsuid} [${r.confidence}]` : '—');
  console.log(`${g.slug.padEnd(32)} EU ${fmt(eu).padEnd(26)} JP ${fmt(jp).padEnd(26)} US ${fmt(us)}`);
  await sleep(1200);
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write candidates to data/suggestions/ (catalog stays human-reviewed).');
  process.exit(0);
}

// Cross-game duplicate guard: the same NSUID appearing for two games in one
// group means at least one match is wrong — drop both for manual review.
for (const group of ['eu', 'jp', 'us']) {
  const seen = new Map();
  for (const r of results) {
    if (r[group]) seen.set(r[group].nsuid, (seen.get(r[group].nsuid) ?? 0) + 1);
  }
  for (const r of results) {
    if (r[group] && seen.get(r[group].nsuid) > 1) {
      console.warn(`  duplicate ${group.toUpperCase()} nsuid ${r[group].nsuid} on ${r.slug} — dropped for manual review`);
      r[group] = null;
    }
  }
}

// Governance (plan §4.1): this script NEVER writes catalog.json. --apply emits
// a candidates file for human review; seeds are written only for slugs whose
// europe nsuid the human later merges (kept alongside for convenience).
const seeds = fs.existsSync(SEEDS_PATH) ? JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8')) : {};
const candidates = [];
for (const r of results) {
  const nsuids = {
    americas: r.us?.confidence === 'high' ? r.us.nsuid : null,
    europe: r.eu?.confidence === 'high' ? r.eu.nsuid : null,
    japan: r.jp?.confidence === 'high' ? r.jp.nsuid : null,
  };
  if (!nsuids.americas && !nsuids.europe && !nsuids.japan) continue;
  candidates.push({
    slug: r.slug,
    nsuids,
    evidence: {
      eu: r.eu && { matched: r.eu.matchedTitle, confidence: r.eu.confidence },
      jp: r.jp && { matched: r.jp.matchedTitle, confidence: r.jp.confidence },
      us: r.us && { matched: r.us.matchedTitle, confidence: r.us.confidence },
    },
  });
  if (r.eu?.lowestGbp > 0 && nsuids.europe) seeds[r.slug] = { amount: r.eu.lowestGbp, currency: 'GBP' };
}
fs.mkdirSync(path.dirname(SUGGEST_PATH), { recursive: true });
fs.writeFileSync(SUGGEST_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), note: 'Human review required — merge nsuids into catalog.json manually.', candidates }, null, 2) + '\n');
fs.mkdirSync(path.dirname(SEEDS_PATH), { recursive: true });
fs.writeFileSync(SEEDS_PATH, JSON.stringify(seeds, null, 2) + '\n');
console.log(`\n${candidates.length} candidate(s) written to data/suggestions/nsuid-candidates.json — merge into catalog manually.`);
