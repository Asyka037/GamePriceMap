/**
 * Pixel world map grid — pure data + tier logic, no I/O.
 * 24×12 tile grid, countries placed at rough geographic positions
 * (plan §8: coordinate-table approach, Natural-Earth choropleth is the
 * documented V2 upgrade; component API stays stable).
 */

/** Union of tracked Steam (18) + eShop (16) regions. */
export const COUNTRY_TILES = {
  CA: { col: 2, row: 2, w: 3, h: 1, name: 'Canada' },
  US: { col: 2, row: 3, w: 3, h: 2, name: 'United States' },
  MX: { col: 2, row: 5, w: 2, h: 1, name: 'Mexico' },
  CO: { col: 4, row: 6, w: 1, h: 1, name: 'Colombia' },
  BR: { col: 4, row: 7, w: 2, h: 2, name: 'Brazil' },
  AR: { col: 4, row: 9, w: 1, h: 2, name: 'Argentina' },
  GB: { col: 9, row: 3, w: 1, h: 1, name: 'United Kingdom' },
  NO: { col: 11, row: 2, w: 1, h: 1, name: 'Norway' },
  DK: { col: 11, row: 3, w: 1, h: 1, name: 'Denmark' },
  DE: { col: 10, row: 4, w: 2, h: 1, name: 'Germany' },
  PL: { col: 12, row: 4, w: 1, h: 1, name: 'Poland' },
  CH: { col: 10, row: 5, w: 1, h: 1, name: 'Switzerland' },
  UA: { col: 13, row: 4, w: 1, h: 1, name: 'Ukraine' },
  TR: { col: 13, row: 5, w: 1, h: 1, name: 'Türkiye' },
  GE: { col: 14, row: 5, w: 1, h: 1, name: 'Georgia' },
  ZA: { col: 11, row: 9, w: 1, h: 1, name: 'South Africa' },
  KZ: { col: 15, row: 4, w: 2, h: 1, name: 'Kazakhstan' },
  PK: { col: 15, row: 5, w: 1, h: 1, name: 'Pakistan' },
  IN: { col: 16, row: 5, w: 1, h: 2, name: 'India' },
  CN: { col: 17, row: 4, w: 2, h: 2, name: 'China' },
  KR: { col: 19, row: 4, w: 1, h: 1, name: 'South Korea' },
  JP: { col: 20, row: 4, w: 1, h: 2, name: 'Japan' },
  AU: { col: 20, row: 8, w: 2, h: 2, name: 'Australia' },
  NZ: { col: 23, row: 10, w: 1, h: 1, name: 'New Zealand' },
};

/** Neutral landmass silhouette behind the tracked tiles. */
export const CONTINENT_BLOBS = [
  { col: 1, row: 1, w: 5, h: 5 },   // North America
  { col: 3, row: 6, w: 3, h: 5 },   // South America
  { col: 9, row: 2, w: 6, h: 4 },   // Europe
  { col: 9, row: 5, w: 5, h: 5 },   // Africa
  { col: 14, row: 2, w: 8, h: 5 },  // Asia
  { col: 19, row: 7, w: 5, h: 4 },  // Oceania
];

export const GRID = { cols: 24, rows: 12 };

/**
 * Price tier vs US baseline → candy token class (design.md palette only).
 * pctVsUs: negative = cheaper than US.
 */
export function tierFor(pctVsUs) {
  if (pctVsUs == null) return { cls: 'tile-none', label: 'no data' };
  if (pctVsUs <= -30) return { cls: 'tile-cheapest', label: '30%+ cheaper' };
  if (pctVsUs <= -10) return { cls: 'tile-cheaper', label: '10–30% cheaper' };
  if (pctVsUs < 10) return { cls: 'tile-par', label: 'around US price' };
  if (pctVsUs < 30) return { cls: 'tile-pricier', label: '10–30% pricier' };
  return { cls: 'tile-priciest', label: '30%+ pricier' };
}

/** Rows enriched for the map: adds tile geometry + tier; unknown ccs dropped. */
export function mapRegions(regions, usUsd) {
  return (regions ?? [])
    .map((r) => {
      const tile = COUNTRY_TILES[r.cc];
      if (!tile) return null;
      const pctVsUs = usUsd > 0 ? Math.round((r.usd / usUsd - 1) * 100) : null;
      return { cc: r.cc, name: tile.name, usd: r.usd, local: r.amount, currency: r.currency, pctVsUs, tile, tier: tierFor(pctVsUs) };
    })
    .filter(Boolean);
}
