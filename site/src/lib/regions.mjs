/**
 * Shared regional-price facts used by SEO, tables and the world map.
 * Pure functions only: persisted snapshots remain raw local observations.
 */

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
const NAME_OVERRIDES = { TR: 'Turkey' };

export function countryName(cc) {
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc)) return cc ?? '';
  return NAME_OVERRIDES[cc] ?? regionNames.of(cc) ?? cc;
}

/** ISO alpha-2 → Unicode regional-indicator flag; empty for invalid codes. */
export function countryFlag(cc) {
  if (typeof cc !== 'string' || !/^[A-Z]{2}$/.test(cc)) return '';
  return [...cc].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join('');
}

/** Percentage relative to an explicit baseline; negative means cheaper. */
export function regionDeltaPct(row, baseline) {
  if (!(row?.usd > 0) || !(baseline?.usd > 0)) return null;
  if (row.cc === baseline.cc) return 0;
  return Math.round((row.usd / baseline.usd - 1) * 100);
}

export function formatRegionDelta(deltaPct) {
  if (!Number.isFinite(deltaPct)) return '—';
  if (deltaPct === 0) return '0%';
  return `${deltaPct < 0 ? '−' : '+'}${Math.abs(deltaPct)}%`;
}

function directionForRow(row, baseline, deltaPct) {
  if (!baseline || deltaPct == null) return 'unknown';
  if (row.cc === baseline.cc) return 'baseline';
  if (deltaPct < 0) return 'cheaper';
  if (deltaPct > 0) return 'pricier';
  return 'par';
}

/**
 * Model a regional snapshot against US without silently inventing a fallback
 * baseline. The map may still choose a visual fallback when US is absent.
 */
export function regionalPriceModel(snapshot, baselineCc = 'US') {
  const validRows = (snapshot?.regions ?? []).filter((row) => row?.cc && row?.usd > 0);
  const baseline = validRows.find((row) => row.cc === baselineCc) ?? null;
  const rows = validRows.map((row) => {
    const deltaPct = regionDeltaPct(row, baseline);
    return {
      ...row,
      countryName: countryName(row.cc),
      flag: countryFlag(row.cc),
      deltaPct,
      deltaLabel: formatRegionDelta(deltaPct),
      direction: directionForRow(row, baseline, deltaPct),
    };
  });
  const ranked = [...rows].sort((a, b) => a.usd - b.usd || a.cc.localeCompare(b.cc));
  const cheapest = ranked[0] ?? null;
  const mostExpensive = ranked.at(-1) ?? null;
  const hasRange = Boolean(cheapest && mostExpensive && mostExpensive.usd > cheapest.usd);
  return {
    baseline,
    rows,
    cheapest,
    mostExpensive,
    priceSpreadPct: hasRange ? Math.round((mostExpensive.usd / cheapest.usd - 1) * 100) : 0,
    savingsPct: hasRange ? Math.round((1 - cheapest.usd / mostExpensive.usd) * 100) : 0,
  };
}

/**
 * Join reviewed supplemental products onto the base game's ranked region rows.
 * The base snapshot remains the only source of row order, rank and vs-US
 * semantics; supplemental products contribute price cells only.
 */
export function regionalComparisonModel(snapshot, offers = []) {
  const baseModel = regionalPriceModel(snapshot);
  const offerColumns = (offers ?? []).flatMap((offer) => {
    const regions = (offer?.regions ?? []).filter((row) => row?.cc && row?.usd > 0);
    if (regions.length === 0) return [];

    // Supplemental products are independent price sets. In particular, their
    // colour must be derived from that product's own US observation rather
    // than from the base game's US price.
    const model = regionalPriceModel({ regions });
    return [{ ...offer, regions: model.rows, baseline: model.baseline }];
  });
  const pricesByRegion = offerColumns.map((offer) => new Map(
    offer.regions.map((row) => [row.cc, row]),
  ));

  return {
    ...baseModel,
    offerColumns,
    rows: baseModel.rows.map((row) => ({
      ...row,
      offerPrices: pricesByRegion.map((prices) => prices.get(row.cc) ?? null),
    })),
  };
}
