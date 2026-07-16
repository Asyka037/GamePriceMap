/**
 * CheapShark parsing — pure functions, no I/O.
 * API requires a descriptive User-Agent (generic UAs get HTTP 400);
 * all fetches go through scripts/lib/http.mjs which sets one.
 */

export const GAMES_BATCH_SIZE = 25;

export function lookupUrl(steamAppId) {
  return `https://www.cheapshark.com/api/1.0/games?steamAppID=${steamAppId}`;
}

export function batchUrl(gameIds) {
  return `https://www.cheapshark.com/api/1.0/games?ids=${gameIds.join(',')}`;
}

/**
 * Seed-status ledger helpers (ledger lives in data/seeds/cheapshark-status.json).
 *
 * Lookup state ("does CheapShark know this appid?") and seed-check state
 * ("when did we last read cheapestPriceEver?") are independent facts: a game
 * whose CheapShark price never beats our self-observed ATL must NOT be
 * re-queried forever, and a lookup miss must NOT be retried daily. Network
 * failures record nothing, so they retry on the next run.
 */
export const RECHECK_DAYS = 30;

export function plusDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
}

/** A lookup is due unless a recorded miss is still within its retry window. */
export function lookupIsDue(entry, today) {
  return !(entry?.lookupMissUntil && entry.lookupMissUntil > today);
}

/** A cheapestPriceEver check is due when never done or older than the window. */
export function seedCheckIsDue(entry, today, recheckDays = RECHECK_DAYS) {
  return !(entry?.seedCheckedAt && plusDays(entry.seedCheckedAt, recheckDays) > today);
}

/** games?steamAppID= returns an array; pick the exact appid match. */
export function parseGameLookup(body, steamAppId) {
  if (!Array.isArray(body)) return null;
  const hit = body.find((g) => String(g.steamAppID) === String(steamAppId));
  return hit ? String(hit.gameID) : null;
}

/**
 * games?ids= returns an object keyed by gameID.
 * cheapestPriceEver: { price: "29.95", date: <unix seconds> } → numeric/ISO.
 * A price of 0 means a past giveaway (e.g. Epic freebies), which is not a
 * purchasable price — treated as "no seed" so ATL stays meaningful.
 */
export function parseCheapestEver(body, gameId) {
  const entry = body?.[String(gameId)];
  const cpe = entry?.cheapestPriceEver;
  const price = Number.parseFloat(cpe?.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const date = cpe.date > 0 ? new Date(cpe.date * 1000).toISOString().slice(0, 10) : null;
  return { price, date };
}
