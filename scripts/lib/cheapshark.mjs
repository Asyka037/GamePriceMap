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
