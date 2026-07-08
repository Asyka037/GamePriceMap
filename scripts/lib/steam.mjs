/**
 * Steam Storefront parsing — pure functions, no I/O.
 *
 * Endpoint behavior (verified 2026-07-08, see docs/plans/*-dealdex-v1-plan.md §2.1):
 * - Batched appids only work with filters=price_overview alone; any combined
 *   filters on a multi-appid request return HTTP 400.
 * - `currency` in the response must be trusted as-is. TR/AR/PK return USD.
 * - `initial`/`final` are minor units scaled by 100 for every currency.
 */

/** Region set: reference project's 19 minus RU (price shown but store unusable). */
export const STEAM_REGIONS = [
  'ua', 'kz', 'pk', 'in', 'tr', 'ge', 'ar', 'br', 'cn',
  'kr', 'jp', 'ca', 'us', 'au', 'gb', 'de', 'mx', 'ch',
];

export const APPDETAILS_BATCH_SIZE = 50;

export function buildPriceUrl(appIds, cc) {
  return `https://store.steampowered.com/api/appdetails?appids=${appIds.join(',')}&cc=${cc}&l=english&filters=price_overview`;
}

/**
 * Parse one appdetails entry into numeric price facts, or null when the
 * region has no price (unreleased / not sold there).
 */
export function parsePriceOverview(entry) {
  if (!entry || entry.success !== true) return null;
  const po = entry.data?.price_overview;
  if (!po || typeof po.final !== 'number') return null;

  const amount = po.final / 100;
  const list = po.initial / 100;
  const discountPct = po.discount_percent || 0;
  return {
    currency: po.currency,
    amount: round2(amount),
    list: discountPct > 0 ? round2(list) : null,
    discountPct: discountPct > 0 ? discountPct : null,
  };
}

/**
 * Assemble one game's regional snapshot (§4.2 schema):
 * regionPrices: { cc -> parsePriceOverview() result }.
 * Delegates to the shared snapshot assembler; Steam has no sale-end times.
 */
export function buildSnapshot(slug, regionPrices, rates, now = new Date()) {
  const rows = Object.entries(regionPrices)
    .filter(([, p]) => p)
    .map(([cc, p]) => ({ cc, currency: p.currency, amount: p.amount, list: p.list, discountPct: p.discountPct, saleEndsAt: null }));
  return assembleSnapshot(slug, rows, rates, now);
}

export { toUsd, round2 } from './snapshot.mjs';
import { assembleSnapshot, round2 } from './snapshot.mjs';
