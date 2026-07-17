#!/usr/bin/env node
/**
 * Collect one immutable UTC-day sample of Steam-owned popularity signals.
 * Raw responses are resume caches; the compact daily evidence is the input to
 * build-steam-candidates.mjs. Existing daily output is validated and left
 * byte-for-byte untouched, making same-day reruns a no-op.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertUtcDate,
  buildDailySteamRankingEvidence,
  createRawEvidence,
  evidenceJson,
  parseSteamSearchResults,
  utcDate,
  validateDailySteamRankingEvidence,
  validateRawEvidence,
} from './lib/candidate-evidence.mjs';
import {
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  sleep,
} from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories?cc=us&l=english';
const MOST_PLAYED_URL = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';

function positiveInteger(value, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return parsed;
}

export function buildTopSellersSearchUrl({ start, count }) {
  const url = new URL('https://store.steampowered.com/search/results/');
  url.searchParams.set('query', '');
  url.searchParams.set('start', String(start));
  url.searchParams.set('count', String(count));
  url.searchParams.set('dynamic_data', '');
  url.searchParams.set('sort_by', '_ASC');
  url.searchParams.set('snr', '1_7_7_230_7');
  url.searchParams.set('filter', 'topsellers');
  url.searchParams.set('infinite', '1');
  url.searchParams.set('cc', 'us');
  url.searchParams.set('l', 'english');
  return url.toString();
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function rawResponse({ cachePath, sourceUrl, sourceKind, collectedAt, expectedDate, waitMs }) {
  if (fs.existsSync(cachePath)) {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    validateRawEvidence(cached, { sourceUrl, sourceKind });
    if (utcDate(cached.collectedAt) !== expectedDate) {
      throw new Error(`raw cache UTC date mismatch: ${utcDate(cached.collectedAt)} != ${expectedDate}`);
    }
    return cached;
  }
  const payload = await fetchJson(sourceUrl, {
    label: `Steam candidate evidence: ${sourceKind}`,
    attempts: 2,
    timeoutMs: 20_000,
  });
  const evidence = createRawEvidence({ sourceUrl, payload, collectedAt, sourceKind });
  atomicWrite(cachePath, evidenceJson(evidence));
  if (waitMs > 0) await sleep(waitMs);
  return evidence;
}

export function parseCollectorArgs(args, { now = new Date() } = {}) {
  const options = {
    date: utcDate(now),
    pages: 20,
    pageSize: 100,
    waitMs: 1200,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inline] = argument.split('=', 2);
    if (!['--date', '--pages', '--page-size', '--sleep-ms', '--output', '--cache-dir'].includes(flag)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--date') options.date = assertUtcDate(value);
    if (flag === '--pages') options.pages = positiveInteger(value, '--pages', { max: 20 });
    if (flag === '--page-size') options.pageSize = positiveInteger(value, '--page-size', { min: 10, max: 100 });
    if (flag === '--sleep-ms') options.waitMs = positiveInteger(value, '--sleep-ms', { min: 0, max: 5000 });
    if (flag === '--output') options.outputPath = path.resolve(value);
    if (flag === '--cache-dir') options.cacheDir = path.resolve(value);
  }
  options.outputPath ??= path.join(ROOT, 'data', 'suggestions', 'evidence', 'steam', 'ranking', `${options.date}.json`);
  options.cacheDir ??= path.join(
    ROOT,
    'private',
    'game-library',
    'candidate-cache',
    'steam',
    'raw',
    options.date,
  );
  return options;
}

export async function collectSteamRanking(options = parseCollectorArgs([])) {
  const { date, pages, pageSize, waitMs, outputPath, cacheDir } = options;
  assertUtcDate(date);
  if (fs.existsSync(outputPath)) {
    const existing = validateDailySteamRankingEvidence(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
    if (existing.date !== date) throw new Error(`existing evidence date mismatch: ${existing.date} != ${date}`);
    const policy = existing.sources.topSellers.collectionPolicy;
    if (policy.requestedPages !== pages || policy.pageSize !== pageSize) {
      throw new Error(
        `existing evidence collection policy mismatch: ${policy.requestedPages}x${policy.pageSize}`
        + ` != ${pages}x${pageSize}`,
      );
    }
    return { document: existing, outputPath, noOp: true };
  }

  const collectedAt = new Date();
  if (utcDate(collectedAt) !== date) {
    throw new Error('--date must be the current UTC date when collecting live evidence');
  }
  setRequestBudget(requestBudgetFor(pages + 2, 0.25));
  const searchPages = [];
  let terminationReason = 'requested_limit';
  for (let page = 0; page < pages; page += 1) {
    const start = page * pageSize;
    const sourceUrl = buildTopSellersSearchUrl({ start, count: pageSize });
    const raw = await rawResponse({
      cachePath: path.join(cacheDir, `search-${String(start).padStart(6, '0')}.json`),
      sourceUrl,
      sourceKind: 'steam-search-topsellers',
      collectedAt,
      expectedDate: date,
      waitMs,
    });
    const parsed = parseSteamSearchResults(raw.payload, { start });
    searchPages.push({ start, count: pageSize, sourceUrl, payload: raw.payload });
    if (start + parsed.rowCount >= parsed.totalCount || parsed.rowCount === 0) {
      terminationReason = 'source_exhausted';
      break;
    }
  }

  const featured = await rawResponse({
    cachePath: path.join(cacheDir, 'featuredcategories.json'),
    sourceUrl: FEATURED_URL,
    sourceKind: 'steam-featuredcategories-top-sellers',
    collectedAt,
    expectedDate: date,
    waitMs,
  });
  const mostPlayed = await rawResponse({
    cachePath: path.join(cacheDir, 'get-most-played-games.json'),
    sourceUrl: MOST_PLAYED_URL,
    sourceKind: 'steam-get-most-played-games',
    collectedAt,
    expectedDate: date,
    waitMs: 0,
  });
  const document = buildDailySteamRankingEvidence({
    date,
    collectedAt,
    searchPages,
    collectionPolicy: {
      requestedPages: pages,
      pageSize,
      terminationReason,
    },
    featured: { sourceUrl: FEATURED_URL, payload: featured.payload },
    mostPlayed: { sourceUrl: MOST_PLAYED_URL, payload: mostPlayed.payload },
    freshnessNow: collectedAt,
  });
  atomicWrite(outputPath, evidenceJson(document));
  return { document, outputPath, noOp: false };
}

async function main() {
  const result = await collectSteamRanking(parseCollectorArgs(process.argv.slice(2)));
  console.log(result.noOp ? `no-op: ${result.outputPath}` : `wrote ${result.outputPath}`);
  console.log(`UTC date: ${result.document.date}`);
  console.log(`top-seller items: ${result.document.sources.topSellers.items.length}`);
  if (!result.document.sources.mostPlayed.accepted) {
    console.warn(`GetMostPlayedGames rejected: ${result.document.sources.mostPlayed.rejectedReason}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
