/**
 * Pure parsers for the Microsoft Store US Xbox coming-soon feed.
 *
 * The category page is only a locator. A card becomes a calendar entry after
 * its Display Catalog product independently proves that it is one directly
 * playable, non-trial, non-bundle game with a current public US pre-order.
 * Bundle resolution is intentionally deferred: Microsoft also marks some
 * standard editions with pre-order bonuses as bundles, so guessing here would
 * either lose valid games or admit deluxe/starter packs.
 */
import { exactXboxTitle, publicPurchaseAvailability, validXboxBigId } from './xbox.mjs';

export const XBOX_CALENDAR_PAGE_SIZE = 50;
export const XBOX_CALENDAR_MAX_ITEMS = 150;

const STORE_ORIGIN = 'https://www.microsoft.com';
const COMING_SOON_PATH = '/en-us/store/coming-soon/games/xbox';
const IMAGE_ORIGIN = 'https://store-images.s-microsoft.com';
const CARD_MARKERS = Object.freeze({
  'data-bi-hn': 'Games coming soon',
  'data-bi-ct': 'Product Card',
  'data-bi-compnm': 'Product Cards: Games',
});

function decodeHtmlAttribute(value) {
  let valid = true;
  const decoded = String(value ?? '').replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|apos|gt|lt|quot));/giu,
    (entity, decimal, hexadecimal, named) => {
      if (named) {
        return {
          amp: '&', apos: "'", gt: '>', lt: '<', quot: '"',
        }[named.toLowerCase()];
      }
      const codePoint = Number.parseInt(decimal ?? hexadecimal, hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint)
        || codePoint <= 0
        || codePoint > 0x10ffff
        || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        valid = false;
        return entity;
      }
      return String.fromCodePoint(codePoint);
    },
  );
  return valid ? decoded : null;
}

function tagEnd(html, start) {
  let quote = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  return -1;
}

function openingTags(html) {
  const source = String(html ?? '');
  const tags = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      cursor = end < 0 ? source.length : end + 3;
      continue;
    }
    // Only the start of a tag is needed for its name. Slicing the whole
    // remaining document for every tag makes large Store pages quadratic.
    const nameMatch = source.slice(start + 1, start + 129).match(/^\s*\/?\s*([a-z][\w:-]*)/iu);
    if (!nameMatch) {
      cursor = start + 1;
      continue;
    }
    const end = tagEnd(source, start + 1);
    if (end < 0) break;
    const closing = /^\s*\//u.test(source.slice(start + 1));
    const name = nameMatch[1].toLowerCase();
    if (!closing) tags.push({ name, source: source.slice(start + 1, end) });
    cursor = end + 1;

    // Telemetry hydration includes markup-like strings. They are not cards.
    if (!closing && (name === 'script' || name === 'style')) {
      const closePattern = new RegExp(`<\\/\\s*${name}\\s*>`, 'igu');
      closePattern.lastIndex = cursor;
      const close = closePattern.exec(source);
      cursor = close ? close.index + close[0].length : source.length;
    }
  }
  return tags;
}

function parseAttributes(tag, expectedName) {
  const name = tag.match(/^\s*([a-z][\w:-]*)(?=\s|\/|$)/iu);
  if (!name || name[1].toLowerCase() !== expectedName) return null;
  const attributes = new Map();
  let cursor = name[0].length;
  while (cursor < tag.length) {
    while (/\s/u.test(tag[cursor] ?? '')) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === '/') break;
    const attribute = tag.slice(cursor).match(/^([^\s=/>]+)/u);
    if (!attribute) return null;
    const key = attribute[1].toLowerCase();
    cursor += attribute[0].length;
    while (/\s/u.test(tag[cursor] ?? '')) cursor += 1;
    if (attributes.has(key)) return null;
    if (tag[cursor] !== '=') {
      attributes.set(key, null);
      continue;
    }
    cursor += 1;
    while (/\s/u.test(tag[cursor] ?? '')) cursor += 1;
    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") return null;
    cursor += 1;
    const end = tag.indexOf(quote, cursor);
    if (end < 0) return null;
    const decoded = decodeHtmlAttribute(tag.slice(cursor, end));
    if (decoded == null) return null;
    attributes.set(key, decoded);
    cursor = end + 1;
  }
  return attributes;
}

