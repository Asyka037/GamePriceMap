#!/usr/bin/env node
/**
 * Nintendo candidate discovery.
 *
 * Americas identity is manual-only: this command never requests, guesses, or
 * probes Nintendo US product pages. Automatic discovery is limited to the
 * official Europe and Japan search/price endpoints, with a process request
 * budget and fail-closed source circuits.
 *
 * Usage:
 *   node scripts/discover-nsuid.mjs                         # catalog compatibility dry run
 *   node scripts/discover-nsuid.mjs slug ...                # selected catalog slugs
 *   node scripts/discover-nsuid.mjs --input seeds.json      # external reviewed candidates
 *   node scripts/discover-nsuid.mjs --apply --input seeds.json [--output file]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Digest } from './lib/candidate-evidence.mjs';
import { indexPricesById, parsePriceEntry, priceUrl } from './lib/eshop.mjs';
import {
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  shouldTripCircuit,
  sleep,
} from './lib/http.mjs';
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
const DISCOVERY_PAUSE_MS = 1500;

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

function catalogTargets(catalog, slugs) {
  const requested = new Set(slugs);
  const candidates = catalog.games.filter((game) => {
    const switchGame = game.platforms?.some((platform) => platform === 'switch' || platform === 'switch-2');
    const hasNintendoMapping = Object.values(game.nsuids ?? {}).some(Boolean);
    return switchGame && !hasNintendoMapping && (requested.size === 0 || requested.has(game.slug));
  });
  if (requested.size > 0) {
    const found = new Set(candidates.map((candidate) => candidate.slug));
    const missing = [...requested].filter((slug) => !found.has(slug));
    if (missing.length > 0) throw new Error(`catalog slugs are absent, non-Switch, or already mapped: ${missing.join(', ')}`);
  }
  return candidates.map((game) => ({
    candidateId: null,
    slug: game.slug,
    title: game.title,
    platforms: [...game.platforms],
    publisher: null,
    developer: null,
    knownNsuids: null,
    seedEvidence: [],
    manualUsEvidence: null,
    exclusivityEvidence: null,
    // Catalog membership is not cross-platform evidence. An explicit,
    // digest-bound title and organization match remains required.
    steamMatchEvidence: null,
    popularityEvidence: [],
  }));
}

function catalogNsuidSet(catalog) {
  return new Set(catalog.games.flatMap((game) => Object.values(game.nsuids ?? {}).filter(Boolean).map(String)));
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
      wrapped.code = `${source}_network_error`;
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

export function assertSafeDiscoveryPaths({ inputPath = null, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
  const resolvedInput = inputPath ? path.resolve(process.cwd(), inputPath) : null;
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
  return { inputPath: resolvedInput, outputPath: resolvedOutput };
}

export async function runDiscoverNsuid({ args = process.argv.slice(2), now = new Date() } = {}) {
  const options = parseDiscoverNsuidArgs(args);
  const safePaths = assertSafeDiscoveryPaths({
    inputPath: options.inputPath,
    outputPath: options.outputPath ?? DEFAULT_OUTPUT_PATH,
  });
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  let candidates;
  let inputDigest;
  if (options.inputPath) {
    const input = JSON.parse(fs.readFileSync(safePaths.inputPath, 'utf8'));
    validateNintendoSeedDocument(input);
    candidates = input.candidates;
    inputDigest = input.documentDigest;
  } else {
    candidates = catalogTargets(catalog, options.slugs);
    inputDigest = sha256Digest({ kind: 'catalog-compatibility', candidates });
  }

  const collectedAt = new Date(now).toISOString();
  setRequestBudget(requestBudgetFor(candidates.length * 3));
  const europe = circuitWrapper('europe', discoverEuropeOfficial, collectedAt);
  const japan = circuitWrapper('japan', discoverJapanOfficial, collectedAt);
  const suggestions = await discoverNintendoCandidates(candidates, {
    discoverEurope: europe.run,
    discoverJapan: japan.run,
    existingNsuids: catalogNsuidSet(catalog),
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
    console.log('\nDry run: no files written. Americas identity requires manualUsEvidence; no US page was requested or guessed.');
  }
  return {
    document,
    sourceStats: { europe: europe.stats, japan: japan.stats },
    outputPath: options.apply ? safePaths.outputPath : null,
  };
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
