#!/usr/bin/env node
/**
 * Nintendo candidate discovery.
 *
 * Americas discovery uses Nintendo's official US store sitemap to locate a
 * canonical product URL, then verifies only that exact page plus the official
 * US price endpoint. It never probes guessed product URLs.
 *
 * Usage:
 *   node scripts/discover-nsuid.mjs                         # catalog compatibility dry run
 *   node scripts/discover-nsuid.mjs slug ...                # selected catalog slugs
 *   node scripts/discover-nsuid.mjs --input seeds.json      # external reviewed candidates
 *   node scripts/discover-nsuid.mjs --apply --input seeds.json [--output file]
 *   node scripts/discover-nsuid.mjs --us-product-slug-map reviewed-map.json ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertDocumentDigest, sha256Digest } from './lib/candidate-evidence.mjs';
import { indexPricesById, parsePriceEntry, priceUrl } from './lib/eshop.mjs';
import {
  fetchJson,
  fetchText,
  requestBudgetFor,
  setRequestBudget,
  shouldTripCircuit,
  sleep,
} from './lib/http.mjs';
import {
  NINTENDO_US_BROWSER_HEADERS,
  consumeNintendoUsProductPageBudget,
  createNintendoUsBudgetLedger,
  evaluateNintendoUsProductPage,
  nintendoUsProductPageCandidates,
  parseNintendoUsStoreSitemap,
} from './lib/nintendo-us-discovery.mjs';
import {
  createNintendoSuggestionDocument,
  discoverNintendoCandidates,
  parseDiscoverNsuidArgs,
  sealRegionalDiscoveryEvidence,
  stableNintendoCandidateId,
  validateNintendoSeedDocument,
} from './lib/ns-candidates.mjs';
import {
  evaluateEuropeDiscoveryCandidates,
  evaluateJapanDiscoveryCandidates,
} from './lib/nsuid-discovery.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'data', 'suggestions', 'nsuid-candidates.json');
const US_BUDGET_PATH = path.join(ROOT, 'data', 'seeds', 'nintendo-us-discovery-budget.json');
const US_SITEMAP_URL = 'https://www.nintendo.com/us/store/sitemap.xml';
const DISCOVERY_PAUSE_MS = 1500;
const US_BUDGET_LOCK_STALE_MS = 5 * 60_000;
const US_RUN_LOCK_STALE_MS = 2 * 60 * 60_000;

function sourceException(reason) {
  return { status: 'exception', reason };
}

export async function discoverEuropeOfficial(candidate, { collectedAt = new Date().toISOString() } = {}) {
  const searchUrl = `https://searching.nintendo-europe.com/en/select?q=${encodeURIComponent(candidate.title)}&fq=type%3AGAME&rows=8&wt=json`;
  const searchBody = await fetchJson(searchUrl, { label: `eu search ${candidate.slug}`, attempts: 2 });
  const evaluated = evaluateEuropeDiscoveryCandidates(searchBody.response?.docs, {
    title: candidate.title,
    platforms: candidate.platforms,
    now: Date.parse(collectedAt),
  });
  if (evaluated.status !== 'matched') return evaluated;

  const candidateMatch = evaluated.candidate;
  const officialPriceUrl = priceUrl('GB', [candidateMatch.nsuid]);
  const priceBody = await fetchJson(officialPriceUrl, { label: `eu price ${candidate.slug}`, attempts: 2 });
  const priceEntry = indexPricesById(priceBody).get(candidateMatch.nsuid);
  if (!parsePriceEntry(priceEntry)) return sourceException('paid_price_verification_failed');
  return sealRegionalDiscoveryEvidence({
    status: 'matched',
    region: 'europe',
    nsuid: candidateMatch.nsuid,
    matchedTitle: candidateMatch.matchedTitle,
    generation: candidateMatch.generation,
    paid: true,
    released: true,
    releasedAt: candidateMatch.releasedAt,
    publishers: candidateMatch.publishers,
    developers: candidateMatch.developers,
    lowestGbp: candidateMatch.lowestGbp,
    sourceUrl: searchUrl,
    priceSourceUrl: officialPriceUrl,
    collectedAt,
    sourceDigest: sha256Digest({ searchBody, priceBody }),
  });
}

export async function discoverJapanOfficial(candidate, { collectedAt = new Date().toISOString() } = {}) {
  const searchUrl = `https://search.nintendo.jp/nintendo_soft/search.json?q=${encodeURIComponent(candidate.title)}&limit=8`;
  const body = await fetchJson(searchUrl, { label: `jp search ${candidate.slug}`, attempts: 2 });
  const evaluated = evaluateJapanDiscoveryCandidates(body.result?.items, {
    title: candidate.title,
    platforms: candidate.platforms,
  });
  if (evaluated.status !== 'matched') return evaluated;
  const match = evaluated.candidate;
  return sealRegionalDiscoveryEvidence({
    status: 'matched',
    region: 'japan',
    nsuid: match.nsuid,
    matchedTitle: match.matchedTitle,
    generation: match.generation,
    paid: true,
    released: true,
    publishers: match.publishers,
    developers: match.developers,
    sourceUrl: searchUrl,
    collectedAt,
    sourceDigest: sha256Digest(body),
  });
}

function loadUsBudgetLedger(filePath = US_BUDGET_PATH) {
  if (!fs.existsSync(filePath)) return createNintendoUsBudgetLedger();
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function processIsAlive(pid) {
  if (!(Number.isSafeInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be signalled. Only ESRCH is
    // positive evidence that a recorded owner has exited.
    return error?.code !== 'ESRCH';
  }
}

function staleBudgetLock(lockPath, nowMs, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock?.schemaVersion === 1
      && Number.isSafeInteger(lock.pid)
      && lock.pid > 0
      && typeof lock.token === 'string'
      && Number.isFinite(Date.parse(lock.createdAt ?? ''))) {
      const lastOwnerWriteMs = Math.max(Date.parse(lock.createdAt), stat.mtimeMs);
      return !processIsAlive(lock.pid)
        || nowMs - lastOwnerWriteMs >= staleMs;
    }
  } catch {}
  // Covers a crash between exclusive creation and writing the owner record.
  return nowMs - stat.mtimeMs >= staleMs;
}

function acquireBudgetLock(lockPath, now = new Date(), staleMs = US_BUDGET_LOCK_STALE_MS) {
  const nowMs = new Date(now).valueOf();
  if (!Number.isFinite(nowMs)) throw new TypeError('Nintendo US lock time is invalid');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = {
      schemaVersion: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date(nowMs).toISOString(),
    };
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        return { descriptor, owner };
      } catch (error) {
        fs.closeSync(descriptor);
        try { fs.unlinkSync(lockPath); } catch {}
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!staleBudgetLock(lockPath, nowMs, staleMs)) {
        const locked = new Error('Nintendo US product-page budget ledger is locked by another discovery run');
        locked.code = 'nintendo_us_budget_locked';
        throw locked;
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  const locked = new Error('Nintendo US product-page budget lock could not be recovered');
  locked.code = 'nintendo_us_budget_locked';
  throw locked;
}

function releaseBudgetLock(lockPath, lock) {
  fs.closeSync(lock.descriptor);
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current?.token === lock.owner.token) fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

/** Hold for the full production discovery run so delayed processes cannot
 * reorder their reserved page slots and violate the actual start interval. */