function withoutRawText(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/giu, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/giu, '');
}

function validExpectedSkip(value) {
  return Number.isSafeInteger(value)
    && value >= 0
    && value < XBOX_CALENDAR_MAX_ITEMS
    && value % XBOX_CALENDAR_PAGE_SIZE === 0;
}

export function xboxComingSoonPageUrl(skip = 0) {
  if (!validExpectedSkip(skip)) throw new Error(`invalid Xbox calendar skip: ${skip}`);
  return `${STORE_ORIGIN}${COMING_SOON_PATH}${skip ? `?skipitems=${skip}` : ''}`;
}

export function xboxProductUrl(bigId) {
  if (!validXboxBigId(bigId)) throw new Error(`invalid Xbox BigID: ${bigId}`);
  return `${STORE_ORIGIN}/en-us/p/_/${bigId.toLowerCase()}`;
}

function assertFinalUrl(finalUrl, expectedSkip) {
  let url;
  try {
    url = new URL(finalUrl);
  } catch {
    throw new Error('Xbox calendar final URL is invalid');
  }
  if (url.origin !== STORE_ORIGIN
    || url.username
    || url.password
    || url.pathname !== COMING_SOON_PATH
    || url.hash
    || url.href !== xboxComingSoonPageUrl(expectedSkip)) {
    throw new Error('Xbox calendar response did not retain the exact US category URL');
  }
}

function parsePageRange(html) {
  const matches = [...withoutRawText(html).matchAll(
    /\bShowing\s+(\d+)\s*(?:-|–)\s*(\d+)\s+of\s+(\d+)\s+items\b/giu,
  )].map((match) => match.slice(1).map(Number));
  if (matches.length === 0) throw new Error('Xbox calendar page range is missing');
  const unique = new Set(matches.map((tuple) => tuple.join(':')));
  if (unique.size !== 1) throw new Error('Xbox calendar page contains contradictory ranges');
  const [[start, end, total]] = matches;
  if (![start, end, total].every(Number.isSafeInteger)
    || total < 1
    || total > XBOX_CALENDAR_MAX_ITEMS
    || start < 1
    || end < start
    || end > total) {
    throw new Error('Xbox calendar page range is outside the guarded bounds');
  }
  return { start, end, total };
}

