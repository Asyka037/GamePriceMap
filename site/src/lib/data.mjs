/**
 * Build-time data access — reads the repo /data tree.
 * Pure reads only; derivations live in derive.mjs (unit-tested at repo root).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrichSnapshot } from '../../../scripts/lib/snapshot.mjs';
import { enrichSteamOffers } from '../../../scripts/lib/steam-offers.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data');

function readJson(rel, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, rel), 'utf8'));
  } catch {
    return fallback;
  }
}

export const catalog = () => readJson('catalog.json', { games: [] }).games;

// 快照在 git 中只存本币原始观测（data-v2.1）；USD/排名在此处用当日汇率派生，
// 下游（derive/pages/map）拿到的形状与旧 schema 完全一致。
let ratesCache = null;
let offerCatalogCache = null;
const currentRates = () => (ratesCache ??= readJson('rates/usd.json', { rates: {} }).rates ?? {});
const offerCatalog = () => (offerCatalogCache ??= readJson('offer-catalog.json', { offers: [] }).offers ?? []);
export const steamSnapshot = (slug) => enrichSnapshot(readJson(`snapshots/steam/${slug}.json`), currentRates());
export const eshopSnapshot = (slug) => enrichSnapshot(readJson(`snapshots/eshop/${slug}.json`), currentRates());
export const xboxSnapshot = (slug) => enrichSnapshot(readJson(`snapshots/xbox/${slug}.json`), currentRates());
export const steamOffers = (slug) => {
  const enriched = enrichSteamOffers(readJson(`offers/steam/${slug}.json`), currentRates());
  if (!enriched) return null;
  const approved = new Map(offerCatalog()
    .filter((offer) => offer.channel === 'steam' && offer.slug === slug)
    .map((offer) => [offer.packageId, offer]));
  return {
    ...enriched,
    offers: enriched.offers.map((offer) => {
      const display = approved.get(offer.packageId);
      if (!display) return offer; // validate rejects this in production.
      return {
        ...offer,
        name: display.name,
        kind: display.kind,
        includesBaseGame: display.includesBaseGame,
        note: display.note,
      };
    }),
  };
};
export const sourceHealth = () => readJson('source-health.json', { updatedAt: null, sources: {} });
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
    xbox: xboxSnapshot(slug),
    steamOffers: steamOffers(slug),
    history: history(slug),
    meta: meta(slug),
  };
}

/** Newest freshness stamp (footer) — snapshots carry no timestamps now. */
export function dataUpdatedAt() {
  const sh = sourceHealth();
  const stamps = [
    rates().updatedAt,
    feed('deals-steam').updatedAt,
    ...Object.values(sh.sources ?? {}).map((s) => s.lastSuccessAt),
  ].filter(Boolean);
  return stamps.sort().at(-1) ?? null;
}
