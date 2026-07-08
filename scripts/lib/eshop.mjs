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
export function filterOutlierRegions(snapshot, minRatio = 0.1) {
  const usds = snapshot.regions.map((r) => r.usd).sort((a, b) => a - b);
  if (usds.length < 4) return snapshot; // too few points for a robust median
  const median = usds[Math.floor(usds.length / 2)];
  const kept = snapshot.regions.filter((r) => r.usd >= median * minRatio);
  if (kept.length === snapshot.regions.length) return snapshot;
  kept.sort((a, b) => a.usd - b.usd);
  kept.forEach((r, i) => { r.rank = i + 1; });
  return { ...snapshot, regions: kept };
}
