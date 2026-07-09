/**
 * Feed parsers (deals / free games) — pure functions, no I/O.
 *
 * Unified feed item:
 *   { title, storeId, url, currency, price, list, pct, endsAt,
 *     steamAppId?, slugIfTracked? }
 * `currency` is a deliberate addition over plan §T3.1 schema — Steam feed
 * is USD while the eShop-EU feed is GBP, and hiding that would misprice.
 * Free-games items additionally carry { status: 'free-now' | 'upcoming' }.
 */

const centsToUnit = (n) => (typeof n === 'number' ? Math.round(n) / 100 : null);
const unixToIso = (s) => (s > 0 ? new Date(s * 1000).toISOString() : null);

/** featuredcategories.specials → deals + 100%-off freebies. */
export function parseSteamSpecials(body, appIdToSlug = new Map()) {
  const deals = [];
  const free = [];
  for (const it of body?.specials?.items ?? []) {
    if (!it?.discounted || !(it.discount_percent > 0)) continue;
    const entry = {
      title: it.name,
      storeId: 'steam',
      url: `https://store.steampowered.com/app/${it.id}/`,
      currency: it.currency ?? 'USD',
      price: centsToUnit(it.final_price),
      list: centsToUnit(it.original_price),
      pct: it.discount_percent,
      endsAt: unixToIso(it.discount_expiration),
      steamAppId: it.id,
      slugIfTracked: appIdToSlug.get(it.id) ?? null,
    };
    if (entry.price === null || entry.list === null) continue;
    if (it.discount_percent >= 100) free.push({ ...entry, price: 0, status: 'free-now' });
    else deals.push(entry);
  }
  return { deals, free };
}

/**
 * Epic freeGamesPromotions → free-now + upcoming.
 * The response routinely carries top-level GraphQL `errors` while
 * data.Catalog.searchStore.elements stays complete — never treat `errors`
 * as fatal. Only 100%-off promotions count (discountPercentage === 0).
 */
export function parseEpicFree(body) {
  const out = [];
  for (const el of body?.data?.Catalog?.searchStore?.elements ?? []) {
    const promo = el.promotions;
    if (!promo) continue;
    const pageSlug = el.catalogNs?.mappings?.[0]?.pageSlug ?? el.productSlug ?? el.urlSlug;
    const base = {
      title: el.title,
      storeId: 'epic',
      url: pageSlug ? `https://store.epicgames.com/en-US/p/${pageSlug}` : 'https://store.epicgames.com/en-US/free-games',
      currency: 'USD',
      price: 0,
      list: centsToUnit(el.price?.totalPrice?.originalPrice),
      pct: 100,
      steamAppId: null,
      slugIfTracked: null,
    };
    const current = promo.promotionalOffers?.[0]?.promotionalOffers?.find((o) => o.discountSetting?.discountPercentage === 0);
    if (current) out.push({ ...base, status: 'free-now', endsAt: current.endDate ?? null });
    const upcoming = promo.upcomingPromotionalOffers?.[0]?.promotionalOffers?.find((o) => o.discountSetting?.discountPercentage === 0);
    if (upcoming && !current) out.push({ ...base, status: 'upcoming', endsAt: upcoming.endDate ?? null });
  }
  return out;
}

/** Nintendo-Europe Solr discounted docs (GBP) → deals. */
export function parseEuDiscounts(body, euNsuidToSlug = new Map()) {
  const out = [];
  for (const doc of body?.response?.docs ?? []) {
    const price = doc.price_discounted_f;
    const list = doc.price_regular_f;
    if (!(price > 0) || !(list > 0) || price >= list) continue;
    const nsuid = (doc.nsuid_txt ?? []).find((n) => String(n).startsWith('7001')) ?? null;
    out.push({
      title: doc.title,
      storeId: 'eshop-eu',
      url: doc.url ? `https://www.nintendo.co.uk${doc.url}` : 'https://www.nintendo.co.uk',
      currency: 'GBP',
      price,
      list,
      pct: Math.round(doc.price_discount_percentage_f ?? (1 - price / list) * 100),
      endsAt: null,
      steamAppId: null,
      slugIfTracked: nsuid ? (euNsuidToSlug.get(nsuid) ?? null) : null,
    });
  }
  return out;
}

/**
 * CheapShark deals → multi-store PC deals.
 * salePrice 0 entries are giveaways (they belong to the free feed via their
 * own stores) and are excluded here.
 */
export function parseCheapSharkDeals(body, storesById = new Map(), appIdToSlug = new Map()) {
  const out = [];
  for (const d of Array.isArray(body) ? body : []) {
    const price = Number.parseFloat(d.salePrice);
    const list = Number.parseFloat(d.normalPrice);
    const pct = Math.round(Number.parseFloat(d.savings));
    if (!(price > 0) || !(list > 0) || !(pct > 0 && pct <= 100)) continue;
    const appId = d.steamAppID ? Number.parseInt(d.steamAppID, 10) : null;
    out.push({
      title: d.title,
      storeId: storesById.get(String(d.storeID)) ?? `store-${d.storeID}`,
      url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
      currency: 'USD',
      price,
      list,
      pct,
      endsAt: null,
      steamAppId: appId,
      slugIfTracked: appId ? (appIdToSlug.get(appId) ?? null) : null,
    });
  }
  return out;
}

/** stores endpoint → Map('1' -> 'steam', '7' -> 'gog', ...). */
export function parseStores(body) {
  const map = new Map();
  for (const s of Array.isArray(body) ? body : []) {
    if (s.isActive) map.set(String(s.storeID), s.storeName.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  }
  return map;
}
