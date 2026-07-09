/**
 * Build-time data access — reads the repo /data tree.
 * Pure reads only; derivations live in derive.mjs (unit-tested at repo root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');

function readJson(rel, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

export const catalog = () => readJson('catalog.json', { games: [] }).games;
export const steamSnapshot = (slug) => readJson(`snapshots/steam/${slug}.json`);
export const eshopSnapshot = (slug) => readJson(`snapshots/eshop/${slug}.json`);
export const history = (slug) => readJson(`history/${slug}.json`);
export const meta = (slug) => readJson(`meta/${slug}.json`);
export const feed = (name) => readJson(`feeds/${name}.json`, { updatedAt: null, items: [] });
export const calendar = () => readJson('feeds/calendar.json', { updatedAt: null, months: {} });
export const rates = () => readJson('rates/usd.json', { updatedAt: null, rates: {} });

/** Everything the derive layer needs for one game, loaded once. */
export function gameBundle(slug) {
  return {
    slug,
    game: catalog().find((g) => g.slug === slug) ?? null,
    steam: steamSnapshot(slug),
    eshop: eshopSnapshot(slug),
    history: history(slug),
    meta: meta(slug),
  };
}

/** Newest updatedAt across the data tree (footer freshness stamp). */
export function dataUpdatedAt() {
  const stamps = [
    rates().updatedAt,
    feed('deals-steam').updatedAt,
    ...catalog().slice(0, 5).map((g) => steamSnapshot(g.slug)?.updatedAt),
  ].filter(Boolean);
  return stamps.sort().at(-1) ?? null;
}
