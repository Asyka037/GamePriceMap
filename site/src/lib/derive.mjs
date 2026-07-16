/**
 * Derivations over snapshots/history/feeds — pure functions, no I/O.
 * Unit tests: scripts/test/derive.test.mjs (repo root runner).
 */

import { regionalPriceModel } from './regions.mjs';

export const fmtUsd = (n) => (n == null ? null : `$${n.toFixed(2)}`);
const AMBIGUOUS_DOLLAR_CURRENCIES = new Set(['ARS', 'AUD', 'CAD', 'MXN', 'NZD']);

/** endsAt 缺失视为长期有效；已过期返回 false（UTC 比较）。 */
export function isLive(endsAt, now = Date.now()) {
  if (!endsAt) return true;
  const t = Date.parse(endsAt);
  return !Number.isFinite(t) || t > now;
}

/** 渠道对应的 ATL，绝不跨渠道混用。 */
export function atlFor(history, channel) {
  const key = { steam: 'pc', eshop: 'eshop-us', xbox: 'xbox-us' }[channel];
  if (!key) return null;
  return history?.atl?.[key] ?? null;
}

export function fmtMoney(amount, currency) {
  if (amount == null) return null;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: AMBIGUOUS_DOLLAR_CURRENCIES.has(currency) ? 'symbol' : 'narrowSymbol',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    const value = Number.isInteger(amount) ? amount.toLocaleString('en-US') : amount.toFixed(2);
    return `${value} ${currency}`;
  }
}

/** Dynamic, mathematically honest copy for a game's canonical regional table. */
export function regionalPriceSummary(gameTitle, storeLabel, snapshot) {
  const model = regionalPriceModel(snapshot);
  const { cheapest, mostExpensive, savingsPct, priceSpreadPct } = model;
  if (!cheapest || !mostExpensive) return null;
  const lead = `Compare ${gameTitle} ${storeLabel} prices globally. Cheapest: ${cheapest.countryName} (${fmtUsd(cheapest.usd)}). Most expensive: ${mostExpensive.countryName} (${fmtUsd(mostExpensive.usd)}).`;
  const text = priceSpreadPct > 0
    ? `${lead} Save up to ${savingsPct}% via regional pricing.`
    : `${lead} Tracked regional prices are currently equal.`;
  return { ...model, text };
}

const platformListFormatter = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/**
 * Summary facts for every regional storefront shown in the unified table. The
 * opening names all available platforms, while cheapest / most expensive / save
 * facts come from the same max-savings storefront selected for cards.
 */
export function multiRegionalPriceSummary(gameTitle, sources) {
  const usableSources = modeledRegionalSources(sources);
  const selected = [...usableSources].sort(compareRegionalSavingsSources)[0];
  if (!selected) return null;

  const withSource = (row) => ({
    ...row,
    sourceKey: selected.key,
    sourceLabel: selected.label,
  });
  const cheapest = withSource(selected.model.cheapest);
  const mostExpensive = withSource(selected.model.mostExpensive);
  const { priceSpreadPct, savingsPct } = selected.model;
  const hasRange = mostExpensive.usd > cheapest.usd;
  const platformListLabel = platformListFormatter.format(usableSources.map((source) => source.label));
  const showSource = usableSources.length > 1;
  const lead = `Compare ${gameTitle} ${platformListLabel} prices globally. Cheapest: ${cheapest.countryName} (${fmtUsd(cheapest.usd)}). Most expensive: ${mostExpensive.countryName} (${fmtUsd(mostExpensive.usd)}).`;
  const text = hasRange
    ? `${lead} Save up to ${savingsPct}% ${showSource ? 'across tracked stores and regions' : 'via regional pricing'}.`
    : `${lead} Tracked regional prices are currently equal.`;
  return {
    gameTitle,
    platformListLabel,
    sourceKey: selected.key,
    sourceLabel: selected.label,
    cheapest,
    mostExpensive,
    savingsPct,
    priceSpreadPct,
    text,
  };
}

