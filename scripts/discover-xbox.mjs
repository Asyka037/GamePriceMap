/**
 * Xbox Wave 2 mapping discovery. Only catalog-declared, unmapped Xbox games
 * are eligible. Official autosuggest is a locator; every candidate must then
 * pass the independent standard/full/public-paid US product fingerprint.
 *
 * `--apply` atomically writes one sealed suggestion artifact and never edits
 * catalog.json. A two-natural-week stability ledger is required before any
 * discovery request is made.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  chunk,
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  sleep,
} from './lib/http.mjs';
import {
  buildXboxMappingCandidate,
  createXboxSuggestionDocument,
  validateXboxStabilityLedger,
  XBOX_MAPPING_MAX_CANDIDATES,
} from './lib/xbox-mappings.mjs';
import { writeXboxSuggestionDocument } from './lib/xbox-suggestion-output.mjs';
import {
  parseXboxProduct,
  parseXboxSuggestion,
  XBOX_BATCH_SIZE,
  xboxProductsUrl,
  xboxSuggestUrl,
} from './lib/xbox.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'catalog.json');
const STABILITY_PATH = path.join(ROOT, 'data', 'seeds', 'xbox-stability.json');
const REQUEST_DELAY_MS = 900;

export function parseDiscoverXboxArgs(argv) {
  const options = { apply: false, maxItems: XBOX_MAPPING_MAX_CANDIDATES, slugs: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--apply') {
      options.apply = true;
    } else if (value === '--max-items') {
      const raw = argv[++index];
      if (raw == null) throw new Error('--max-items requires a value');
      options.maxItems = Number(raw);
    } else if (value.startsWith('--max-items=')) {
      options.maxItems = Number(value.slice('--max-items='.length));
    } else if (value.startsWith('--')) {
      throw new Error(`Unknown option: ${value}`);
    } else {
      options.slugs.push(value);
    }
  }
  if (!Number.isSafeInteger(options.maxItems)
    || options.maxItems < 1
    || options.maxItems > XBOX_MAPPING_MAX_CANDIDATES) {
    throw new Error(`--max-items must be an integer from 1 to ${XBOX_MAPPING_MAX_CANDIDATES}`);
  }
  if (new Set(options.slugs).size !== options.slugs.length) throw new Error('Duplicate Xbox discovery slug');
  if (options.slugs.length > options.maxItems) {
    throw new Error(`Xbox discovery accepts at most ${options.maxItems} explicit slugs`);
  }
  return options;
}

export function selectXboxDiscoveryTargets(catalog, { slugs = [], maxItems = XBOX_MAPPING_MAX_CANDIDATES } = {}) {
  if (!catalog || !Array.isArray(catalog.games)) throw new Error('catalog.games is required');
  const games = new Map(catalog.games.map((game) => [game.slug, game]));
  const eligible = (game) => game?.platforms?.includes('xbox') && !game.xboxBigId;
  if (slugs.length) {
    return slugs.map((slug) => {
      const game = games.get(slug);
      if (!game) throw new Error(`Xbox discovery slug is absent from catalog: ${slug}`);
      if (!game.platforms?.includes('xbox')) throw new Error(`Xbox discovery slug is not declared for Xbox: ${slug}`);
      if (game.xboxBigId) throw new Error(`Xbox discovery slug is already mapped: ${slug}`);
      return { slug: game.slug, title: game.title };
    });
  }
  return catalog.games.filter(eligible).slice(0, maxItems).map(({ slug, title }) => ({ slug, title }));
}

function failureMap(entries) {
  return new Map(entries.map((entry) => [entry.slug, null]));
}

function setFailure(failures, slug, reason) {
  if (!failures.get(slug)) failures.set(slug, reason);
}

export async function discoverXboxMappings({
  entries,
  stabilityEvidence,
  knownBigIds = [],
  now = new Date(),
  fetchJsonImpl = fetchJson,
  wait = sleep,
  requestDelayMs = REQUEST_DELAY_MS,
} = {}) {
  const observedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observedAt.valueOf())) throw new Error('Xbox discovery now is invalid');
  validateXboxStabilityLedger(stabilityEvidence, { now: observedAt.valueOf() });
  if (!Array.isArray(entries) || entries.length > XBOX_MAPPING_MAX_CANDIDATES) {
    throw new Error(`Xbox discovery accepts at most ${XBOX_MAPPING_MAX_CANDIDATES} entries`);
  }
  const slugs = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.slug !== 'string' || typeof entry.title !== 'string' || !entry.title.trim()) {
      throw new Error('Xbox discovery entries require slug and title');
    }
    if (slugs.has(entry.slug)) throw new Error(`Duplicate Xbox discovery entry: ${entry.slug}`);
    slugs.add(entry.slug);
  }

  const failures = failureMap(entries);
  const located = [];
  for (const entry of entries) {
    const sourceUrl = xboxSuggestUrl(entry.title);
    try {
      const response = await fetchJsonImpl(sourceUrl, { label: `xbox suggest ${entry.slug}` });
      const suggestion = parseXboxSuggestion(response, entry.title);
      if (!suggestion) {
        setFailure(failures, entry.slug, 'no_unique_exact_autosuggest_match');
      } else {
        located.push({ entry, sourceUrl, response, suggestion });
      }
    } catch {
      setFailure(failures, entry.slug, 'autosuggest_request_failed');
    }
    if (requestDelayMs > 0) await wait(requestDelayMs);
  }

  const owners = new Map();
  for (const result of located) {
    const list = owners.get(result.suggestion.bigId) ?? [];
    list.push(result.entry.slug);
    owners.set(result.suggestion.bigId, list);
  }
  const existing = new Set([...knownBigIds].map((id) => String(id).toUpperCase()));
  for (const result of located) {
    if (owners.get(result.suggestion.bigId).length > 1) {
      setFailure(failures, result.entry.slug, 'duplicate_big_id_in_batch');
    } else if (existing.has(result.suggestion.bigId)) {
      setFailure(failures, result.entry.slug, 'big_id_already_in_catalog');
    }
  }

  const candidates = [];
  const productTargets = located.filter(({ entry }) => !failures.get(entry.slug));
  for (const batch of chunk(productTargets, XBOX_BATCH_SIZE)) {
    const productIds = batch.map(({ suggestion }) => suggestion.bigId);
    const productsUrl = xboxProductsUrl(productIds);
    let productsResponse;
    try {
      productsResponse = await fetchJsonImpl(productsUrl, { label: `xbox products (${batch.length})` });
    } catch {
      for (const { entry } of batch) setFailure(failures, entry.slug, 'products_request_failed');
      if (requestDelayMs > 0) await wait(requestDelayMs);
      continue;
    }
    for (const locatedResult of batch) {
      const { entry, sourceUrl, response, suggestion } = locatedResult;
      const product = parseXboxProduct(productsResponse, {
        bigId: suggestion.bigId,
        expectedTitle: entry.title,
        edition: 'standard',
      }, observedAt.valueOf());
      if (!product) {
        setFailure(failures, entry.slug, 'product_standard_public_purchase_fingerprint_failed');
        continue;
      }
      try {
        candidates.push(buildXboxMappingCandidate({
          entry,
          suggestion,
          product,
          autosuggestUrl: sourceUrl,
          autosuggestResponse: response,
          productsUrl,
          productsResponse,
          observedAt,
        }));
      } catch {
        setFailure(failures, entry.slug, 'candidate_evidence_validation_failed');
      }
    }
    if (requestDelayMs > 0) await wait(requestDelayMs);
  }

  const failureList = entries
    .filter(({ slug }) => failures.get(slug))
    .map(({ slug }) => ({ slug, reason: failures.get(slug) }));
  const document = createXboxSuggestionDocument({
    generatedAt: observedAt,
    stabilityEvidence,
    candidates,
    failures: failureList,
  });
  return { attempted: entries.length, candidates, failures: failureList, document };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseDiscoverXboxArgs(argv);
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const entries = selectXboxDiscoveryTargets(catalog, options);
  if (entries.length === 0) {
    console.log('No catalog-declared unmapped Xbox games matched.');
    return;
  }
  if (!fs.existsSync(STABILITY_PATH)) {
    throw new Error('Xbox Wave 2 requires data/seeds/xbox-stability.json with two natural-week successes');
  }
  const stabilityEvidence = JSON.parse(fs.readFileSync(STABILITY_PATH, 'utf8'));
  validateXboxStabilityLedger(stabilityEvidence);
  const knownBigIds = catalog.games.map((game) => game.xboxBigId).filter(Boolean);
  const plannedRequests = entries.length + Math.ceil(entries.length / XBOX_BATCH_SIZE);
  setRequestBudget(requestBudgetFor(plannedRequests));
  const report = await discoverXboxMappings({ entries, stabilityEvidence, knownBigIds });
  for (const candidate of report.candidates) {
    console.log(`${candidate.slug.padEnd(36)} ${candidate.xboxBigId} · $${candidate.evidence.publicUsOffer.amount}`);
  }
  for (const failure of report.failures) console.warn(`${failure.slug.padEnd(36)} — ${failure.reason}`);
  console.log(`Verified Xbox candidates: ${report.candidates.length}/${report.attempted}`);
  if (!options.apply) {
    console.log('Dry run. Re-run with --apply to atomically write the sealed suggestion document.');
    return;
  }
  const output = writeXboxSuggestionDocument(report.document);
  console.log(`${report.candidates.length} sealed candidate(s) written to ${path.relative(ROOT, output)}; catalog unchanged.`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
