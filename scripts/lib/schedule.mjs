/**
 * Tier scheduling — pure functions shared by scrapers and the site build.
 *
 * `core` games are scraped in full every day. `extended` games are split into
 * EXTENDED_SHARDS deterministic shards (stable slug hash: a game never moves
 * between shards) and one shard runs per day. Shard selection is catch-up
 * based: the shard whose lastSuccessAt is oldest (or missing) runs first, so
 * one failed day delays that shard by one day, not by a full rotation.
 *
 * Freshness is stored per channel per shard (fewer than 20 keys), NOT per
 * game: shard membership is deterministic, so any game's "last confirmed"
 * moment is derivable via sourceKeyFor().
 */

export const EXTENDED_SHARDS = 7;
// Metadata refresh rotates over ALL games (not a tier): 1/14 per day, so
// every game's meta is at most two weeks old — reviews and art move slowly.
export const META_SHARDS = 14;

/** FNV-1a 32-bit — stable, dependency-free, well distributed for short keys. */
export function shardOf(slug, count = EXTENDED_SHARDS) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash ^= slug.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % count;
}

/** Health-ledger key for one game on one channel (site chart + scrapers). */
export function sourceKeyFor(channel, game) {
  const base = { steam: 'steam-regional', eshop: 'eshop-regional', xbox: 'xbox-us' }[channel];
  if (!base) return null;
  // Only Steam is tier-scheduled; eShop stays daily-full and Xbox weekly-full.
  if (channel === 'steam' && game?.tier === 'extended') {
    return `${base}:extended-${shardOf(game.slug)}`;
  }
  return base;
}

/** Filter a catalog game list down to one scheduling selection. */
export function gamesForRun(games, { tier = null, shard = null } = {}) {
  let picked = games;
  if (tier) picked = picked.filter((g) => (g.tier ?? 'core') === tier);
  if (tier === 'extended' && shard !== null) picked = picked.filter((g) => shardOf(g.slug) === shard);
  return picked;
}

/**
 * Catch-up selection: the extended shard whose lastSuccessAt is oldest.
 * Shards without any recorded success sort first (never-observed wins).
 * Deterministic tie-break by shard index.
 */
export function pickOverdueShard(sourceHealth, baseKey, count = EXTENDED_SHARDS, suffix = 'extended') {
  const stamps = [];
  for (let i = 0; i < count; i++) {
    const entry = sourceHealth?.sources?.[`${baseKey}:${suffix}-${i}`];
    stamps.push({ shard: i, at: entry?.lastSuccessAt ?? '' });
  }
  stamps.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.shard - b.shard));
  return stamps[0].shard;
}

/**
 * Health keys covered by one run selection: a full run verified every game,
 * so it may stamp the core key and every extended shard that had members.
 */
export function coveredHealthKeys(games, baseKey, { tier = null, shard = null } = {}) {
  if (tier === 'core') return [baseKey];
  if (tier === 'extended') return [`${baseKey}:extended-${shard}`];
  const keys = [baseKey];
  const shards = [...new Set(games.filter((g) => g.tier === 'extended').map((g) => shardOf(g.slug)))];
  for (const i of shards.sort((a, b) => a - b)) keys.push(`${baseKey}:extended-${i}`);
  return keys;
}

/**
 * Meta variant: shards partition ALL games. A full run stamps the base key
 * and every shard; a shard run stamps only its own key.
 */
export function coveredMetaKeys({ shard = null } = {}) {
  if (shard !== null) return [`meta:shard-${shard}`];
  return ['meta', ...Array.from({ length: META_SHARDS }, (_, i) => `meta:shard-${i}`)];
}
