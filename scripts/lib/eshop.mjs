/**
 * Nintendo eShop parsing — pure functions, no I/O.
 *
 * NSUID groups (verified 2026-07-08): every game has distinct NSUIDs per
 * storefront group (americas / europe / japan); querying a country with the
 * wrong group's NSUID simply omits it from prices[]. Prefixes: 7001 = game,
 * 7005 = AOC/upgrade, 7007 = bundle. KR/HK/RU are excluded (not purchasable
 * or misleading, see plan §2.2).
 *
 * The /en Nintendo-Europe Solr index prices (price_lowest_f etc.) are GBP —
 * verified against TotK £59.99.
 */

import { toUsd } from './snapshot.mjs';
import { normTitle } from './match.mjs';

const BASE_GAME_NSUID_RE = /^7001\d{10}$/;

function scriptJson(html, predicate) {
  const values = [];
  for (const match of String(html ?? '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = match[1];
    const attr = (name) => {
      const found = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
      return found?.[1] ?? found?.[2] ?? null;
    };
    if (!predicate({ id: attr('id'), type: attr('type') })) continue;
    try {
      values.push(JSON.parse(match[2]));
    } catch { /* malformed third-party JSON is not discovery evidence */ }
  }
  return values;
}

function exactTitle(candidate, wanted) {
  const left = normTitle(candidate);
  const right = normTitle(wanted);
  return Boolean(left && right && left === right);
}

function productPathMatches(url, urlKey) {
  if (!urlKey) return true;
  try {
    const pathname = new URL(url, 'https://www.nintendo.com').pathname.replace(/\/+$/, '');
    return pathname === `/us/store/products/${urlKey}`;
  } catch {
    return false;
  }
}

function jsonLdProducts(value) {
  if (Array.isArray(value)) return value.flatMap(jsonLdProducts);
  if (!value || typeof value !== 'object') return [];
  const ownTypes = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
  const own = ownTypes.some((type) => ['Product', 'VideoGame', 'SoftwareApplication'].includes(type)) ? [value] : [];
  return own.concat(jsonLdProducts(value['@graph']));
}

function idsFromCurrentJsonLd(html, title, urlKey) {
  const ids = new Set();
  for (const value of scriptJson(html, ({ type }) => type?.toLowerCase() === 'application/ld+json')) {
    for (const product of jsonLdProducts(value)) {
      if (!exactTitle(product.name, title)) continue;
      const productUrl = product.offers?.url ?? product.url;
      if (!productPathMatches(productUrl, urlKey)) continue;
      const serialized = JSON.stringify(product);
      for (const match of serialized.matchAll(/store\/software\/(?:switch2?|switch)\/(7001\d{10})(?:\/|["?])/g)) {
        ids.add(match[1]);
      }
    }
  }
  return ids;
}

function idsFromCurrentNextData(html, title, urlKey) {
  const ids = new Set();
  for (const value of scriptJson(html, ({ id }) => id === '__NEXT_DATA__')) {
    if (urlKey && value?.query?.slug !== urlKey) continue;
    // This analytics object describes the page's current product. Do not scan
    // the Apollo cache or recommendations: both contain unrelated 7001 IDs.
    const product = value?.props?.pageProps?.analytics?.product;
    if (!exactTitle(product?.name, title)) continue;
    const nsuid = String(product?.nsuid ?? '');
    if (BASE_GAME_NSUID_RE.test(nsuid)) ids.add(nsuid);
  }
  return ids;
}

/**
 * Extract the Americas base-game NSUID bound to a Nintendo product page.
 *
 * Nintendo pages embed many recommended products. Only the current page's
 * __NEXT_DATA__ analytics product or its exact-title/exact-URL JSON-LD product
 * is valid evidence. Conflicting current-product evidence is rejected.
 */
export function extractUsProductNsuid(html, { title, urlKey } = {}) {
  const ids = new Set([
    ...idsFromCurrentNextData(html, title, urlKey),
    ...idsFromCurrentJsonLd(html, title, urlKey),
  ]);
  if (ids.size !== 1) return null;
  return { nsuid: [...ids][0], matchedTitle: title };
}

export const ESHOP_REGIONS = [
  { cc: 'US', group: 'americas' },
  { cc: 'CA', group: 'americas' },
  { cc: 'MX', group: 'americas' },
  { cc: 'BR', group: 'americas' },
  { cc: 'AR', group: 'americas' },
  { cc: 'CO', group: 'americas' },
  { cc: 'GB', group: 'europe' },
  { cc: 'DE', group: 'europe' },
  { cc: 'PL', group: 'europe' },
  { cc: 'NO', group: 'europe' },
  { cc: 'DK', group: 'europe' },
  { cc: 'CH', group: 'europe' },
  { cc: 'ZA', group: 'europe' },
  { cc: 'AU', group: 'europe' },
  { cc: 'NZ', group: 'europe' },
  { cc: 'JP', group: 'japan' },
];

export const PRICE_BATCH_SIZE = 50;

export function priceUrl(cc, nsuids) {
  return `https://api.ec.nintendo.com/v1/price?country=${cc}&ids=${nsuids.join(',')}&lang=en`;
}

/**
 * Parse one prices[] entry. Returns snapshot row fields or null when the
 * title is not purchasable in that region (not_found / terminated / free).
 */
export function parsePriceEntry(entry) {
  if (!entry || !['onsale', 'pre_order'].includes(entry.sales_status)) return null;
  const regular = Number.parseFloat(entry.regular_price?.raw_value);
  if (!Number.isFinite(regular) || regular <= 0) return null;
  const currency = entry.regular_price?.currency;
  if (!currency) return null;

  const disc = entry.discount_price ? Number.parseFloat(entry.discount_price.raw_value) : null;
  const hasDiscount = Number.isFinite(disc) && disc < regular;
  return {
    currency,
    amount: hasDiscount ? disc : regular,
    list: hasDiscount ? regular : null,
    discountPct: hasDiscount ? Math.round((1 - disc / regular) * 100) : null,
    saleEndsAt: hasDiscount ? (entry.discount_price.end_datetime ?? null) : null,
  };
}

/** Index a price API response by title_id (string keys). */
export function indexPricesById(body) {
  const map = new Map();
  for (const entry of body?.prices ?? []) {
    map.set(String(entry.title_id), entry);
  }
  return map;
}

/**
 * Drop hyperinflation-stale legacy prices (eShop only).
 *
 * Nintendo's API can return regional prices that were set years ago and
 * never adjusted — verified 2026-07-08: Stardew Valley in AR is still
 * ARS 179.99 (a 2017 price, ≈ $0.12 today) while Silksong AR is a sane
 * current ARS 25,842 (≈ $18). Listing $0.12 would be misleading: a region
 * whose USD price is below `minRatio` of the game's median is removed and
 * ranks are recomputed.
 */
export function filterOutlierRegions(rawSnapshot, rates, minRatio = 0.1) {
  const withUsd = rawSnapshot.regions
    // A real regional sale can legitimately be 90% off. Judge staleness by
    // the regular/list price when Nintendo supplies one, but retain the
    // current discounted observation. Legacy hyperinflation rows have no
    // list price, so the original protection still applies to them.
    .map((r) => ({ r, usd: toUsd(r.list ?? r.amount, r.currency, rates) }))
    .filter((x) => x.usd !== null);
  if (withUsd.length < 4) return rawSnapshot; // too few points for a robust median
  const usds = withUsd.map((x) => x.usd).sort((a, b) => a - b);
  const median = usds[Math.floor(usds.length / 2)];
  const keep = new Set(withUsd.filter((x) => x.usd >= median * minRatio).map((x) => x.r.cc));
  if (keep.size === rawSnapshot.regions.length) return rawSnapshot;
  return { ...rawSnapshot, regions: rawSnapshot.regions.filter((r) => keep.has(r.cc)) };
}