export function acquireNintendoUsDiscoveryRun({
  lockPath = `${US_BUDGET_PATH}.run.lock`,
  now = new Date(),
} = {}) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const lock = acquireBudgetLock(lockPath, now, US_RUN_LOCK_STALE_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseBudgetLock(lockPath, lock);
  };
}

export function reserveNintendoUsProductPage({
  budgetPath = US_BUDGET_PATH,
  now = new Date(),
} = {}) {
  fs.mkdirSync(path.dirname(budgetPath), { recursive: true });
  const lockPath = `${budgetPath}.lock`;
  const lock = acquireBudgetLock(lockPath, now);
  try {
    const reservation = consumeNintendoUsProductPageBudget(loadUsBudgetLedger(budgetPath), { now });
    // Persist before the request. A crash or rejected response still consumed
    // upstream capacity and must not be retried past the daily ceiling.
    atomicWriteJson(budgetPath, reservation.ledger);
    return reservation;
  } finally {
    releaseBudgetLock(lockPath, lock);
  }
}

/**
 * Verify zero or one unambiguous US base product located by the official
 * sitemap. Product-page access is persistently budgeted and browser-paced.
 */
export async function discoverAmericasOfficial(candidate, {
  collectedAt = new Date().toISOString(),
  sitemap,
  sitemapDigest,
  fetchPage = fetchText,
  fetchPrice = fetchJson,
  reserveProductPage = () => reserveNintendoUsProductPage(),
  waitForReservation = sleep,
} = {}) {
  const pages = nintendoUsProductPageCandidates(candidate, sitemap);
  if (pages.length === 0) {
    return {
      status: 'none',
      reason: candidate.nintendoUsSlugHint ? 'sitemap_hint_not_found' : 'sitemap_exact_product_slug_not_found',
      auditReasons: [candidate.nintendoUsSlugHint ? 'sitemap_hint_not_found' : 'sitemap_exact_product_slug_not_found'],
    };
  }

  const matches = [];
  const auditReasons = [];
  for (const page of pages) {
    const reservation = await reserveProductPage();
    if (reservation?.waitMs > 0) await waitForReservation(reservation.waitMs);
    let response;
    try {
      response = await fetchPage(page.url, {
        label: `Nintendo US product ${candidate.slug}`,
        // One persisted reservation equals exactly one product-page request.
        // Retrying inside fetchText would let 100 reservations create up to
        // 200 upstream requests and would also bypass the reserved pacing.
        attempts: 1,
        headers: NINTENDO_US_BROWSER_HEADERS,
      });
    } catch (error) {
      if ([404, 410].includes(error?.status)) {
        auditReasons.push('sitemap_product_not_found');
        continue;
      }
      throw error;
    }
    const evaluated = evaluateNintendoUsProductPage({
      text: response.text,
      requestedUrl: page.url,
      finalUrl: response.finalUrl,
    }, {
      title: candidate.title,
      platforms: candidate.platforms,
      now: new Date(collectedAt),
    });
    if (evaluated.status === 'exception') return evaluated;
    if (evaluated.status !== 'matched') {
      auditReasons.push(evaluated.reason);
      continue;
    }

    const priceSourceUrl = priceUrl('US', [evaluated.candidate.nsuid]);
    const priceBody = await fetchPrice(priceSourceUrl, {
      label: `Nintendo US paid check ${candidate.slug}`,
      attempts: 2,
    });
    const paid = parsePriceEntry(indexPricesById(priceBody).get(evaluated.candidate.nsuid));
    if (!paid || paid.currency !== 'USD') {
      auditReasons.push('paid_usd_price_verification_failed');
      continue;
    }
    matches.push(sealRegionalDiscoveryEvidence({
      status: 'matched',
      evidenceKind: 'nintendo_us_current_product_page',
      region: 'americas',
      manual: false,
      nsuid: evaluated.candidate.nsuid,
      matchedTitle: evaluated.candidate.matchedTitle,
      generation: evaluated.candidate.generation,
      paid: true,
      released: true,
      releasedAt: evaluated.candidate.releasedAt,
      productSlug: evaluated.candidate.productSlug,
      sourceUrl: response.finalUrl,
      requestedUrl: page.url,
      finalUrl: response.finalUrl,
      priceSourceUrl,
      sitemapUrl: US_SITEMAP_URL,
      sitemapDigest,
      locatedBy: page.locatedBy,
      collectedAt,
      pageSourceDigest: sha256Digest({ text: response.text, finalUrl: response.finalUrl }),
      sourceDigest: sha256Digest({ text: response.text, finalUrl: response.finalUrl, priceBody }),
    }));
  }
  if (matches.length > 1) {
    return {
      status: 'exception',
      reason: 'ambiguous_exact_us_products',
      nsuids: matches.map((match) => match.nsuid).sort(),
    };
  }
  if (matches.length === 1) return matches[0];
  return {
    status: 'none',
    reason: auditReasons[0] ?? 'no_exact_us_product',
    auditReasons: [...new Set(auditReasons.filter(Boolean))].sort(),
  };
}

