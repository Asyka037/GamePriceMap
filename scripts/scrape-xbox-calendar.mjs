/**
 * Microsoft Store US Xbox release-calendar discovery.
 *
 * A complete official category + Display Catalog sweep is required before
 * replacing the last good cache. Network failures, pagination drift and
 * incomplete product batches all fail soft: the old cache stays byte-for-byte
 * unchanged while `calendar-xbox-us` records the failed attempt.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  chunk,
  fetchJson,
  fetchTextViaCurl,
  setRequestBudget,
  sleep,
} from './lib/http.mjs';
import {
  XBOX_BATCH_SIZE,
  validXboxBigId,
  xboxProductsUrl,
} from './lib/xbox.mjs';
import {
  parseXboxCalendarProduct,
  parseXboxComingSoonPage,
  xboxComingSoonPageUrl,
} from './lib/xbox-calendar.mjs';
import { recordSourceRun } from './lib/sourcehealth.mjs';
import { releaseCalendarCliExitCode } from './lib/release-calendar-run.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'calendar-xbox-us';
const REQUEST_BUDGET = 30;
const CATEGORY_DELAY_MS = 1500;
const CATALOG_DELAY_MS = 1200;
const RELEASE_WINDOW_DAYS = 180;

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function utcDay(value) {
  const milliseconds = value instanceof Date ? value.valueOf() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error('Xbox calendar now is invalid');
  return Date.parse(new Date(milliseconds).toISOString().slice(0, 10));
}

function releaseWithinWindow(date, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) return false;
  const release = Date.parse(`${date}T00:00:00Z`);
  const start = utcDay(now);
  const end = start + RELEASE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return Number.isFinite(release) && release >= start && release <= end;
}

function bigIdFromReleaseUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(/^\/en-us\/p\/_\/([a-z0-9]{12})$/u);
    return url.origin === 'https://www.microsoft.com' && !url.search && !url.hash && match
      ? match[1].toUpperCase()
      : null;
  } catch {
    return null;
  }
}

/** Refuse a structurally valid but implausibly hollow replacement cache. */
export function guardXboxCalendarReplacement({ previous, entries, cardIds, now }) {
  if (previous == null) return;
  if (previous?.schemaVersion !== 1 || previous?.source !== SOURCE || !Array.isArray(previous.items)) {
    throw new Error('previous Xbox release cache is not a sealed source document');
  }
  const today = utcDay(now);
  const oldFuture = previous.items.filter((item) => {
    const release = Date.parse(`${item?.date}T00:00:00Z`);
    return Number.isFinite(release) && release > today && release <= today + RELEASE_WINDOW_DAYS * 86_400_000;
  });
  const nextIds = new Set(entries.map((entry) => bigIdFromReleaseUrl(entry.url)).filter(Boolean));
  for (const item of oldFuture) {
    const bigId = bigIdFromReleaseUrl(item.url);
    if (bigId && cardIds.has(bigId) && !nextIds.has(bigId)) {
      throw new Error(`previously published Xbox release ${bigId} no longer passes product guards`);
    }
  }
  if (oldFuture.length >= 4 && entries.length < Math.ceil(oldFuture.length / 2)) {
    throw new Error(`Xbox release cache collapsed from ${oldFuture.length} future entries to ${entries.length}`);
  }
}

function assertCompleteProductBatch(body, expectedIds) {
  if (!body || !Array.isArray(body.Products)) {
    throw new Error('Xbox Display Catalog response is missing Products');
  }
  const expected = new Set(expectedIds);
  const observed = new Set();
  for (const product of body.Products) {
    const bigId = String(product?.ProductId ?? '').toUpperCase();
    if (!validXboxBigId(bigId) || !expected.has(bigId) || observed.has(bigId)) {
      throw new Error('Xbox Display Catalog response contains an unexpected or duplicate ProductId');
    }
    observed.add(bigId);
  }
  if (observed.size !== expected.size) {
    throw new Error(`Xbox Display Catalog returned ${observed.size}/${expected.size} requested products`);
  }
  return new Map(body.Products.map((product) => [String(product.ProductId).toUpperCase(), product]));
}

