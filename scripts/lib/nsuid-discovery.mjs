/**
 * Pure Nintendo regional-candidate selectors used by discover-nsuid.mjs.
 *
 * Nintendo uses HAC for the original Switch and BEE for Switch 2. Exact
 * title equality is not sufficient evidence: the same title can exist on
 * both generations, and search results can rank a BEE re-release first.
 */
import { titleMatches } from './match.mjs';

const BASE_GAME_NSUID_RE = /^7001\d{10}$/;

function values(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function switchGenerations(platforms) {
  const allowed = new Set();
  for (const platform of platforms ?? []) {
    if (platform === 'switch') allowed.add('HAC');
    if (platform === 'switch-2') allowed.add('BEE');
  }
  return allowed;
}

function codeGenerations(input) {
  const found = new Set();
  for (const value of values(input)) {
    const normalized = String(value).toUpperCase();
    if (normalized.includes('HAC')) found.add('HAC');
    if (normalized.includes('BEE')) found.add('BEE');
  }
  return found;
}

function systemGenerations(input) {
  const found = new Set();
  for (const value of values(input)) {
    const normalized = String(value).toLowerCase();
    if (/nintendo\s+switch\s*2/.test(normalized)) found.add('BEE');
    else if (/nintendo\s+switch/.test(normalized)) found.add('HAC');
  }
  return found;
}

function consistentGeneration(...evidenceSets) {
  const found = new Set(evidenceSets.flatMap((set) => [...set]));
  return found.size === 1 ? [...found][0] : null;
}

function oneBaseNsuid(input) {
  const ids = [...new Set(values(input).map(String).filter((id) => BASE_GAME_NSUID_RE.test(id)))];
  return ids.length === 1 ? ids[0] : null;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function releasedBy(doc, now) {
  const release = doc.date_from ?? values(doc.dates_released_dts)[0];
  if (!release) return true;
  const releaseMs = Date.parse(release);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return !Number.isFinite(releaseMs) || !Number.isFinite(nowMs) || releaseMs <= nowMs;
}

function positiveEuropePrice(doc) {
  const lowest = finiteNumber(doc.price_lowest_f);
  if (lowest !== null) return lowest > 0;
  return (finiteNumber(doc.price_regular_f) ?? -1) > 0;
}

function europeIsPurchasable(doc, now) {
  if (doc.type != null && String(doc.type).toUpperCase() !== 'GAME') return false;
  if (booleanValue(doc.eshop_removed_b) === true) return false;
  // Nintendo first-party base games can be marked digital_version_b=false in
  // Solr even while the official price API sells the exact 7001 title. The
  // discovery command therefore verifies the selected ID against that API;
  // this index flag alone is not authoritative evidence of physical-only.
  return releasedBy(doc, now) && positiveEuropePrice(doc);
}

function japanIsPurchasable(item) {
  if (String(item.ssitu ?? '').toLowerCase() !== 'onsale') return false;
  if (booleanValue(item.upgrade) === true) return false;
  const form = [item.sform, item.sform_n, item.sctg].filter(Boolean).join(' ');
  if (/(?:DLC|AOC|UPGRADE|BUNDLE)/i.test(form)) return false;

  // current_price is authoritative during a sale. Falling back preserves
  // older search-result shapes that expose only price/dprice/pprice.
  const price = [item.current_price, item.price, item.dprice, item.pprice]
    .map(finiteNumber)
    .find((value) => value !== null);
  return price != null && price > 0;
}

function japanTitleMatches(candidate, wanted) {
  const main = String(candidate ?? '').split(/[（(]/)[0];
  return titleMatches(main, wanted) || titleMatches(candidate, wanted);
}

/** Select an exact, released, paid EU base game for the catalog platform. */
export function selectEuropeDiscoveryCandidate(docs, { title, platforms, now = Date.now() } = {}) {
  const allowed = switchGenerations(platforms);
  if (allowed.size === 0) return null;

  for (const doc of docs ?? []) {
    if (!titleMatches(doc.title, title)) continue;
    const nsuid = oneBaseNsuid(doc.nsuid_txt);
    if (!nsuid || !europeIsPurchasable(doc, now)) continue;

    const generation = consistentGeneration(
      codeGenerations(doc.playable_on_txt),
      systemGenerations(doc.system_names_txt),
    );
    if (!generation || !allowed.has(generation)) continue;

    return {
      nsuid,
      matchedTitle: doc.title,
      lowestGbp: finiteNumber(doc.price_lowest_f),
    };
  }
  return null;
}

/** Select an exact, on-sale, paid JP base game for the catalog platform. */
export function selectJapanDiscoveryCandidate(items, { title, platforms } = {}) {
  const allowed = switchGenerations(platforms);
  if (allowed.size === 0) return null;

  for (const item of items ?? []) {
    if (!japanTitleMatches(item.title, title)) continue;
    const nsuid = oneBaseNsuid(item.nsuid ?? item.id);
    if (!nsuid || !japanIsPurchasable(item)) continue;

    const generation = consistentGeneration(
      codeGenerations(item.hard),
      codeGenerations(item.sform),
    );
    if (!generation || !allowed.has(generation)) continue;

    return { nsuid, matchedTitle: item.title };
  }
  return null;
}
