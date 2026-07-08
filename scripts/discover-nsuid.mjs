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
 *   node scripts/discover-nsuid.mjs --apply [slug..] # write high-confidence results
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const SEEDS_PATH = path.join(ROOT, 'data', 'seeds', 'eshop-eu-lows.json');
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlySlugs = args.filter((a) => a !== '--apply');

const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
const targets = catalog.games.filter((g) =>
  (onlySlugs.length ? onlySlugs.includes(g.slug)
    : (g.platforms.some((p) => p.startsWith('switch')) && !g.nsuids)));

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
const isBaseGame = (nsuid, title) => String(nsuid).startsWith('7001') && !/switch\s*2\s*edition/i.test(title ?? '');

/**
 * Matching policy (tightened after the first dry run mis-matched
 * "Hollow Knight" -> Silksong and "Hades" -> HADES II):
 * exact normalized title equality — optionally after stripping a trailing
 * edition/trademark suffix — is required. "Contains"/"startsWith" are
 * NOT matches: franchise names are prefixes of their sequels.
 */
function titleMatches(candidate, wanted) {
  const c = norm(candidate);
  const w = norm(wanted);
  if (c === w) return true;
  // tolerate suffixes like "... for Nintendo Switch" on an otherwise exact title
  return c.startsWith(w) && /^(fornintendoswitch|nintendoswitchedition)$/.test(c.slice(w.length));
}

async function discoverEurope(title) {
  const url = `https://searching.nintendo-europe.com/en/select?q=${encodeURIComponent(title)}&fq=type%3AGAME&rows=8&wt=json`;
  const body = await fetchJson(url, { label: 'eu search' });
  for (const doc of body.response?.docs ?? []) {
    const nsuid = (doc.nsuid_txt ?? []).find((n) => isBaseGame(n, doc.title));
    if (!nsuid) continue;
    if (titleMatches(doc.title, title)) {
      return { nsuid, matchedTitle: doc.title, confidence: 'high', lowestGbp: doc.price_lowest_f ?? null };
    }
  }
  return null;
}

async function discoverJapan(title) {
  const url = `https://search.nintendo.jp/nintendo_soft/search.json?q=${encodeURIComponent(title)}&limit=8`;
  const body = await fetchJson(url, { label: 'jp search' });
  for (const item of body.result?.items ?? []) {
    if (!isBaseGame(item.nsuid, item.title)) continue;
    // JP titles are often "English Title（日本語タイトル）" — compare the segment before the fullwidth paren
    const jpMain = String(item.title).split('（')[0];
    if (titleMatches(jpMain, title) || titleMatches(item.title, title)) {
      return { nsuid: String(item.nsuid), matchedTitle: item.title, confidence: 'high' };
    }
  }
  return null;
}

async function discoverAmericas(slug, title) {
  for (const candidate of [`${slug}-switch`, slug]) {
    try {
      const res = await fetch(`https://www.nintendo.com/us/store/products/${candidate}/`, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) continue;
      // Guessed URLs can 200-redirect to a generic store page whose HTML
      // still contains *other* games' NSUIDs — require the product URL to
      // survive redirects AND the page to actually name this game.
      if (!res.url.includes('/store/products/')) continue;
      const html = await res.text();
      if (!norm(html).includes(norm(title))) continue;
      const bases = [...new Set(html.match(/70\d{12}/g) ?? [])].filter((n) => n.startsWith('7001'));
      if (bases.length === 1) return { nsuid: bases[0], matchedTitle: candidate, confidence: 'high' };
      if (bases.length > 1) {
        // base + Switch 2 Edition on one page; the base NSUID is the older (smaller) one
        const sorted = [...bases].sort();
        return { nsuid: sorted[0], matchedTitle: `${candidate} (multi: ${bases.join('/')})`, confidence: 'medium' };
      }
    } catch { /* try next candidate */ }
  }
  return null;
}

const results = [];
for (const g of targets) {
  const [eu, jp, us] = [
    await discoverEurope(g.title).catch(() => null),
    await discoverJapan(g.title).catch(() => null),
    await discoverAmericas(g.slug, g.title).catch(() => null),
  ];
  results.push({ slug: g.slug, eu, jp, us });
  const fmt = (r) => (r ? `${r.nsuid} [${r.confidence}]` : '—');
  console.log(`${g.slug.padEnd(32)} EU ${fmt(eu).padEnd(26)} JP ${fmt(jp).padEnd(26)} US ${fmt(us)}`);
  await sleep(1200);
}

if (!apply) {
  console.log('\nDry run. Re-run with --apply to write high-confidence results to catalog.');
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

const seeds = fs.existsSync(SEEDS_PATH) ? JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf8')) : {};
let applied = 0;
for (const r of results) {
  const game = catalog.games.find((g) => g.slug === r.slug);
  // EU/JP: exact-title 'high' only. US: 'medium' allowed — it is title-verified
  // and only ambiguous between base and Switch 2 Edition (older NSUID wins).
  const nsuids = {
    americas: r.us && ['high', 'medium'].includes(r.us.confidence) ? r.us.nsuid : null,
    europe: r.eu?.confidence === 'high' ? r.eu.nsuid : null,
    japan: r.jp?.confidence === 'high' ? r.jp.nsuid : null,
  };
  if (!nsuids.americas && !nsuids.europe && !nsuids.japan) continue;
  game.nsuids = nsuids;
  applied++;
  if (r.eu?.lowestGbp > 0 && nsuids.europe) seeds[r.slug] = { amount: r.eu.lowestGbp, currency: 'GBP' };
}
fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2).replace(/^(\s*)"games": \[/m, '$1"games": [') + '\n');
fs.mkdirSync(path.dirname(SEEDS_PATH), { recursive: true });
fs.writeFileSync(SEEDS_PATH, JSON.stringify(seeds, null, 2) + '\n');
console.log(`\nApplied nsuids for ${applied} game(s); EU GBP lows seeded for ${Object.keys(seeds).length}.`);
