#!/usr/bin/env node
/**
 * Discover official Nintendo Europe identities for catalog games that already
 * have Steam mappings but no Switch platform/NSUID. The command never mutates
 * catalog.json. Default mode is dry-run; --apply atomically writes a seed
 * draft, an audit report, and the private response cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256Digest } from './lib/candidate-evidence.mjs';
import {
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  shouldTripCircuit,
  sleep,
} from './lib/http.mjs';
import { atomicWriteFiles } from './lib/import-state.mjs';
import {
  cacheEntryForTarget,
  catalogNintendoNsuidOwners,
  createEmptyNintendoEnrichmentCache,
  createNintendoEnrichmentDraft,
  createNintendoEnrichmentDraftCandidate,
  createNintendoEnrichmentReport,
  evaluateNintendoEuropeEnrichment,
  guardNintendoEnrichmentBatchCollisions,
  nintendoEuropeEnrichmentUrl,
  projectNintendoEuropeSolrResponse,
  selectNintendoEnrichmentTargets,
  validateNintendoEnrichmentCache,
  withNintendoEnrichmentCacheEntry,
} from './lib/nintendo-enrichment-seeds.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const DEFAULT_OUTPUT_PATH = path.join(ROOT, 'private', 'game-library', 'nintendo', 'enrichment-seed-draft.json');
const DEFAULT_REPORT_PATH = path.join(ROOT, 'private', 'game-library', 'nintendo', 'enrichment-seed-report.json');
const DEFAULT_CACHE_PATH = path.join(ROOT, 'private', 'game-library', 'candidate-cache', 'nintendo', 'eu-solr-enrichment.json');
const REQUEST_INTERVAL_MS = 1500;

function integer(value, label) {
  if (!/^\d+$/u.test(String(value ?? ''))) throw new Error(`${label} requires an integer`);
  return Number(value);
}

export function parseNintendoEnrichmentArgs(args) {
  const options = {
    apply: false,
    catalogPath: DEFAULT_CATALOG_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    reportPath: DEFAULT_REPORT_PATH,
    cachePath: DEFAULT_CACHE_PATH,
    batchSize: 25,
    startAfter: null,
  };
  const seen = new Set();
  const valued = new Map([
    ['--catalog', 'catalogPath'],
    ['--output', 'outputPath'],
    ['--report', 'reportPath'],
    ['--cache', 'cachePath'],
    ['--batch-size', 'batchSize'],
    ['--start-after', 'startAfter'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split('=', 2);
    if (flag === '--apply') {
      if (inline !== undefined || seen.has(flag)) throw new Error('--apply may only be provided once without a value');
      seen.add(flag);
      options.apply = true;
      continue;
    }
    const key = valued.get(flag);
    if (!key) throw new Error(`unknown argument: ${args[index]}`);
    if (seen.has(flag)) throw new Error(`${flag} may only be provided once`);
    seen.add(flag);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options[key] = flag === '--batch-size' ? integer(value, flag) : value;
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

function readCache(filePath) {
  try {
    return validateNintendoEnrichmentCache(readJson(filePath, 'Nintendo enrichment cache'));
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyNintendoEnrichmentCache();
    throw error;
  }
}

function safePaths(options) {
  const paths = Object.fromEntries(['catalogPath', 'outputPath', 'reportPath', 'cachePath']
    .map((key) => [key, path.resolve(options[key])]));
  const destinations = [paths.outputPath, paths.reportPath, paths.cachePath];
  if (new Set(destinations).size !== destinations.length) throw new Error('output, report, and cache paths must be different');
  if (destinations.includes(paths.catalogPath)) throw new Error('enrichment outputs must not replace catalog.json');
  return paths;
}

function errorAudit(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : null,
    status: Number.isInteger(error?.status) ? error.status : null,
    budgetExhausted: error?.budget === true,
  };
}

function resultLine(result) {
  if (result.evaluation.status === 'matched') {
    const candidate = result.evaluation.candidate;
    return `${result.target.slug.padEnd(38)} matched   ${candidate.generation} ${candidate.nsuid} ${result.cacheStatus}`;
  }
  return `${result.target.slug.padEnd(38)} rejected  ${result.evaluation.reason} ${result.cacheStatus}`;
}

export async function runNintendoEnrichmentSeeds({
  args = process.argv.slice(2),
  now = new Date(),
  fetchJsonImpl = fetchJson,
  sleepImpl = sleep,
  setRequestBudgetImpl = setRequestBudget,
} = {}) {
  const options = parseNintendoEnrichmentArgs(args);
  const paths = safePaths(options);
  const collectedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const nowMs = Date.parse(collectedAt);
  const catalog = readJson(paths.catalogPath, 'catalog');
  const catalogBefore = fs.readFileSync(paths.catalogPath);
  const selection = selectNintendoEnrichmentTargets(catalog, {
    batchSize: options.batchSize,
    startAfter: options.startAfter,
  });
  const existingNsuids = catalogNintendoNsuidOwners(catalog);
  let cache = readCache(paths.cachePath);
  const rawResults = [];
  const requestStats = {
    planned: 0,
    attempted: 0,
    failed: 0,
    cacheHits: 0,
    circuitOpen: false,
  };

  const cached = new Map();
  for (const target of selection.targets) {
    const entry = cacheEntryForTarget(cache, target, { now: nowMs });
    if (entry) cached.set(target.slug, entry);
    else requestStats.planned += 1;
  }
  setRequestBudgetImpl(requestBudgetFor(requestStats.planned));

  let requestedOnce = false;
  for (const target of selection.targets) {
    const sourceUrl = nintendoEuropeEnrichmentUrl(target.title);
    let entry = cached.get(target.slug) ?? null;
    if (entry) {
      requestStats.cacheHits += 1;
    } else if (requestStats.circuitOpen) {
      rawResults.push({
        target,
        cacheStatus: 'not_requested',
        sourceUrl,
        sourceDigest: null,
        observedAt: collectedAt,
        evaluation: {
          status: 'rejected',
          reason: 'eu_source_circuit_open',
          candidate: null,
          audit: { documentsExamined: 0, exactTitleDocuments: 0, rejectedByReason: {} },
        },
      });
      continue;
    } else {
      if (requestedOnce) await sleepImpl(REQUEST_INTERVAL_MS);
      requestedOnce = true;
      requestStats.attempted += 1;
      try {
        const body = await fetchJsonImpl(sourceUrl, {
          label: `Nintendo EU enrichment ${target.slug}`,
          attempts: 2,
        });
        const payload = projectNintendoEuropeSolrResponse(body);
        cache = withNintendoEnrichmentCacheEntry(cache, target, {
          sourceUrl,
          collectedAt,
          payload,
        });
        entry = cache.entries[target.slug];
      } catch (error) {
        requestStats.failed += 1;
        rawResults.push({
          target,
          cacheStatus: 'network_error',
          sourceUrl,
          sourceDigest: null,
          observedAt: collectedAt,
          evaluation: {
            status: 'rejected',
            reason: 'eu_source_error',
            candidate: null,
            audit: {
              documentsExamined: 0,
              exactTitleDocuments: 0,
              rejectedByReason: {},
              sourceError: errorAudit(error),
            },
          },
        });
        requestStats.circuitOpen = shouldTripCircuit(requestStats.attempted, requestStats.failed);
        continue;
      }
    }

    rawResults.push({
      target,
      cacheStatus: cached.has(target.slug) ? 'cache_hit' : 'fetched',
      sourceUrl: entry.sourceUrl,
      sourceDigest: entry.sourceDigest,
      observedAt: entry.collectedAt,
      evaluation: evaluateNintendoEuropeEnrichment(entry.payload, target, {
        now: nowMs,
        existingNsuids,
      }),
    });
  }

  const results = guardNintendoEnrichmentBatchCollisions(rawResults);
  const candidates = results
    .filter((result) => result.evaluation.status === 'matched')
    .map((result) => createNintendoEnrichmentDraftCandidate(result.target, result.evaluation.candidate, {
      sourceUrl: result.sourceUrl,
      sourceDigest: result.sourceDigest,
      observedAt: result.observedAt,
    }));
  const draft = createNintendoEnrichmentDraft({ generatedAt: collectedAt, candidates });
  const accepted = results
    .filter((result) => result.evaluation.status === 'matched')
    .map((result) => ({
      slug: result.target.slug,
      candidateId: `ns:${result.evaluation.candidate.nsuid}`,
      nsuid: result.evaluation.candidate.nsuid,
      generation: result.evaluation.candidate.generation,
      sourceUrl: result.sourceUrl,
      sourceDigest: result.sourceDigest,
      cacheStatus: result.cacheStatus,
    }));
  const rejected = results
    .filter((result) => result.evaluation.status !== 'matched')
    .map((result) => ({
      slug: result.target.slug,
      title: result.target.title,
      reason: result.evaluation.reason,
      sourceUrl: result.sourceUrl,
      cacheStatus: result.cacheStatus,
      audit: result.evaluation.audit,
      ...(result.evaluation.matches ? { matches: result.evaluation.matches } : {}),
      ...(result.evaluation.conflictingNsuid ? { conflictingNsuid: result.evaluation.conflictingNsuid } : {}),
      ...(result.evaluation.conflictingSlugs ? { conflictingSlugs: result.evaluation.conflictingSlugs } : {}),
      ...(result.evaluation.catalogOwner ? { catalogOwner: result.evaluation.catalogOwner } : {}),
    }));
  const report = createNintendoEnrichmentReport({
    generatedAt: collectedAt,
    catalogDigest: sha256Digest(catalog),
    selection: {
      batchSize: options.batchSize,
      startAfter: options.startAfter,
      totalEligible: selection.totalEligible,
      remainingFromCursor: selection.remainingFromCursor,
      selectedCount: selection.targets.length,
      nextCursor: selection.nextCursor,
      complete: selection.complete,
    },
    requests: requestStats,
    seedDraft: {
      candidateCount: candidates.length,
      written: options.apply && candidates.length > 0,
      documentDigest: sha256Digest(draft),
    },
    accepted,
    rejected,
  });

  for (const result of results) console.log(resultLine(result));
  console.log(`\nselected=${selection.targets.length} accepted=${accepted.length} rejected=${rejected.length} cache=${requestStats.cacheHits} requests=${requestStats.attempted} failures=${requestStats.failed}`);
  console.log(`next cursor: ${selection.nextCursor ?? '(complete)'}`);

  let writtenPaths = [];
  if (options.apply) {
    const files = [
      { path: paths.reportPath, content: `${JSON.stringify(report, null, 2)}\n` },
      { path: paths.cachePath, content: `${JSON.stringify(cache, null, 2)}\n` },
    ];
    if (candidates.length > 0) files.unshift({
      path: paths.outputPath,
      content: `${JSON.stringify(draft, null, 2)}\n`,
    });
    atomicWriteFiles(files);
    writtenPaths = files.map((file) => path.resolve(file.path));
    console.log(candidates.length > 0
      ? `wrote seed draft, audit report, and cache; catalog unchanged`
      : `no accepted candidates; wrote audit report and cache only; catalog unchanged`);
  } else {
    console.log('Dry run: no files written; catalog unchanged.');
  }
  if (!fs.readFileSync(paths.catalogPath).equals(catalogBefore)) {
    throw new Error('catalog changed during Nintendo enrichment seed generation');
  }
  return { options, selection, draft, report, cache, results, writtenPaths };
}

async function main() {
  await runNintendoEnrichmentSeeds();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
