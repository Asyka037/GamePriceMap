/**
 * Microsoft Store display-catalog helpers for the Xbox US-market POC.
 * Pure parsing lives here; callers own I/O and fail-soft persistence.
 *
 * The catalog commonly returns $0 License/Redeem availabilities alongside a
 * paid offer. A purchasable price MUST come from a current positive-price
 * availability whose Actions include Purchase, never from the cheapest row.
 */
import { normTitle } from './match.mjs';
import { round2 } from './snapshot.mjs';

export const XBOX_BATCH_SIZE = 20;
const BASE = 'https://displaycatalog.mp.microsoft.com/v7.0';

export function validXboxBigId(value) {
  return typeof value === 'string' && /^[A-Z0-9]{12}$/u.test(value);
}

export function exactXboxTitle(left, right) {
  const a = normTitle(left);
  const b = normTitle(right);
  return Boolean(a && b && a === b);
}

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
    .filter((p) => exactXboxTitle(p.Title, wantedTitle));
  const unique = [...new Map(matches.map((p) => [p.ProductId.toUpperCase(), p])).values()];
  if (unique.length !== 1) return null;
  const p = unique[0];
  return { bigId: p.ProductId.toUpperCase(), matchedTitle: p.Title, edition: 'standard' };
}

function currentAvailability(a, now) {
  if (!a?.Actions?.includes('Purchase')) return false;
  const start = Date.parse(a.Conditions?.StartDate ?? '');
  const end = Date.parse(a.Conditions?.EndDate ?? '');
  return Number.isFinite(now)
    && Number.isFinite(start)
    && Number.isFinite(end)
    && end > start
    && start <= now
    && now < end;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).toSorted().join('\0') === expected.join('\0');
}

function knownPublicConditions(conditions) {
  if (!exactKeys(conditions, ['ClientConditions', 'EndDate', 'ResourceSetIds', 'StartDate'])) return false;
  if (!Array.isArray(conditions.ResourceSetIds)
    || conditions.ResourceSetIds.length !== 1
    || conditions.ResourceSetIds[0] !== '1') return false;
  const client = conditions.ClientConditions;
  if (!exactKeys(client, ['AllowedPlatforms'])
    || !Array.isArray(client.AllowedPlatforms)
    || client.AllowedPlatforms.length < 1
    || client.AllowedPlatforms.length > 3) return false;
  const seen = new Set();
  for (const platform of client.AllowedPlatforms) {
    if (!exactKeys(platform, ['MaxVersion', 'MinVersion', 'PlatformName'])
      || !Number.isSafeInteger(platform.MinVersion)
      || !Number.isSafeInteger(platform.MaxVersion)
      || platform.MinVersion < 0
      || platform.MaxVersion < platform.MinVersion
      || !['Windows.8828080', 'Windows.Desktop', 'Windows.Xbox'].includes(platform.PlatformName)
      || seen.has(platform.PlatformName)) return false;
    seen.add(platform.PlatformName);
  }
  return seen.has('Windows.Xbox');
}

export function publicPurchaseAvailability(availability, now) {
  if (!currentAvailability(availability, now)) return false;
  if (!Array.isArray(availability.Actions)
    || new Set(availability.Actions).size !== availability.Actions.length
    || availability.Actions.some((action) => ![
      'Browse', 'Curate', 'Details', 'Fulfill', 'Gift', 'Purchase', 'Redeem',
    ].includes(action))) return false;
  if (!knownPublicConditions(availability.Conditions)) return false;
  if (!Array.isArray(availability?.OrderManagementData?.GrantedEntitlementKeys)
    || availability.OrderManagementData.GrantedEntitlementKeys.length !== 0) return false;
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
  if (!product || product.ProductKind !== 'Game' || !exactXboxTitle(productTitle, expectedTitle)) return null;

  const offers = [];
  for (const display of product.DisplaySkuAvailabilities ?? []) {
    const sku = display?.Sku;
    const skuTitle = sku?.LocalizedProperties?.[0]?.SkuTitle;
    if (sku?.SkuType !== 'full' || sku?.Properties?.IsTrial || sku?.Properties?.IsBundle) continue;
    if (!exactXboxTitle(skuTitle, expectedTitle)) continue;
    for (const availability of display?.Availabilities ?? []) {
      if (!publicPurchaseAvailability(availability, now)) continue;
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
  const uniqueOffers = [...new Map(offers.map((offer) => [JSON.stringify(offer), offer])).values()];
  if (uniqueOffers.length !== 1) return null;
  const [best] = uniqueOffers;
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