function parseCardPosition(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseCards(html) {
  const cards = [];
  for (const tag of openingTags(html)) {
    if (tag.name !== 'div') continue;
    const mentionsTarget = /data-bi-hn\s*=\s*["']Games coming soon["']/iu.test(tag.source);
    const attributes = parseAttributes(tag.source, 'div');
    if (!attributes) {
      if (mentionsTarget) throw new Error('Xbox calendar contains a malformed marked card');
      continue;
    }
    if (attributes.get('data-bi-hn') !== CARD_MARKERS['data-bi-hn']) continue;
    for (const [key, expected] of Object.entries(CARD_MARKERS)) {
      if (attributes.get(key) !== expected) {
        throw new Error(`Xbox calendar marked card has invalid ${key}`);
      }
    }
    const rawId = attributes.get('data-bi-pid');
    const bigId = typeof rawId === 'string' ? rawId.toUpperCase() : null;
    const title = attributes.get('data-bi-prdname')?.trim();
    const position = parseCardPosition(attributes.get('data-bi-carpos'));
    if (!validXboxBigId(bigId) || !title || position == null) {
      throw new Error('Xbox calendar marked card has an invalid identity');
    }
    cards.push({
      bigId,
      title,
      position,
      url: xboxProductUrl(bigId),
    });
  }
  return cards;
}

/**
 * Parse one server-rendered Microsoft Store category page.
 * Structural drift throws so a caller can discard the whole Xbox source.
 */
export function parseXboxComingSoonPage(html, {
  finalUrl,
  expectedSkip = 0,
  expectedTotal = null,
} = {}) {
  if (!validExpectedSkip(expectedSkip)) throw new Error(`invalid Xbox calendar skip: ${expectedSkip}`);
  assertFinalUrl(finalUrl, expectedSkip);
  const range = parsePageRange(html);
  if (expectedTotal != null && range.total !== expectedTotal) {
    throw new Error(`Xbox calendar total changed from ${expectedTotal} to ${range.total}`);
  }
  const expectedStart = expectedSkip + 1;
  const expectedEnd = Math.min(expectedSkip + XBOX_CALENDAR_PAGE_SIZE, range.total);
  if (expectedStart > range.total || range.start !== expectedStart || range.end !== expectedEnd) {
    throw new Error('Xbox calendar range does not match the requested page');
  }

  const cards = parseCards(html).sort((left, right) => left.position - right.position);
  const expectedCount = range.end - range.start + 1;
  if (cards.length !== expectedCount) {
    throw new Error(`Xbox calendar expected ${expectedCount} cards, found ${cards.length}`);
  }
  const ids = new Set();
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (card.position !== index) throw new Error('Xbox calendar card positions are not contiguous');
    if (ids.has(card.bigId)) throw new Error(`Xbox calendar repeats BigID ${card.bigId}`);
    ids.add(card.bigId);
    card.index = expectedSkip + index;
  }

  const pageCount = Math.ceil(range.total / XBOX_CALENDAR_PAGE_SIZE);
  const pageNumber = expectedSkip / XBOX_CALENDAR_PAGE_SIZE + 1;
  return {
    ...range,
    pageNumber,
    pageCount,
    nextSkip: pageNumber < pageCount ? expectedSkip + XBOX_CALENDAR_PAGE_SIZE : null,
    cards,
  };
}

function reject(reason) {
  return { entry: null, reason };
}

function marketRow(rows, market = 'US') {
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter((row) => Array.isArray(row?.Markets) && row.Markets.includes(market));
  return matches.length === 1 ? matches[0] : null;
}

function localizedRow(rows, market = 'US') {
  if (!Array.isArray(rows)) return null;
  const marketRows = rows.filter((row) => Array.isArray(row?.Markets) && row.Markets.includes(market));
  // `languages=en-US` currently returns `Language: "en"` for many products,
  // while some records retain `en-us`. Prefer the more specific row and
  // reject ambiguity within either official representation.
  for (const language of ['en-us', 'en']) {
    const matches = marketRows.filter((row) => String(row?.Language ?? '').toLowerCase() === language);
    if (matches.length > 1) return null;
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function calendarDate(value) {
  const milliseconds = Date.parse(value ?? '');
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  const year = date.getUTCFullYear();
  return year >= 2000 && year < 2100 ? date.toISOString().slice(0, 10) : null;
}

function hasXboxPackage(sku) {
  return (sku?.Properties?.Packages ?? []).some((pkg) => (pkg?.PlatformDependencies ?? [])
    .some((dependency) => dependency?.PlatformName === 'Windows.Xbox'));
}

function isCurrentPublicUsPurchase(availability, now) {
  if (!publicPurchaseAvailability(availability, now)) return false;
  if (!Array.isArray(availability?.Markets) || !availability.Markets.includes('US')) return false;
  const start = Date.parse(availability?.Conditions?.StartDate ?? '');
  const end = Date.parse(availability?.Conditions?.EndDate ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now) return false;
  const price = availability?.OrderManagementData?.Price;
  return price?.CurrencyCode === 'USD' && Number.isFinite(Number(price?.ListPrice)) && Number(price.ListPrice) >= 0;
}

function normalizedImageUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (url.origin !== IMAGE_ORIGIN
      || url.username
      || url.password
      || url.hash
      || !url.pathname.startsWith('/image/')) return null;
    return url.href;
  } catch {
    return null;
  }
}

function heroImage(localized) {
  for (const purpose of ['TitledHeroArt', 'SuperHeroArt']) {
    for (const image of localized?.Images ?? []) {
      const width = Number(image?.Width);
      const height = Number(image?.Height);
      const ratio = width / height;
      if (image?.ImagePurpose !== purpose
        || !(width > 0)
        || !(height > 0)
        || ratio < 1.5
        || ratio > 2) continue;
      const url = normalizedImageUrl(image.Uri);
      if (url) return url;
    }
  }
  return null;
}

// The Microsoft category and Display Catalog can both classify add-on-shaped
// products as ProductKind=Game with a full, non-bundle SKU. Explicit title
// markers therefore remain a final conservative base-game guard.
const NON_BASE_GAME_TITLE = /(?:\(\s*(?:DLC|add[ -]?on|expansion|upgrade)\s*\)|\b(?:DLC|add[ -]?on|expansion pass|season pass|upgrade pack)\s*$)/iu;

export function isXboxBaseGameCalendarTitle(value) {
  return typeof value === 'string' && value.trim().length > 0 && !NON_BASE_GAME_TITLE.test(value);
}

/**
 * Turn one Display Catalog product into the existing per-platform calendar
 * entry shape. Rejections are explicit and never silently downgrade bundles.
 */
export function parseXboxCalendarProduct(product, {
  card,
  now = Date.now(),
  slugIfTracked = null,
} = {}) {
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('Xbox calendar now is invalid');
  if (!card || !validXboxBigId(card.bigId) || typeof card.title !== 'string' || !card.title.trim()) {
    throw new Error('Xbox calendar card identity is invalid');
  }
  if (!product || Array.isArray(product) || typeof product !== 'object') return reject('product_missing_or_invalid');
  if (String(product.ProductId ?? '').toUpperCase() !== card.bigId) return reject('product_id_mismatch');
  if (product.ProductKind !== 'Game') return reject('not_game');

  const localized = localizedRow(product.LocalizedProperties);
  if (!localized || typeof localized.ProductTitle !== 'string' || !localized.ProductTitle.trim()) {
    return reject('us_localized_product_missing');
  }
  const title = localized.ProductTitle.trim();
  if (!exactXboxTitle(title, card.title)) return reject('listed_title_mismatch');
  if (!isXboxBaseGameCalendarTitle(title)) return reject('non_base_game_title');

  const productMarket = marketRow(product.MarketProperties);
  const date = calendarDate(productMarket?.OriginalReleaseDate);
  if (!date) return reject('us_release_date_missing_or_invalid');

  const preorderSkus = (product.DisplaySkuAvailabilities ?? []).filter((display) => {
    const sku = display?.Sku;
    return sku?.SkuType === 'full'
      && sku?.Properties?.IsTrial === false
      && sku?.Properties?.IsPreOrder === true;
  });
  if (preorderSkus.length === 0) return reject('no_full_preorder_sku');
  const directSkus = preorderSkus.filter((display) => display.Sku.Properties.IsBundle === false);
  if (directSkus.length === 0 && preorderSkus.some((display) => display.Sku.Properties.IsBundle === true)) {
    return reject('bundle_requires_manual_resolution');
  }
  if (directSkus.length !== 1) return reject('ambiguous_direct_preorder_sku');

  const display = directSkus[0];
  const sku = display.Sku;
  const skuLocalized = localizedRow(sku.LocalizedProperties);
  if (!skuLocalized || !exactXboxTitle(skuLocalized.SkuTitle, title)) return reject('sku_title_mismatch');
  if (!hasXboxPackage(sku)) return reject('xbox_package_missing');
  const skuMarket = marketRow(sku.MarketProperties);
  if (calendarDate(skuMarket?.FirstAvailableDate) !== date) return reject('sku_release_date_mismatch');
  if (!(display.Availabilities ?? []).some((availability) => isCurrentPublicUsPurchase(availability, nowMs))) {
    return reject('no_current_public_us_purchase');
  }

  const image = heroImage(localized);
  if (!image) return reject('hero_image_missing_or_invalid');
  const url = xboxProductUrl(card.bigId);
  return {
    reason: null,
    entry: {
      title,
      date,
      month: date.slice(0, 7),
      platform: 'xbox',
      url,
      image,
      slugIfTracked: typeof slugIfTracked === 'string' && slugIfTracked ? slugIfTracked : null,
      xboxBigId: card.bigId,
    },
  };
}
