/**
 * PlayStation Store US pre-order calendar parsers (pure; callers own I/O).
 *
 * Discovery uses the public pre-order category's server-rendered Apollo cache.
 * Every accepted candidate is then rebound to its exact official product page;
 * release date, title, product type and platforms must agree across independent
 * batarang fragments before an entry can be published.
 */
import { normTitle } from './match.mjs';
import { extractPsnNextData, psnProductUrl, validPsnProductId } from './psn.mjs';

export const PSN_PREORDER_CATEGORY_ID = 'c81024c8-2833-4c88-9bcc-39bef3d5bef1';
export const PSN_CATEGORY_PAGE_SIZE = 24;
export const PSN_CATEGORY_MAX_PAGES = 8;

const STORE_ORIGIN = 'https://store.playstation.com';
const ALLOWED_PLATFORMS = new Set(['PS4', 'PS5']);
const UNSAFE_EDITION = /\b(deluxe|ultimate|premium|gold|collector(?:'s)?|starter\s*pack|upgrade|bundle|collection|anthology|add[ -]?on|dlc|soundtrack|art\s*book|demo|trial)\b/iu;
const STANDARD_SUFFIX = /\s*(?:[-–—:]\s*)?(?:standard\s+edition|base\s+game)\s*$/iu;
const IMAGE_PRIORITY = ['SIXTEEN_BY_NINE_BANNER', 'BACKGROUND', 'FOUR_BY_THREE_BANNER', 'MASTER'];

export function psnPreorderCategoryUrl(page) {
  if (!(Number.isSafeInteger(page) && page >= 1 && page <= PSN_CATEGORY_MAX_PAGES)) {
    throw new TypeError(`PSN category page must be 1-${PSN_CATEGORY_MAX_PAGES}`);
  }
  return `${STORE_ORIGIN}/en-us/category/${PSN_PREORDER_CATEGORY_ID}/${page}`;
}

export function canonicalPsnCalendarTitle(value) {
  const title = String(value ?? '').trim().replace(STANDARD_SUFFIX, '').trim();
  if (!title || UNSAFE_EDITION.test(title)) return null;
  return title;
}

function officialImage(media) {
  const rows = (media ?? []).filter((item) => {
    if (item?.type !== 'IMAGE' || !IMAGE_PRIORITY.includes(item?.role)) return false;
    try {
      return new URL(item.url).host === 'image.api.playstation.com';
    } catch {
      return false;
    }
  });
  rows.sort((a, b) => IMAGE_PRIORITY.indexOf(a.role) - IMAGE_PRIORITY.indexOf(b.role));
  return rows[0]?.url ?? null;
}

function exactCategoryFinalUrl(finalUrl, page) {
  if (!finalUrl) return true; // pure-fixture callers may omit transport data
  try {
    const url = new URL(finalUrl);
    return url.origin === STORE_ORIGIN
      && !url.search && !url.hash
      && url.pathname.replace(/\/$/u, '') === `/en-us/category/${PSN_PREORDER_CATEGORY_ID}/${page}`;
  } catch {
    return false;
  }
}

export function parsePsnPreorderCategoryPage(html, { page, finalUrl = null } = {}) {
  if (!(Number.isSafeInteger(page) && page >= 1 && page <= PSN_CATEGORY_MAX_PAGES)) return null;
  if (!exactCategoryFinalUrl(finalUrl, page)) return null;
  const nextData = extractPsnNextData(html);
  const pageProps = nextData?.props?.pageProps;
  const state = nextData?.props?.apolloState;
  if (pageProps?.locale !== 'en-us'
    || pageProps?.categoryId !== PSN_PREORDER_CATEGORY_ID
    || pageProps?.page !== page
    || pageProps?.statusCode !== 200
    || !state || typeof state !== 'object') return null;

  const offset = (page - 1) * PSN_CATEGORY_PAGE_SIZE;
  const gridKey = `CategoryGrid:${PSN_PREORDER_CATEGORY_ID}:en-us:${offset}:${PSN_CATEGORY_PAGE_SIZE}`;
  const grid = state[gridKey];
  const info = grid?.pageInfo;
  if (grid?.id !== PSN_PREORDER_CATEGORY_ID
    || grid?.sortedBy?.name !== 'productReleaseDate'
    || grid?.sortedBy?.isAscending !== false
    || info?.offset !== offset
    || info?.size !== PSN_CATEGORY_PAGE_SIZE
    || !(Number.isSafeInteger(info?.totalCount) && info.totalCount > 0)
    || info.totalCount > PSN_CATEGORY_PAGE_SIZE * PSN_CATEGORY_MAX_PAGES) return null;
  const pageCount = Math.ceil(info.totalCount / PSN_CATEGORY_PAGE_SIZE);
  if (page > pageCount || info.isLast !== (page === pageCount)) return null;
  const expectedRows = Math.min(PSN_CATEGORY_PAGE_SIZE, info.totalCount - offset);
  if (!Array.isArray(grid.products) || grid.products.length !== expectedRows) return null;

  const rawProductIds = [];
  const candidates = [];
  for (const ref of grid.products) {
    const key = ref?.__ref;
    const match = String(key ?? '').match(/^Product:([^:]+):en-us$/u);
    if (!match) return null;
    const productId = match[1].toUpperCase();
    const product = state[key];
    if (!validPsnProductId(productId)
      || product?.id !== productId
      || product?.telemetryData?.interactLink !== `PRODUCT:${productId}`) return null;
    rawProductIds.push(productId);
    if (product.storeDisplayClassification !== 'FULL_GAME'
      || !(product.skus ?? []).some((sku) => sku?.type === 'PREORDER')) continue;
    const platforms = [...new Set(product.platforms ?? [])].sort();
    if (platforms.length === 0 || platforms.some((platform) => !ALLOWED_PLATFORMS.has(platform))) continue;
    const title = canonicalPsnCalendarTitle(product.name);
    if (!title) continue;
    candidates.push({
      productId,
      rawTitle: product.name,
      title,
      platforms: platforms.map((platform) => platform.toLowerCase()),
      image: officialImage(product.media),
      sourceUrl: psnProductUrl(productId),
    });
  }
  return {
    page,
    pageCount,
    totalCount: info.totalCount,
    rawCount: rawProductIds.length,
    rawProductIds,
    candidates,
  };
}

/**
 * Bind every parsed category page into one complete official snapshot before
 * callers request any product pages. Counting both rows and unique raw product
 * IDs makes overlapping pages and missing rows fail closed instead of being
 * hidden by candidate de-duplication.
 */
export function assertCompletePsnPreorderCategoryPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('PSN preorder category pagination is empty');
  }
  const totalCount = pages[0]?.totalCount;
  const pageCount = pages[0]?.pageCount;
  if (!(Number.isSafeInteger(totalCount) && totalCount > 0)
    || !(Number.isSafeInteger(pageCount) && pageCount > 0 && pageCount <= PSN_CATEGORY_MAX_PAGES)
    || pageCount !== Math.ceil(totalCount / PSN_CATEGORY_PAGE_SIZE)
    || pages.length !== pageCount) {
    throw new Error('PSN preorder category pagination metadata is incomplete');
  }

  const rawProductIds = [];
  const candidates = [];
  for (const [index, page] of pages.entries()) {
    const expectedRows = Math.min(
      PSN_CATEGORY_PAGE_SIZE,
      totalCount - index * PSN_CATEGORY_PAGE_SIZE,
    );
    if (page?.page !== index + 1
      || page.pageCount !== pageCount
      || page.totalCount !== totalCount
      || !Array.isArray(page.rawProductIds)
      || page.rawProductIds.length !== expectedRows
      || page.rawCount !== page.rawProductIds.length
      || !Array.isArray(page.candidates)) {
      throw new Error(`PSN preorder category page ${index + 1} is incomplete`);
    }
    for (const productId of page.rawProductIds) {
      if (!validPsnProductId(productId)) {
        throw new Error(`PSN preorder category page ${index + 1} contains a malformed raw product id`);
      }
      rawProductIds.push(productId);
    }
    candidates.push(...page.candidates);
  }

  if (rawProductIds.length !== totalCount) {
    throw new Error(`PSN preorder category raw product count is incomplete: ${rawProductIds.length}/${totalCount}`);
  }
  const rawProductIdSet = new Set(rawProductIds);
  if (rawProductIdSet.size !== totalCount) {
    throw new Error(`PSN preorder category raw product ids are duplicated: ${rawProductIdSet.size}/${totalCount} unique`);
  }

  const candidateIds = new Set();
  for (const candidate of candidates) {
    if (!validPsnProductId(candidate?.productId)
      || !rawProductIdSet.has(candidate.productId)) {
      throw new Error('PSN preorder category candidate is not backed by a raw product id');
    }
    if (candidateIds.has(candidate.productId)) {
      throw new Error(`PSN preorder category candidate is duplicated: ${candidate.productId}`);
    }
    candidateIds.add(candidate.productId);
  }

  return { totalCount, rawProductIds, candidates };
}

