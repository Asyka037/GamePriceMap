#!/usr/bin/env node
/**
 * Rebuild data/feeds/calendar.json from its retained PC/Switch rows and the
 * latest sealed Xbox/PlayStation release caches. This step is deliberately
 * network-free so a platform workflow can publish its new cache immediately,
 * without waiting for the next daily Steam/Nintendo calendar refresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeCalendarEntries } from './lib/calendar.mjs';
import { canonicalPsnCalendarTitle } from './lib/psn-calendar.mjs';
import { validPsnProductId } from './lib/psn.mjs';
import { isXboxBaseGameCalendarTitle } from './lib/xbox-calendar.mjs';
import { validXboxBigId } from './lib/xbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_PLATFORMS = new Set(['pc', 'switch']);
const ALL_PLATFORMS = new Set(['pc', 'switch', 'xbox', 'psn']);
const CACHE_TOP_LEVEL_KEYS = ['items', 'schemaVersion', 'source', 'updatedAt'];
const CACHE_ITEM_KEYS = ['date', 'image', 'month', 'platform', 'slugIfTracked', 'title', 'url'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const RELEASE_CACHE_SPECS = [
  {
    file: 'releases-xbox.json',
    source: 'calendar-xbox-us',
    platform: 'xbox',
    productIdentity(value) {
      try {
        const url = new URL(value);
        const match = url.pathname.match(/^\/en-us\/p\/_\/([a-z0-9]{12})$/u);
        const id = match?.[1]?.toUpperCase() ?? null;
        return url.origin === 'https://www.microsoft.com'
          && !url.username && !url.password && !url.search && !url.hash
          && validXboxBigId(id)
          ? id
          : null;
      } catch {
        return null;
      }
    },
    validImage(value) {
      try {
        const url = new URL(value);
        return url.origin === 'https://store-images.s-microsoft.com'
          && !url.username && !url.password && !url.hash
          && url.pathname.startsWith('/image/');
      } catch {
        return false;
      }
    },
    validTitle: isXboxBaseGameCalendarTitle,
    mappedIdentity(game) { return game?.xboxBigId ?? null; },
  },
  {
    file: 'releases-psn.json',
    source: 'calendar-psn-us',
    platform: 'psn',
    productIdentity(value) {
      try {
        const url = new URL(value);
        const match = url.pathname.match(/^\/en-us\/product\/([^/]+)$/u);
        const id = match ? decodeURIComponent(match[1]) : null;
        return url.origin === 'https://store.playstation.com'
          && !url.username && !url.password && !url.search && !url.hash
          && validPsnProductId(id)
          && match[1] === encodeURIComponent(id)
          ? id
          : null;
      } catch {
        return null;
      }
    },
    validImage(value) {
      try {
        const url = new URL(value);
        return url.origin === 'https://image.api.playstation.com'
          && !url.username && !url.password && !url.hash
          && url.pathname !== '/';
      } catch {
        return false;
      }
    },
    validTitle(value) { return canonicalPsnCalendarTitle(value) === value; },
    mappedIdentity(game) { return game?.psnProductId ?? null; },
  },
];

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, expected) {
  return plainObject(value)
    && Object.keys(value).toSorted().join('\0') === [...expected].toSorted().join('\0');
}

function exactIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function validIsoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString().slice(0, 10) === value;
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function stableSemanticJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!plainObject(item)) return item;
    return Object.fromEntries(Object.keys(item).toSorted().map((key) => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o644);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor != null) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function validateCurrentCalendar(document) {
  if (!plainObject(document) || !plainObject(document.months) || exactIsoTimestamp(document.updatedAt) == null) {
    throw new Error('calendar.json is not a supported merged calendar document');
  }
  const baseEntries = [];
  const consolePlatforms = new Set();
  for (const [month, items] of Object.entries(document.months)) {
    if (!/^\d{4}-\d{2}$/u.test(month) || !Array.isArray(items) || items.length === 0) {
      throw new Error(`calendar.json has an invalid month: ${month}`);
    }
    for (const [index, item] of items.entries()) {
      const label = `calendar.json ${month}[${index}]`;
      if (!plainObject(item)
        || typeof item.title !== 'string' || !item.title.trim()
        || item.month !== month
        || (item.date != null && (!validIsoDay(item.date) || !item.date.startsWith(month)))
        || !Array.isArray(item.platforms) || item.platforms.length === 0
        || new Set(item.platforms).size !== item.platforms.length
        || !plainObject(item.urls)) {
        throw new Error(`${label} is structurally invalid`);
      }
      const urlKeys = Object.keys(item.urls).toSorted();
      const platformKeys = [...item.platforms].toSorted();
      if (JSON.stringify(urlKeys) !== JSON.stringify(platformKeys)) {
        throw new Error(`${label} does not bind exactly one URL per platform`);
      }
      if (item.slugIfTracked != null && !SLUG_RE.test(item.slugIfTracked)) {
        throw new Error(`${label} has an invalid tracked slug`);
      }
      for (const platform of item.platforms) {
        if (!ALL_PLATFORMS.has(platform) || !httpsUrl(item.urls[platform])) {
          throw new Error(`${label} has an invalid ${platform} URL`);
        }
        if (!BASE_PLATFORMS.has(platform)) {
          consolePlatforms.add(platform);
          continue;
        }
        baseEntries.push({
          title: item.title,
          date: item.date ?? null,
          month,
          platform,
          url: item.urls[platform],
          image: item.image ?? null,
          slugIfTracked: item.slugIfTracked ?? null,
        });
      }
    }
  }
  return { baseEntries, consolePlatforms };
}

function validateReleaseCache(document, spec, { catalogBySlug, nowMs }) {
  const label = `data/feeds/${spec.file}`;
  if (!exactKeys(document, CACHE_TOP_LEVEL_KEYS)
    || document.schemaVersion !== 1
    || document.source !== spec.source
    || !Array.isArray(document.items)
    || document.items.length === 0) {
    throw new Error(`${label} is not a sealed ${spec.source} cache`);
  }
  const updatedAt = exactIsoTimestamp(document.updatedAt);
  if (updatedAt == null || updatedAt > nowMs) throw new Error(`${label} has an invalid updatedAt`);
  const sourceDay = Date.parse(`${document.updatedAt.slice(0, 10)}T00:00:00.000Z`);
  const seenUrls = new Set();
  const sortKeys = [];
  for (const [index, item] of document.items.entries()) {
    const itemLabel = `${label} item ${index}`;
    if (!exactKeys(item, CACHE_ITEM_KEYS)
      || typeof item.title !== 'string' || item.title !== item.title.trim()
      || !item.title || item.title.length > 300
      || !spec.validTitle(item.title)
      || !validIsoDay(item.date) || item.month !== item.date.slice(0, 7)
      || item.platform !== spec.platform
      || !spec.validImage(item.image)
      || (item.slugIfTracked !== null && !SLUG_RE.test(item.slugIfTracked))) {
      throw new Error(`${itemLabel} violates the sealed release item schema`);
    }
    const releaseDay = Date.parse(`${item.date}T00:00:00.000Z`);
    if (releaseDay < sourceDay || releaseDay > sourceDay + 180 * 86_400_000) {
      throw new Error(`${itemLabel} lies outside its sealed 180-day window`);
    }
    const identity = spec.productIdentity(item.url);
    if (!identity) throw new Error(`${itemLabel} does not use its exact official product URL`);
    if (seenUrls.has(item.url)) throw new Error(`${label} repeats product URL ${item.url}`);
    seenUrls.add(item.url);
    if (item.slugIfTracked !== null) {
      const game = catalogBySlug.get(item.slugIfTracked);
      if (!game || spec.mappedIdentity(game) !== identity) {
        throw new Error(`${itemLabel} does not match its reviewed catalog mapping`);
      }
    }
    sortKeys.push({ date: item.date, title: item.title, url: item.url });
  }
  const sorted = [...sortKeys].sort((left, right) => left.date.localeCompare(right.date)
    || left.title.localeCompare(right.title)
    || left.url.localeCompare(right.url));
  if (JSON.stringify(sortKeys) !== JSON.stringify(sorted)) {
    throw new Error(`${label} is not deterministically sorted`);
  }
  return document.items.map((item) => ({ ...item }));
}

export function mergeConsoleCalendar({ root = ROOT, now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.valueOf())) throw new Error('console calendar merge time is invalid');
  const calendarPath = path.join(root, 'data', 'feeds', 'calendar.json');
  const catalogPath = path.join(root, 'data', 'catalog.json');
  const current = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog.games)) throw new Error('catalog.games is required for console calendar merge');
  const catalogBySlug = new Map(catalog.games.map((game) => [game.slug, game]));
  if (catalogBySlug.size !== catalog.games.length) throw new Error('catalog contains duplicate slugs');

  const { baseEntries, consolePlatforms } = validateCurrentCalendar(current);
  const consoleEntries = [];
  for (const spec of RELEASE_CACHE_SPECS) {
    const cachePath = path.join(root, 'data', 'feeds', spec.file);
    if (!fs.existsSync(cachePath)) {
      if (consolePlatforms.has(spec.platform)) {
        throw new Error(`calendar.json contains ${spec.platform}, but ${spec.file} is missing`);
      }
      continue;
    }
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    consoleEntries.push(...validateReleaseCache(cache, spec, {
      catalogBySlug,
      nowMs: nowDate.valueOf(),
    }));
  }

  // Match scrape-calendar's source priority: console cache artwork/title wins
  // only for an unambiguous same-title/same-day merge; PC/Switch URLs remain
  // independent after splitting the existing merged rows above.
  const months = mergeCalendarEntries([...consoleEntries, ...baseEntries]);
  if (stableSemanticJson(months) === stableSemanticJson(current.months)) {
    return { changed: false, entries: Object.values(months).flat().length, calendarPath };
  }
  atomicWriteJson(calendarPath, {
    updatedAt: nowDate.toISOString(),
    months,
  });
  return { changed: true, entries: Object.values(months).flat().length, calendarPath };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) throw new Error('merge-console-calendar accepts no arguments');
  const result = mergeConsoleCalendar();
  console.log(`Console calendar ${result.changed ? 'updated' : 'unchanged'}: ${result.entries} merged entries`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
