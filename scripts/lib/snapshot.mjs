/**
 * Shared snapshot assembly (§4.2 schema) — pure functions, no I/O.
 * Used by both the Steam and eShop scrapers.
 */

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** rates: USD -> currency multipliers (open.er-api shape). */
export function toUsd(amount, currency, rates) {
  if (currency === 'USD') return round2(amount);
  const rate = rates[currency];
  if (!rate || rate <= 0) return null;
  return round2(amount / rate);
}

/**
 * rows: [{ cc, currency, amount, list, discountPct, saleEndsAt }]
 * Rows without a convertible USD value are dropped; result sorted by usd
 * ascending with 1-based ranks.
 */
export function assembleSnapshot(slug, rows, rates, now = new Date()) {
  const regions = [];
  for (const row of rows) {
    if (!row || !(row.amount > 0)) continue;
    const usd = toUsd(row.amount, row.currency, rates);
    if (usd === null) continue;
    regions.push({
      cc: row.cc.toUpperCase(),
      currency: row.currency,
      amount: row.amount,
      usd,
      list: row.list ?? null,
      listUsd: row.list != null ? toUsd(row.list, row.currency, rates) : null,
      discountPct: row.discountPct ?? null,
      saleEndsAt: row.saleEndsAt ?? null,
      rank: 0,
    });
  }
  regions.sort((a, b) => a.usd - b.usd);
  regions.forEach((r, i) => { r.rank = i + 1; });
  return { slug, updatedAt: now.toISOString(), regions };
}