function jsonScript(text) {
  const match = String(text ?? '').match(/<script\b(?=[^>]*\bid=["']env:[^"']+["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/iu);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

function productViews(nextData, productId) {
  const rows = [];
  for (const batarang of Object.values(nextData?.props?.pageProps?.batarangs ?? {})) {
    const document = jsonScript(batarang?.text);
    const product = document?.cache?.[`Product:${productId}`];
    if (product?.__typename === 'Product' && product.id === productId) rows.push(product);
  }
  return rows;
}

function normalizedPlatforms(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const platforms = [...new Set(value)].sort();
  return platforms.every((platform) => ALLOWED_PLATFORMS.has(platform)) ? platforms : null;
}

function exactProductFinalUrl(finalUrl, productId) {
  try {
    const url = new URL(finalUrl);
    return url.origin === STORE_ORIGIN && !url.search && !url.hash
      && decodeURIComponent(url.pathname).replace(/\/$/u, '') === `/en-us/product/${productId}`;
  } catch {
    return false;
  }
}

function visibleReleaseDay(html) {
  const match = String(html ?? '').match(/data-qa=["']gameInfo#releaseInformation#releaseDate-value["'][^>]*>([^<]+)</iu);
  if (!match) return null;
  const label = match[1].trim();
  const numeric = label.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u);
  if (numeric) return `${numeric[3]}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;
  // Anchor textual US dates at UTC noon; parsing a date-only label at local
  // midnight would move it to the previous UTC day in positive-offset CI.
  const parsed = Date.parse(`${label} 12:00:00 UTC`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : 'invalid';
}

export function parsePsnCalendarProductPage(html, candidate, { finalUrl } = {}) {
  const productId = String(candidate?.productId ?? '').toUpperCase();
  if (!validPsnProductId(productId) || !exactProductFinalUrl(finalUrl, productId)) return null;
  const nextData = extractPsnNextData(html);
  const pageProps = nextData?.props?.pageProps;
  if (pageProps?.locale !== 'en-us' || pageProps?.productId !== productId) return null;
  const views = productViews(nextData, productId);
  if (views.length === 0) return null;

  const classification = views.filter((view) => view.topCategory != null
    || view.storeDisplayClassification != null);
  const info = views.filter((view) => view.type != null);
  if (!classification.some((view) => view.topCategory === 'GAME'
      && view.storeDisplayClassification === 'FULL_GAME'
      && view.releaseDate != null
      && normalizedPlatforms(view.platforms))
    || !info.some((view) => view.type === 'GAME'
      && view.releaseDate != null
      && normalizedPlatforms(view.platforms))) return null;
  if (views.some((view) => (view.topCategory != null && view.topCategory !== 'GAME')
      || (view.storeDisplayClassification != null && view.storeDisplayClassification !== 'FULL_GAME')
      || (view.type != null && view.type !== 'GAME'))) return null;

  const expectedTitle = canonicalPsnCalendarTitle(candidate.rawTitle ?? candidate.title);
  const titles = views.flatMap((view) => [view.name, view.invariantName]).filter(Boolean);
  if (!expectedTitle || titles.length === 0 || titles.some((title) => normTitle(canonicalPsnCalendarTitle(title)) !== normTitle(expectedTitle))) return null;

  const dates = views.map((view) => view.releaseDate).filter(Boolean).map((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).getUTCFullYear() < 2100
      ? new Date(time).toISOString().slice(0, 10)
      : null;
  });
  if (dates.length < 2 || dates.some((date) => !date) || new Set(dates).size !== 1) return null;
  const date = dates[0];
  const platformSets = views.map((view) => normalizedPlatforms(view.platforms)).filter(Boolean);
  const expectedPlatforms = (candidate.platforms ?? []).map((platform) => platform.toUpperCase()).sort();
  if (platformSets.length < 2
    || platformSets.some((platforms) => JSON.stringify(platforms) !== JSON.stringify(expectedPlatforms))) return null;
  const visibleDay = visibleReleaseDay(html);
  if (visibleDay && visibleDay !== date) return null;

  const image = officialImage(views.flatMap((view) => view.media ?? [])) ?? candidate.image ?? null;
  if (!image) return null;
  return {
    title: expectedTitle,
    date,
    month: date.slice(0, 7),
    platform: 'psn',
    url: psnProductUrl(productId),
    image,
    productId,
  };
}

export function releaseWithinWindow(date, { now = Date.now(), horizonDays = 180 } = {}) {
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day) || !(Number.isSafeInteger(horizonDays) && horizonDays > 0)) return false;
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return day >= today && day <= today + horizonDays * 86_400_000;
}

/**
 * A normalized title/date pair must resolve to one PlayStation product. The
 * public category occasionally exposes parallel editions under nearly equal
 * names; refusing the whole cache is safer than silently choosing a URL.
 */
export function assertUniquePsnCalendarEntries(entries) {
  const seen = new Map();
  for (const entry of entries ?? []) {
    const title = normTitle(entry?.title);
    const date = entry?.date;
    const url = entry?.url;
    if (!title || typeof date !== 'string' || typeof url !== 'string') {
      throw new Error('PSN calendar entry is incomplete');
    }
    const key = `${title}\u0000${date}`;
    const previous = seen.get(key);
    if (previous) {
      throw new Error(`PSN calendar identity is ambiguous for ${entry.title} on ${date}: ${previous} vs ${url}`);
    }
    seen.set(key, url);
  }
}
