/**
 * Derivations over snapshots/history/feeds — pure functions, no I/O.
 * Unit tests: scripts/test/derive.test.mjs (repo root runner).
 */

export const fmtUsd = (n) => (n == null ? null : `$${n.toFixed(2)}`);

const SYMBOLS = { USD: '$', GBP: '£', EUR: '€', JPY: '¥' };
export function fmtMoney(amount, currency) {
  if (amount == null) return null;
  const sym = SYMBOLS[currency];
  const val = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return sym ? `${sym}${val}` : `${val} ${currency}`;
}

/** US-region row of a snapshot (canonical price), or null. */
export function usRow(snapshot) {
  return snapshot?.regions?.find((r) => r.cc === 'US') ?? null;
}

/**
 * Best current price across channels for the hero/table headline.
 * Returns { usd, channel } or null.
 */
export function bestPriceNow(bundle) {
  const candidates = [
    { usd: usRow(bundle.steam)?.usd, channel: 'steam' },
    { usd: usRow(bundle.eshop)?.usd, channel: 'eshop' },
  ].filter((c) => c.usd != null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.usd - b.usd)[0];
}

/** Lowest known ATL across keys, or null. */
export function overallAtl(history) {
  const entries = Object.values(history?.atl ?? {});
  if (entries.length === 0) return null;
  return entries.sort((a, b) => a.usd - b.usd)[0];
}

/**
 * Buy/wait rule text (plan §T4.3: static rule, no model).
 * Returns { verdict: 'BUY'|'FAIR'|'WAIT', text }.
 */
export function buyWaitVerdict(bundle) {
  const best = bestPriceNow(bundle);
  const atl = overallAtl(bundle.history);
  if (!best || !atl) return null;
  const ratio = best.usd / atl.usd;
  const atlNote = atl.seed === 'self' ? 'lowest we have tracked' : 'all-time low on record';
  if (ratio <= 1.001) return { verdict: 'BUY', text: `Current price matches the ${atlNote} (${fmtUsd(atl.usd)}). Historically this is as good as it gets.` };
  if (ratio <= 1.15) return { verdict: 'FAIR', text: `Within 15% of the ${atlNote} (${fmtUsd(atl.usd)}). A fine entry point if you want it now.` };
  return { verdict: 'WAIT', text: `The ${atlNote} is ${fmtUsd(atl.usd)} — ${Math.round((ratio - 1) * 100)}% below today. Patience has paid before.` };
}

/** Region-gap leaderboard rows across all games: biggest cheapest-vs-US savings. */
export function regionGapBoard(bundles, limit = 5) {
  const rows = [];
  for (const b of bundles) {
    for (const snap of [b.eshop, b.steam].filter(Boolean)) {
      const us = usRow(snap);
      const cheapest = snap.regions[0];
      if (!us || !cheapest || cheapest.cc === 'US' || !(us.usd > 0)) continue;
      const savePct = Math.round((1 - cheapest.usd / us.usd) * 100);
      if (savePct < 5) continue;
      rows.push({ slug: b.slug, title: b.game?.title ?? b.slug, cc: cheapest.cc, savePct, channel: snap === b.eshop ? 'eshop' : 'steam' });
      break; // one row per game, prefer eshop (listed first)
    }
  }
  return rows.sort((a, b) => b.savePct - a.savePct).slice(0, limit);
}

/** New-ATL leaderboard: games whose current US price equals their ATL. */
export function atlBoard(bundles, limit = 5) {
  const rows = [];
  for (const b of bundles) {
    const best = bestPriceNow(b);
    const atl = overallAtl(b.history);
    if (!best || !atl || best.usd > atl.usd + 0.001) continue;
    rows.push({ slug: b.slug, title: b.game?.title ?? b.slug, usd: best.usd, date: atl.date });
  }
  return rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, limit);
}

/** Hottest tracked discounts (steam or eshop US row pct). */
export function hotDealsBoard(bundles, limit = 5) {
  const rows = [];
  for (const b of bundles) {
    const pcts = [
      { pct: usRow(b.steam)?.discountPct, usd: usRow(b.steam)?.usd, channel: 'steam' },
      { pct: usRow(b.eshop)?.discountPct, usd: usRow(b.eshop)?.usd, channel: 'eshop' },
    ].filter((x) => x.pct > 0);
    if (pcts.length === 0) continue;
    const top = pcts.sort((a, b2) => b2.pct - a.pct)[0];
    rows.push({ slug: b.slug, title: b.game?.title ?? b.slug, ...top });
  }
  return rows.sort((a, b) => b.pct - a.pct).slice(0, limit);
}

/** Tracked games currently discounted on a channel (deals pages). */
export function trackedDeals(bundles, channel) {
  const rows = [];
  for (const b of bundles) {
    const snap = channel === 'steam' ? b.steam : b.eshop;
    const us = usRow(snap);
    if (!us || !(us.discountPct > 0)) continue;
    rows.push({
      slug: b.slug,
      title: b.game?.title ?? b.slug,
      usd: us.usd,
      listUsd: us.listUsd,
      pct: us.discountPct,
      saleEndsAt: us.saleEndsAt ?? null,
      headerImage: b.meta?.headerImage ?? null,
      reviewPercent: b.meta?.reviewPercent ?? null,
      atl: overallAtl(b.history),
      isAtl: (() => { const a = overallAtl(b.history); return a ? us.usd <= a.usd + 0.001 : false; })(),
    });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

/** Sparkline path data for price history events (US, one channel). */
export function historySeries(history, channel) {
  return (history?.events ?? [])
    .filter((e) => e.ch === channel && e.cc === 'US')
    .map((e) => ({ d: e.d, usd: e.usd, pct: e.pct }));
}