/** US-region row of a snapshot (canonical price), or null. */
export function usRow(snapshot) {
  return snapshot?.regions?.find((r) => r.cc === 'US') ?? null;
}

/**
 * One logical game can have several store IDs, but its regional page has one
 * canonical source.  A catalog override wins when that source has data;
 * otherwise Steam is the default mainstream source and eShop is the fallback.
 * Keeping this decision in one pure function prevents SEO, overview and home
 * boards from silently choosing different platforms.
 */
export function primaryRegionalSource(bundle) {
  const configured = bundle?.game?.primaryRegionalChannel;
  const order = configured
    ? [configured, ...['steam', 'eshop'].filter((key) => key !== configured)]
    : ['steam', 'eshop'];
  for (const key of order) {
    const snapshot = bundle?.[key];
    if (snapshot?.regions?.length) {
      return { key, label: key === 'steam' ? 'Steam' : 'Nintendo eShop', snapshot };
    }
  }
  return null;
}

/**
 * Regional sources eligible for the unified comparison table. Xbox remains a
 * US-only POC and is deliberately excluded until it has multi-region data.
 */
export function regionalPriceSources(bundle) {
  return [
    { key: 'steam', label: 'Steam', snapshot: bundle?.steam },
    { key: 'eshop', label: 'Nintendo eShop', snapshot: bundle?.eshop },
  ].filter((source) => (source.snapshot?.regions ?? []).filter((row) => row?.cc && row?.usd > 0).length > 1);
}

function modeledRegionalSources(sources) {
  return (sources ?? []).flatMap((source, sourceIndex) => {
    const model = regionalPriceModel(source?.snapshot);
    return model.cheapest && model.mostExpensive
      ? [{ ...source, sourceIndex, model }]
      : [];
  });
}

/**
 * Selects one complete storefront price set for all reader-facing regional
 * facts. The visible "Save up to" percentage is the primary score; equal
 * percentages favour the larger USD spread, then the lower entry price and
 * finally the stable source order. This prevents cross-store min/max mixing.
 */
function compareRegionalSavingsSources(a, b) {
  const spreadA = a.model.mostExpensive.usd - a.model.cheapest.usd;
  const spreadB = b.model.mostExpensive.usd - b.model.cheapest.usd;
  return b.model.savingsPct - a.model.savingsPct
    || spreadB - spreadA
    || a.model.cheapest.usd - b.model.cheapest.usd
    || a.sourceIndex - b.sourceIndex
    || a.key.localeCompare(b.key);
}

export function regionalDisplaySource(sources) {
  const selected = modeledRegionalSources(sources).sort(compareRegionalSavingsSources)[0];
  if (!selected) return null;
  const { sourceIndex: _sourceIndex, ...source } = selected;
  return source;
}

/**
 * Card facts for one logical game. When several stores have regional data, the
 * store with the largest visible savings owns the whole comparison. Cheapest,
 * most expensive and savings therefore always belong to one price set.
 */
export function regionalCardModel(bundle, { channels = ['steam', 'eshop'] } = {}) {
  const allowed = new Set(channels);
  const source = regionalDisplaySource(regionalPriceSources(bundle).filter((candidate) => allowed.has(candidate.key)));
  if (!source) return null;

  return {
    slug: bundle.slug,
    title: bundle.game?.title ?? bundle.slug,
    headerImage: bundle.meta?.headerImage ?? null,
    reviewCount: Number.isFinite(bundle.meta?.reviewCount) ? bundle.meta.reviewCount : 0,
    sourceKey: source.key,
    sourceLabel: source.label,
    cheapest: source.model.cheapest,
    mostExpensive: source.model.mostExpensive,
    savingsPct: source.model.savingsPct,
  };
}

/**
 * Hub membership stays platform-specific, while every appearance of the same
 * game uses the shared cross-store display source above.
 */
