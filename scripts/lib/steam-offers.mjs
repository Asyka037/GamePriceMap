/**
 * Supplemental Steam editions and add-ons — pure functions, no I/O.
 *
 * These observations are intentionally kept outside data/snapshots/**.  The
 * canonical base-game snapshot is the only input to regional rank and vs-US;
 * supplemental offers gain USD display values at build time, but never rank,
 * delta, or baseline fields.
 */

import { assembleRawSnapshot, round2, toUsd } from './snapshot.mjs';

export const DERIVED_STEAM_OFFER_FIELDS = Object.freeze([
  'usd', 'listUsd', 'rank', 'delta', 'vsUs', 'vsUsPct',
]);

export function buildSteamPackageUrl(packageId, cc) {
  return `https://store.steampowered.com/api/packagedetails?packageids=${packageId}&cc=${cc}&l=english`;
}

const sortedIds = (ids) => [...ids].map(Number).sort((a, b) => a - b);

/**
 * Parse one official `packagedetails` entry.
 *
 * Human review decides which packages belong to a logical game.  For an
 * edition containing the base game, expectedAppIds is also an exact machine
 * guard: if Steam later changes package contents, the row fails closed rather
 * than silently admitting a sequel/cross-game bundle.
 */
export function parseSteamPackageDetail(entry, offer) {
  if (!entry || entry.success !== true) return null;
  const data = entry.data;
  const price = data?.price;
  if (!price || !(price.final > 0) || typeof price.currency !== 'string') return null;

  if (offer.expectedStoreName && data.name !== offer.expectedStoreName) {
    throw new Error(`package ${offer.packageId} store name changed to "${data.name ?? 'missing'}"`);
  }
  if (offer.requiredPageText && !String(data.page_content ?? '').toLowerCase().includes(offer.requiredPageText.toLowerCase())) {
    throw new Error(`package ${offer.packageId} no longer confirms its reviewed add-on requirement`);
  }

  const appIds = sortedIds((data.apps ?? []).map((app) => app.id));
  const expectedAppIds = sortedIds(offer.expectedAppIds ?? []);
  if (offer.includesBaseGame) {
    if (!appIds.includes(offer.baseAppId)) {
      throw new Error(`package ${offer.packageId} no longer includes base app ${offer.baseAppId}`);
    }
    if (JSON.stringify(appIds) !== JSON.stringify(expectedAppIds)) {
      throw new Error(`package ${offer.packageId} contents changed (${appIds.join(',') || 'none'})`);
    }
  } else if (appIds.includes(offer.baseAppId)) {
    throw new Error(`add-on package ${offer.packageId} unexpectedly includes the base game`);
  } else if (expectedAppIds.length > 0 && JSON.stringify(appIds) !== JSON.stringify(expectedAppIds)) {
    throw new Error(`package ${offer.packageId} contents changed (${appIds.join(',') || 'none'})`);
  }

  const amount = round2(price.final / 100);
  const initial = typeof price.initial === 'number' ? round2(price.initial / 100) : amount;
  const derivedDiscount = initial > amount ? Math.round((1 - amount / initial) * 100) : 0;
  const discountPct = price.discount_percent > 0 ? price.discount_percent : derivedDiscount;
  return {
    currency: price.currency.toUpperCase(),
    amount,
    list: discountPct > 0 && initial > amount ? initial : null,
    discountPct: discountPct > 0 && initial > amount ? discountPct : null,
  };
}

/** Assemble a stable, raw-only supplemental offer snapshot. */
export function buildSteamOfferSnapshot(slug, offers, regionPrices) {
  const rows = offers.map((offer) => {
    const prices = regionPrices.get?.(offer.packageId) ?? regionPrices[offer.packageId] ?? {};
    const regions = assembleRawSnapshot(slug, Object.entries(prices).map(([cc, price]) => (
      price ? { cc, ...price, saleEndsAt: null } : null
    ))).regions;
    return {
      packageId: offer.packageId,
      name: offer.name,
      kind: offer.kind,
      includesBaseGame: offer.includesBaseGame,
      regions,
    };
  }).sort((a, b) => a.packageId - b.packageId);
  return { slug, lastPriceChangeAt: null, offers: rows };
}

/**
 * Carry the last good row only when a request/parser never produced a key.
 * An own key with null is an explicit, successful "not sold in this region"
 * observation and must not resurrect stale data.
 */
export function preserveFailedSteamOfferRows(offers, regionPrices, previous, regionCodes) {
  const out = new Map();
  for (const offer of offers) {
    const current = regionPrices.get?.(offer.packageId) ?? regionPrices[offer.packageId] ?? {};
    const merged = { ...current };
    const oldOffer = previous?.offers?.find((item) => item.packageId === offer.packageId);
    for (const cc of regionCodes) {
      if (Object.hasOwn(merged, cc)) continue;
      const oldRow = oldOffer?.regions?.find((row) => row.cc === cc.toUpperCase());
      if (oldRow) {
        merged[cc] = {
          currency: oldRow.currency,
          amount: oldRow.amount,
          list: oldRow.list,
          discountPct: oldRow.discountPct,
        };
      }
    }
    out.set(offer.packageId, merged);
  }
  return out;
}

/** Timestamp-independent semantic write guard. */
export function sameSteamOfferObservations(a, b) {
  return JSON.stringify(a?.offers ?? null) === JSON.stringify(b?.offers ?? null);
}

/** Price-change timestamps ignore reviewed labels/classification metadata. */
export function sameSteamOfferPrices(a, b) {
  const priceFacts = (doc) => (doc?.offers ?? []).map((offer) => ({
    packageId: offer.packageId,
    regions: offer.regions,
  }));
  return JSON.stringify(priceFacts(a)) === JSON.stringify(priceFacts(b));
}

/**
 * Build-time USD estimates for display only.  Region order remains cc-stable;
 * no rank or vs-US field is ever assigned here.
 */
export function enrichSteamOffers(raw, rates) {
  if (!raw) return null;
  return {
    ...raw,
    offers: (raw.offers ?? []).map((offer) => ({
      ...offer,
      regions: (offer.regions ?? []).flatMap((region) => {
        const usd = toUsd(region.amount, region.currency, rates);
        if (usd === null) return [];
        return [{
          ...region,
          usd,
          listUsd: region.list != null ? toUsd(region.list, region.currency, rates) : null,
        }];
      }),
    })),
  };
}
