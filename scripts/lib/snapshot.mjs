/**
 * Snapshot layer v2 (data-v2.1 §1) — pure functions, no I/O.
 *
 * git 只存原始观测（本币）；USD/排名是构建期派生。实证依据：把 usd/rank 写进
 * 快照时，汇率第四位小数的日常抖动使 42/42 文件天天全脏（2026-07-11 取证）。
 *
 * Raw snapshot shape (the ONLY thing scrapers persist):
 *   { slug, lastPriceChangeAt, regions: [{ cc, currency, amount, list,
 *     discountPct, saleEndsAt }] }   — regions sorted by cc for stable diffs
 *
 * Derived shape (site build / validate only, never written to data/):
 *   regions gain usd/listUsd and are re-sorted by usd with 1-based rank.
 */

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Fields derived at build time and forbidden in persisted raw observations. */
export const DERIVED_REGION_FIELDS = Object.freeze(['usd', 'listUsd', 'rank']);

/** rates: USD -> currency multipliers (open.er-api shape). */
export function toUsd(amount, currency, rates) {
  if (currency === 'USD') return round2(amount);
  const rate = rates[currency];
  if (!rate || rate <= 0) return null;
  return round2(amount / rate);
}

/**
 * rows: [{ cc, currency, amount, list, discountPct, saleEndsAt }]
 * Drops unpriced rows; sorts by cc (lexicographic) so file diffs are stable
 * and independent of any derived ordering.
 */
export function assembleRawSnapshot(slug, rows) {
  const regions = [];
  for (const row of rows) {
    if (!row || !(row.amount > 0) || !row.currency) continue;
    regions.push({
      cc: row.cc.toUpperCase(),
      currency: row.currency,
      amount: row.amount,
      list: row.list ?? null,
      discountPct: row.discountPct ?? null,
      saleEndsAt: row.saleEndsAt ?? null,
    });
  }
  regions.sort((a, b) => a.cc.localeCompare(b.cc));
  return { slug, lastPriceChangeAt: null, regions };
}

/** Semantic equality for the write guard — timestamps excluded by design. */
export function sameObservations(a, b) {
  return JSON.stringify(a?.regions ?? null) === JSON.stringify(b?.regions ?? null);
}

/**
 * Build-time derivation: attach usd/listUsd, sort by usd, assign rank.
 * Regions whose currency has no rate are dropped (validate treats a missing
 * rate as a hard failure so this never silently hides data in production).
 */
export function enrichSnapshot(raw, rates) {
  if (!raw) return null;
  const regions = [];
  for (const r of raw.regions ?? []) {
    const usd = toUsd(r.amount, r.currency, rates);
    if (usd === null) continue;
    regions.push({
      ...r,
      usd,
      listUsd: r.list != null ? toUsd(r.list, r.currency, rates) : null,
      rank: 0,
    });
  }
  regions.sort((a, b) => a.usd - b.usd);
  regions.forEach((r, i) => { r.rank = i + 1; });
  return { ...raw, regions };
}

/**
 * The US row carries native USD (invariant asserted by validate) — history
 * events read it without any FX conversion, keeping them jitter-immune.
 */
export function usObservation(raw) {
  const us = raw?.regions?.find((r) => r.cc === 'US');
  if (!us || us.currency !== 'USD') return null;
  return { ...us, usd: us.amount };
}