export function regionalListingCards(bundles, requiredChannel) {
  const nintendoPlatforms = new Set(['switch', 'switch-2']);
  return (bundles ?? [])
    .filter((bundle) => regionalPriceSources(bundle).some((source) => source.key === requiredChannel))
    .map((bundle) => ({
      card: regionalCardModel(bundle),
      switchExclusive: requiredChannel === 'eshop'
        && bundle?.game?.platforms?.length > 0
        && bundle.game.platforms.every((platform) => nintendoPlatforms.has(platform))
        && !bundle.game.steamAppId
        && !bundle.game.xboxBigId,
    }))
    .filter(({ card }) => card)
    .sort((a, b) => Number(b.switchExclusive) - Number(a.switchExclusive)
      || b.card.savingsPct - a.card.savingsPct
      || a.card.title.localeCompare(b.card.title))
    .map(({ card }) => card);
}

/** Popularity proxy for homepage platform rows: current Steam review volume. */
export function popularRegionalCards(bundles, channel, limit = 4, excludeSlugs = []) {
  const excluded = new Set(excludeSlugs);
  return (bundles ?? [])
    .filter((bundle) => !excluded.has(bundle.slug)
      && regionalPriceSources(bundle).some((source) => source.key === channel))
    .map((bundle) => regionalCardModel(bundle))
    .filter((card) => card?.headerImage)
    .sort((a, b) => b.reviewCount - a.reviewCount || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/**
 * Best current price across channels for the hero/table headline.
 * Returns { usd, channel } or null.
 */
export function bestPriceNow(bundle) {
  const candidates = [
    { usd: usRow(bundle.steam)?.usd, channel: 'steam' },
    { usd: usRow(bundle.eshop)?.usd, channel: 'eshop' },
    { usd: usRow(bundle.xbox)?.usd, channel: 'xbox' },
  ].filter((c) => c.usd != null);
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => a.usd - b.usd)[0];
}

/**
 * Flags every tied lowest price, except when every compared price is equal.
 * The half-cent tolerance absorbs harmless exchange/rounding noise.
 */
export function bestPriceFlags(prices, tolerance = 0.005) {
  if (prices.length < 2) return prices.map(() => false);
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);
  if (highest - lowest <= tolerance) return prices.map(() => false);
  return prices.map((price) => Math.abs(price - lowest) <= tolerance);
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
  return { verdict: 'WAIT', text: `The ${atlNote} is ${fmtUsd(atl.usd)} — ${Math.round((1 - atl.usd / best.usd) * 100)}% below today. Patience has paid before.` };
}

/** Region-gap leaderboard rows across all games: biggest cheapest-vs-US savings. */
export function regionGapBoard(bundles, limit = 5) {
  const rows = [];
  for (const b of bundles) {
    const source = primaryRegionalSource(b);
    if (!source) continue;
    const us = usRow(source.snapshot);
    const cheapest = source.snapshot.regions[0];
    if (!us || !cheapest || cheapest.cc === 'US' || !(us.usd > 0)) continue;
    const savePct = Math.round((1 - cheapest.usd / us.usd) * 100);
    if (savePct < 5) continue;
    rows.push({ slug: b.slug, title: b.game?.title ?? b.slug, cc: cheapest.cc, savePct, channel: source.key });
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
      { pct: usRow(b.xbox)?.discountPct, usd: usRow(b.xbox)?.usd, channel: 'xbox' },
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
    const snap = { steam: b.steam, eshop: b.eshop, xbox: b.xbox }[channel];
    const us = usRow(snap);
    if (!us || !(us.discountPct > 0)) continue;
    if (!isLive(us.saleEndsAt)) continue; // 快照滞后窗口：已过期的折扣不再当作当前
    rows.push({
      slug: b.slug,
      title: b.game?.title ?? b.slug,
      usd: us.usd,
      listUsd: us.listUsd,
      pct: us.discountPct,
      saleEndsAt: us.saleEndsAt ?? null,
      headerImage: b.meta?.headerImage ?? null,
      reviewPercent: b.meta?.reviewPercent ?? null,
      atl: atlFor(b.history, channel),
      isAtl: (() => { const a = atlFor(b.history, channel); return a ? us.usd <= a.usd + 0.001 : false; })(),
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
