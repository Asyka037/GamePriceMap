/**
 * Pure parser for PlayStation Store US search result tiles.
 *
 * Discovery is deliberately split from HTTP. The caller must supply the
 * terminal response URL so a redirected locale/home page cannot donate a
 * plausible product tile. Any marked tile with malformed or contradictory
 * identity metadata invalidates the whole page.
 */
import { normTitle } from './match.mjs';
import { exactPsnTitle, psnProductUrl, validPsnProductId } from './psn.mjs';

const STORE_ORIGIN = 'https://store.playstation.com';
const SEARCH_PREFIX = '/en-us/search/';
const TILE_MARKER = 'web:store:product-tile';

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

function anchorTags(html) {
  const source = String(html ?? '');
  const anchors = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      if (end < 0) break;
      cursor = end + 3;
      continue;
    }
    const nameMatch = source.slice(start + 1).match(/^\s*\/?\s*([a-z][\w:-]*)/iu);
    if (!nameMatch) {
      cursor = start + 1;
      continue;
    }
    const end = tagEnd(source, start + 1);
    if (end < 0) break;
    const closing = /^\s*\//u.test(source.slice(start + 1));
    const name = nameMatch[1].toLowerCase();
    if (!closing && name === 'a') anchors.push(source.slice(start + 1, end));
    cursor = end + 1;

    // Raw-text element contents are not HTML markup. Skipping them avoids
    // treating telemetry examples embedded in scripts/styles as real tiles.
    if (!closing && (name === 'script' || name === 'style')) {
      const closePattern = new RegExp(`<\\/\\s*${name}\\s*>`, 'igu');
      closePattern.lastIndex = cursor;
      const close = closePattern.exec(source);
      cursor = close ? close.index + close[0].length : source.length;
    }
  }
  return anchors;
}

function parseAttributes(tag) {
  const name = tag.match(/^\s*a(?=\s|\/|$)/iu);
  if (!name) return null;
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

function searchTermFromFinalUrl(finalUrl, expectedTitle) {
  if (!finalUrl) return null;
  try {
    const url = new URL(finalUrl);
    if (url.origin !== STORE_ORIGIN || url.username || url.password || url.search || url.hash) return null;
    if (!url.pathname.startsWith(SEARCH_PREFIX)) return null;
    const encoded = url.pathname.slice(SEARCH_PREFIX.length).replace(/\/$/u, '');
    if (!encoded || encoded.includes('/')) return null;
    const searchTerm = decodeURIComponent(encoded);
    const actual = normTitle(searchTerm);
    const expected = normTitle(expectedTitle);
    return actual && expected && actual === expected ? searchTerm : null;
  } catch {
    return null;
  }
}

function parseIndex(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) {
    const index = Number(value);
    if (Number.isSafeInteger(index)) return index;
  }
  return null;
}

function productIdFromHref(href) {
  if (typeof href !== 'string' || !href) return null;
  try {
    const url = new URL(href, STORE_ORIGIN);
    if (url.origin !== STORE_ORIGIN || url.search || url.hash || url.username || url.password) return null;
    const match = url.pathname.match(/^\/en-us\/product\/([^/]+)\/?$/u);
    if (!match) return null;
    const productId = decodeURIComponent(match[1]);
    return validPsnProductId(productId) ? productId : null;
  } catch {
    return null;
  }
}

function parseTelemetry(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const meta = JSON.parse(value);
    if (!meta || Array.isArray(meta) || typeof meta !== 'object') return null;
    const productId = typeof meta.id === 'string' ? meta.id : null;
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    const searchTerm = typeof meta.searchTerm === 'string' ? meta.searchTerm.trim() : '';
    const index = parseIndex(meta.index);
    if (!validPsnProductId(productId) || !name || !searchTerm || index == null) return null;
    return { productId, name, searchTerm, index };
  } catch {
    return null;
  }
}

/**
 * Return exact-title product matches sorted by result index and product id.
 *
 * `null` means the response identity or tile structure was unsafe. An empty
 * array means a structurally valid result page contained no exact title.
 */
export function parsePsnSearchPage(html, { expectedTitle, finalUrl }) {
  const pageSearchTerm = searchTermFromFinalUrl(finalUrl, expectedTitle);
  if (!pageSearchTerm) return null;
  const marked = [];
  for (const tag of anchorTags(html)) {
    const mentionsTrackingAttribute = /(?:^|\s)data-track-content(?:\s|=|\/|$)/iu.test(tag);
    const attributes = parseAttributes(tag);
    if (!attributes) {
      if (mentionsTrackingAttribute) return null;
      continue;
    }
    if (mentionsTrackingAttribute && !attributes.has('data-track-content')) return null;
    if (attributes.get('data-track-content') !== TILE_MARKER) continue;
    const meta = parseTelemetry(attributes.get('data-telemetry-meta'));
    const hrefId = productIdFromHref(attributes.get('href'));
    if (!meta || !hrefId || meta.productId !== hrefId) return null;
    if (normTitle(meta.searchTerm) !== normTitle(pageSearchTerm)) return null;
    marked.push({ ...meta, sourceUrl: psnProductUrl(hrefId) });
  }
  if (marked.length === 0) return null;

  const exact = marked.filter((tile) => exactPsnTitle(tile.name, expectedTitle));
  const deduped = new Map();
  for (const tile of exact) {
    const prior = deduped.get(tile.productId);
    if (!prior
      || tile.index < prior.index
      || (tile.index === prior.index && tile.name.localeCompare(prior.name) < 0)) {
      deduped.set(tile.productId, tile);
    }
  }
  return [...deduped.values()]
    .sort((left, right) => left.index - right.index || left.productId.localeCompare(right.productId))
    .map(({ productId, name, index, sourceUrl }) => ({ productId, matchedTitle: name, index, sourceUrl }));
}