function rejectionSummary(reasons) {
  return [...reasons.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
}

/**
 * Dependency-injected entry point so retention and request-budget behavior can
 * be tested without network access or mutation of the production data tree.
 */
export async function runXboxCalendarScrape({
  root = ROOT,
  now = new Date(),
  fetchTextImpl = fetchTextViaCurl,
  fetchJsonImpl = fetchJson,
  sleepImpl = sleep,
  setRequestBudgetImpl = setRequestBudget,
  recordSourceRunImpl = recordSourceRun,
  categoryDelayMs = CATEGORY_DELAY_MS,
  catalogDelayMs = CATALOG_DELAY_MS,
} = {}) {
  const outputPath = path.join(root, 'data', 'feeds', 'releases-xbox.json');
  const hadPreviousCache = fs.existsSync(outputPath);
  let complete = false;
  let note = 'calendar discovery did not start';
  let published = 0;

  try {
    setRequestBudgetImpl(REQUEST_BUDGET);
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'data', 'catalog.json'), 'utf8'));
    const slugByBigId = new Map();
    for (const game of catalog.games ?? []) {
      if (!validXboxBigId(game.xboxBigId)) continue;
      if (slugByBigId.has(game.xboxBigId)) throw new Error(`duplicate catalog Xbox BigID ${game.xboxBigId}`);
      slugByBigId.set(game.xboxBigId, game.slug);
    }

    const pages = [];
    let skip = 0;
    let expectedTotal = null;
    while (skip != null) {
      if (pages.length > 0) await sleepImpl(categoryDelayMs);
      const response = await fetchTextImpl(xboxComingSoonPageUrl(skip), {
        label: `xbox coming-soon page ${pages.length + 1}`,
      });
      const page = parseXboxComingSoonPage(response.text, {
        finalUrl: response.finalUrl,
        expectedSkip: skip,
        expectedTotal,
      });
      expectedTotal ??= page.total;
      pages.push(page);
      skip = page.nextSkip;
    }

    const cards = pages.flatMap((page) => page.cards);
    if (cards.length !== expectedTotal) {
      throw new Error(`Xbox category pagination returned ${cards.length}/${expectedTotal} cards`);
    }
    const cardIds = new Set();
    for (const [index, card] of cards.entries()) {
      if (card.index !== index || cardIds.has(card.bigId)) {
        throw new Error('Xbox category pages have a non-contiguous or duplicate global identity');
      }
      cardIds.add(card.bigId);
    }

    const productById = new Map();
    const batches = chunk(cards, XBOX_BATCH_SIZE);
    for (const [index, batch] of batches.entries()) {
      if (index > 0) await sleepImpl(catalogDelayMs);
      const ids = batch.map((card) => card.bigId);
      const body = await fetchJsonImpl(xboxProductsUrl(ids), {
        label: `xbox release products ${index + 1}/${batches.length}`,
      });
      for (const [bigId, product] of assertCompleteProductBatch(body, ids)) {
        if (productById.has(bigId)) throw new Error(`duplicate Xbox product across batches: ${bigId}`);
        productById.set(bigId, product);
      }
    }
    if (productById.size !== cards.length) {
      throw new Error(`Xbox product sweep returned ${productById.size}/${cards.length} products`);
    }

    const entries = [];
    const rejected = new Map();
    let outsideWindow = 0;
    for (const card of cards) {
      const parsed = parseXboxCalendarProduct(productById.get(card.bigId), {
        card,
        now,
        // Catalog identity is joined only by the exact approved BigID. Titles
        // are never used to attach a public game-detail route.
        slugIfTracked: slugByBigId.get(card.bigId) ?? null,
      });
      if (!parsed.entry) {
        rejected.set(parsed.reason, (rejected.get(parsed.reason) ?? 0) + 1);
        continue;
      }
      if (!releaseWithinWindow(parsed.entry.date, now)) {
        outsideWindow++;
        continue;
      }
      const { xboxBigId: verifiedBigId, ...entry } = parsed.entry;
      if (verifiedBigId !== card.bigId) throw new Error('Xbox parsed entry lost its exact BigID identity');
      entries.push(entry);
    }
    if (entries.length === 0) {
      throw new Error('Xbox calendar verification produced zero publishable entries');
    }

    entries.sort((left, right) => left.date.localeCompare(right.date)
      || left.title.localeCompare(right.title)
      || left.url.localeCompare(right.url));
    const previous = hadPreviousCache
      ? JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      : null;
    guardXboxCalendarReplacement({ previous, entries, cardIds, now });
    atomicWriteJson(outputPath, {
      schemaVersion: 1,
      source: SOURCE,
      updatedAt: new Date(now).toISOString(),
      items: entries,
    });
    published = entries.length;
    complete = true;
    const exclusions = rejectionSummary(rejected) || 'none';
    note = `pages ${pages.length}, category products ${cards.length}, verified products ${productById.size}, published ${published}, outside window ${outsideWindow}, safe exclusions ${cards.length - published - outsideWindow} (${exclusions})`;
  } catch (error) {
    note = `${note}; ${error.message}`;
    console.warn(`Xbox release calendar kept previous cache: ${error.message}`);
  } finally {
    recordSourceRunImpl(SOURCE, { ok: complete, note });
  }

  return { complete, note, published, hadPreviousCache };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const result = await runXboxCalendarScrape();
  console.log(`Xbox release calendar ${result.complete ? 'updated' : 'kept previous cache'}: ${result.note}`);
  process.exitCode = releaseCalendarCliExitCode(result);
}
