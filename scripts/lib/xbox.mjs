/**
 * Microsoft Store display-catalog helpers for the Xbox US-market POC.
 * Pure parsing lives here; callers own I/O and fail-soft persistence.
 *
 * The catalog commonly returns $0 License/Redeem availabilities alongside a
 * paid offer. A purchasable price MUST come from a current positive-price
 * availability whose Actions include Purchase, never from the cheapest row.
 */
import { titleMatches } from './match.mjs';
import { round2 } from './snapshot.mjs';

export const XBOX_BATCH_SIZE = 20;
const BASE = 'https://displaycatalog.mp.microsoft.com/v7.0';

export function xboxSuggestUrl(title) {
  const q = new URLSearchParams({
    market: 'US',
    languages: 'en-US',
    productFamilyNames: 'Games',
    query: title,
  });
  return `${BASE}/productFamilies/autosuggest?${q}`;
}

export function xboxProductsUrl(bigIds, market = 'US') {
  if (!Array.isArray(bigIds) || bigIds.length === 0 || bigIds.length > XBOX_BATCH_SIZE) {
    throw new Error(`Xbox product lookup requires 1-${XBOX_BATCH_SIZE} bigIds`);
  }
  const q = new URLSearchParams({
    bigIds: bigIds.join(','),
    market: market.toUpperCase(),
    languages: market.toUpperCase() === 'US' ? 'en-US' : 'en',
  });
  return `${BASE}/products?${q}`;
}

/** Exact-title, base-game-only discovery. Ambiguous exact matches are rejected. */
export function parseXboxSuggestion(body, wantedTitle) {
  const matches = (body?.Results ?? [])
    .flatMap((group) => group?.Products ?? [])
    .filter((p) => p?.Type === 'Game' && /^[A-Z0-9]{12}$/i.test(p.ProductId ?? ''))
    .filter((p) => titleMatches(p.Title, wantedTitle));
  const unique = [...new Map(matches.map((p) => [p.ProductId.toUpperCase(), p])).values()];
  if (unique.length !== 1) return null;
  const p = unique[0];
  return { bigId: p.ProductId.toUpperCase(), matchedTitle: p.Title, edition: 'standard' };
}

function currentAvailability(a, now) {
  if (!a?.Actions?.includes('Purchase')) return false;
  const start = Date.parse(a.Conditions?.StartDate ?? '');
  const end = Date.parse(a.Conditions?.EndDate ?? '');
  if (Number.isFinite(start) && start > now) return false;
  if (Number.isFinite(end) && end <= now) return false;
  return true;
}

function honestSaleEnd(value) {
  const t = Date.parse(value ?? '');
  if (!Number.isFinite(t)) return null;
  const year = new Date(t).getUTCFullYear();
  return year < 2100 ? new Date(t).toISOString() : null;
}

/**
 * Parse one approved standard-edition mapping into a local-currency row.
 * Returns null when title/edition/product/offer fingerprints do not match.
 */
export function parseXboxProduct(body, { bigId, expectedTitle, edition = 'standard' }, now = Date.now()) {
  if (edition !== 'standard') return null; // POC deliberately supports one edition only
  const product = (body?.Products ?? []).find((p) => String(p?.ProductId).toUpperCase() === String(bigId).toUpperCase());
  const productTitle = product?.LocalizedProperties?.[0]?.ProductTitle;
  if (!product || product.ProductKind !== 'Game' || !titleMatches(productTitle, expectedTitle)) return null;

  const offers = [];
  for (const display of product.DisplaySkuAvailabilities ?? []) {
    const sku = display?.Sku;
    const skuTitle = sku?.LocalizedProperties?.[0]?.SkuTitle;
    if (sku?.SkuType !== 'full' || sku?.Properties?.IsTrial || sku?.Properties?.IsBundle) continue;
    if (!titleMatches(skuTitle, expectedTitle)) continue;
    for (const availability of display?.Availabilities ?? []) {
      if (!currentAvailability(availability, now)) continue;
      const price = availability?.OrderManagementData?.Price;
      const amount = Number(price?.ListPrice);
      const msrp = Number(price?.MSRP);
      const currency = price?.CurrencyCode;
      if (!(amount > 0) || !/^[A-Z]{3}$/.test(currency ?? '')) continue;
      const discounted = msrp > amount;
      offers.push({
        amount: round2(amount),
        list: discounted ? round2(msrp) : null,
        discountPct: discounted ? Math.round((1 - amount / msrp) * 100) : null,
        saleEndsAt: discounted ? honestSaleEnd(availability?.Conditions?.EndDate) : null,
        currency,
        skuId: sku.SkuId,
        skuTitle,
      });
    }
  }
  if (offers.length === 0) return null;
  offers.sort((a, b) => a.amount - b.amount || String(a.skuId).localeCompare(String(b.skuId)));
  const best = offers[0];
  return {
    matchedTitle: productTitle,
    skuId: best.skuId,
    skuTitle: best.skuTitle,
    row: {
      cc: 'US',
      currency: best.currency,
      amount: best.amount,
      list: best.list,
      discountPct: best.discountPct,
      saleEndsAt: best.saleEndsAt,
    },
  };
}