export function validateNintendoUsSlugMapDocument(document) {
  assertDocumentDigest(document);
  if (document?.schemaVersion !== 1 || document?.kind !== 'nintendo-us-product-slug-map') {
    throw new Error('unsupported Nintendo US product slug map schema');
  }
  if (!Number.isFinite(Date.parse(document.generatedAt ?? ''))) {
    throw new Error('Nintendo US product slug map generatedAt is invalid');
  }
  if (!document.mappings || typeof document.mappings !== 'object' || Array.isArray(document.mappings)) {
    throw new Error('Nintendo US product slug map mappings must be an object');
  }
  const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
  for (const [slug, productSlug] of Object.entries(document.mappings)) {
    if (!slugPattern.test(slug) || !slugPattern.test(productSlug)) {
      throw new Error(`invalid Nintendo US product slug mapping: ${slug}`);
    }
  }
  return document;
}

function loadNintendoUsSlugMap(filePath) {
  if (!filePath) return { mappings: new Map(), documentDigest: null };
  const document = validateNintendoUsSlugMapDocument(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  return { mappings: new Map(Object.entries(document.mappings)), documentDigest: document.documentDigest };
}

export function catalogTargets(catalog, slugs, usSlugMap = new Map()) {
  const requested = new Set(slugs);
  const candidates = catalog.games.filter((game) => {
    const switchGame = game.platforms?.some((platform) => platform === 'switch' || platform === 'switch-2');
    const missingNintendoGroup = ['americas', 'europe', 'japan'].some((group) => !game.nsuids?.[group]);
    return switchGame && missingNintendoGroup && (requested.size === 0 || requested.has(game.slug));
  });
  if (requested.size > 0) {
    const found = new Set(candidates.map((candidate) => candidate.slug));
    const missing = [...requested].filter((slug) => !found.has(slug));
    if (missing.length > 0) throw new Error(`catalog slugs are absent, non-Switch, or already mapped: ${missing.join(', ')}`);
  }
  return candidates.map((game) => ({
    candidateId: null,
    catalogAction: 'add_platform_mapping',
    slug: game.slug,
    title: game.title,
    platforms: [...game.platforms],
    publisher: null,
    developer: null,
    knownNsuids: structuredClone(game.nsuids ?? null),
    knownNintendoUsSlug: game.nintendoUsSlug ?? null,
    nintendoUsSlugHint: usSlugMap.get(game.slug) ?? game.nintendoUsSlug ?? null,
    seedEvidence: [],
    manualUsEvidence: null,
    exclusivityEvidence: null,
    // Catalog membership is not cross-platform evidence. An explicit,
    // digest-bound title and organization match remains required.
    steamMatchEvidence: null,
    popularityEvidence: [],
  }));
}

function catalogNsuidOwners(catalog) {
  return new Map(catalog.games.flatMap((game) => Object.values(game.nsuids ?? {})
    .filter(Boolean)
    .map((nsuid) => [String(nsuid), game.slug])));
}

function circuitWrapper(source, discover, collectedAt) {
  const stats = { attempted: 0, failed: 0, open: false };
  const run = async (candidate) => {
    if (stats.open) return sourceException(`${source}_circuit_open`);
    stats.attempted += 1;
    try {
      return await discover(candidate, { collectedAt });
    } catch (error) {
      stats.failed += 1;
      if (shouldTripCircuit(stats.attempted, stats.failed)) stats.open = true;
      const wrapped = new Error(`${source} discovery failed: ${error.message}`);
      wrapped.code = error?.code ?? `${source}_network_error`;
      throw wrapped;
    }
  };
  return { run, stats };
}

function atomicWriteJson(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function assertSafeDiscoveryPaths({
  inputPath = null,
  outputPath = DEFAULT_OUTPUT_PATH,
  usProductSlugMapPath = null,
} = {}) {
  const resolvedInput = inputPath ? path.resolve(process.cwd(), inputPath) : null;
  const resolvedUsProductSlugMap = usProductSlugMapPath
    ? path.resolve(process.cwd(), usProductSlugMapPath)
    : null;
  const resolvedOutput = path.resolve(process.cwd(), outputPath);
  if (resolvedOutput === path.resolve(CATALOG_PATH)) {
    const error = new Error('Nintendo discovery output may never replace catalog.json');
    error.code = 'catalog_output_forbidden';
    throw error;
  }
  if (resolvedInput && resolvedOutput === resolvedInput) {
    const error = new Error('Nintendo discovery output must not replace its reviewed seed input');
    error.code = 'input_output_conflict';
    throw error;
  }
  if (resolvedUsProductSlugMap && resolvedOutput === resolvedUsProductSlugMap) {
    const error = new Error('Nintendo discovery output must not replace its US product slug map');
    error.code = 'slug_map_output_conflict';
    throw error;
  }
  return {
    inputPath: resolvedInput,
    outputPath: resolvedOutput,
    usProductSlugMapPath: resolvedUsProductSlugMap,
  };
}

export async function runDiscoverNsuid({ args = process.argv.slice(2), now = new Date() } = {}) {
  const options = parseDiscoverNsuidArgs(args);
  const safePaths = assertSafeDiscoveryPaths({
    inputPath: options.inputPath,
    outputPath: options.outputPath ?? DEFAULT_OUTPUT_PATH,
    usProductSlugMapPath: options.usProductSlugMapPath,
  });
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const usSlugMap = loadNintendoUsSlugMap(safePaths.usProductSlugMapPath);
  let candidates;
  let inputDigest;
  if (options.inputPath) {
    const input = JSON.parse(fs.readFileSync(safePaths.inputPath, 'utf8'));
    validateNintendoSeedDocument(input);
    candidates = input.candidates.map((candidate) => ({
      ...candidate,
      nintendoUsSlugHint: usSlugMap.mappings.get(candidate.slug)
        ?? candidate.nintendoUsSlugHint
        ?? null,
    }));
    inputDigest = input.documentDigest;
  } else {
    candidates = catalogTargets(catalog, options.slugs, usSlugMap.mappings);
    inputDigest = sha256Digest({ kind: 'catalog-compatibility', candidates });
  }
  if (usSlugMap.documentDigest) {
    inputDigest = sha256Digest({ candidateInputDigest: inputDigest, usProductSlugMapDigest: usSlugMap.documentDigest });
  }

  const releaseRunLock = acquireNintendoUsDiscoveryRun();
  try {
    const collectedAt = new Date(now).toISOString();
    setRequestBudget(requestBudgetFor(1 + candidates.length * 9));
    let usSitemap = null;
    let usSitemapDigest = null;
    let usSitemapError = null;
    try {
      const sitemapResponse = await fetchText(US_SITEMAP_URL, {
        label: 'Nintendo US official store sitemap',
        attempts: 2,
      });
      if (new URL(sitemapResponse.finalUrl).pathname !== '/us/store/sitemap.xml') {
        throw new Error('Nintendo US store sitemap redirected to an unexpected path');
      }
      usSitemap = parseNintendoUsStoreSitemap(sitemapResponse.text);
      if (usSitemap.size === 0) throw new Error('Nintendo US store sitemap contains no canonical products');
      usSitemapDigest = sha256Digest({ text: sitemapResponse.text, finalUrl: sitemapResponse.finalUrl });
    } catch (error) {
      usSitemapError = error;
    }
    const americas = circuitWrapper('americas', async (candidate) => {
      if (usSitemapError) {
        const error = new Error(`Nintendo US sitemap failed: ${usSitemapError.message}`);
        error.code = 'sitemap_unavailable';
        throw error;
      }
      return discoverAmericasOfficial(candidate, {
        collectedAt,
        sitemap: usSitemap,
        sitemapDigest: usSitemapDigest,
      });
    }, collectedAt);
    const europe = circuitWrapper('europe', discoverEuropeOfficial, collectedAt);
    const japan = circuitWrapper('japan', discoverJapanOfficial, collectedAt);
    const suggestions = await discoverNintendoCandidates(candidates, {
      discoverAmericas: americas.run,
      discoverEurope: europe.run,
      discoverJapan: japan.run,
      existingNsuids: catalogNsuidOwners(catalog),
      afterEach: async () => {
        if (candidates.length > 1) await sleep(DISCOVERY_PAUSE_MS);
      },
    });
    const document = createNintendoSuggestionDocument({
      generatedAt: collectedAt,
      inputDigest,
      candidates: suggestions,
    });

    for (const candidate of suggestions) {
      const ids = ['americas', 'europe', 'japan']
        .map((group) => candidate.nsuids[group] ? `${group.slice(0, 2).toUpperCase()}=${candidate.nsuids[group]}` : null)
        .filter(Boolean)
        .join(' ');
      console.log(`${candidate.slug.padEnd(34)} ${candidate.verifyStatus.padEnd(9)} ${ids || '—'} ${candidate.exceptionReasons.join(',')}`);
    }
    if (options.apply) {
      atomicWriteJson(safePaths.outputPath, document);
      console.log(`\n${suggestions.length} reviewed suggestion(s) written to ${safePaths.outputPath}; catalog unchanged.`);
    } else {
      console.log('\nDry run: suggestions/catalog unchanged. US product pages were sitemap-located, verified and persistently budgeted.');
    }
    return {
      document,
      sourceStats: { americas: americas.stats, europe: europe.stats, japan: japan.stats },
      outputPath: options.apply ? safePaths.outputPath : null,
    };
  } finally {
    releaseRunLock();
  }
}

async function main() {
  await runDiscoverNsuid();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}

export { stableNintendoCandidateId };
