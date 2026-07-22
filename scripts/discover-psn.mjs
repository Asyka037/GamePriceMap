#!/usr/bin/env node
/**
 * Authorized, bounded PlayStation Store US mapping discovery.
 *
 * The official search page is only a locator. Every exact-title result is
 * independently opened and must pass the existing standard-game, terminal
 * URL, platform, public paid offer, Plus/trial exclusion, and title gates.
 * --apply writes sealed suggestions only; catalog.json is never edited here.
 *
 * Usage:
 *   PSN_AUTOMATION_AUTHORIZED=true node scripts/discover-psn.mjs
 *   PSN_AUTOMATION_AUTHORIZED=true node scripts/discover-psn.mjs --apply [slug ...]
 *   ... --input seeds.json --max-items 12
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Digest } from './lib/candidate-evidence.mjs';
import { setRequestBudget, shouldTripCircuit } from './lib/http.mjs';
import {
  acquirePsnUsRequestRun,
  fetchPsnUsPage,
  PSN_US_PAGE_DAILY_LIMIT,
} from './lib/psn-request-budget.mjs';
import {
  buildPsnMappingCandidate,
  createPsnSuggestionDocument,
  validatePsnManualInput,
} from './lib/psn-manual-mappings.mjs';
import { parsePsnProductPage } from './lib/psn.mjs';
import { parsePsnSearchPage } from './lib/psn-search.mjs';
import { PSN_SUGGESTION_PATH, writePsnSuggestionDocument } from './lib/psn-suggestion-output.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = path.join(ROOT, 'data', 'suggestions', 'psn-manual-input.json');
const POC_LIMIT = 20;
const MAX_EXACT_SEARCH_RESULTS = 4;

function positiveInteger(value, label, maximum) {
  if (!/^[1-9]\d*$/u.test(String(value ?? ''))) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new Error(`${label} must be at most ${maximum}`);
  return parsed;
}

export function parseDiscoverPsnArgs(argv) {
  const options = {
    apply: false,
    input: DEFAULT_INPUT,
    maxItems: POC_LIMIT,
    slugs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--input' || arg === '--max-items') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--input') options.input = path.resolve(value);
      else options.maxItems = positiveInteger(value, '--max-items', POC_LIMIT);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.slugs.push(arg);
    }
  }
  if (new Set(options.slugs).size !== options.slugs.length) throw new Error('Duplicate PSN discovery slug');
  return options;
}

export function psnSearchUrl(title) {
  const value = String(title ?? '').trim();
  if (!value) throw new Error('PSN search title is required');
  return `https://store.playstation.com/en-us/search/${encodeURIComponent(value)}`;
}

function failureReason(error, fallback = 'verification_error') {
  if (error?.budget) return 'daily_page_budget_exhausted';
  if (Number.isInteger(error?.status)) return `http_${error.status}`;
  return fallback;
}

function readyEntry(seed, match) {
  return {
    ...seed,
    status: 'ready',
    productId: match.productId,
    canonicalUrl: match.sourceUrl,
    selectedAt: null,
  };
}

function duplicateIdentityFailures(candidates) {
  const productCounts = new Map();
  const conceptCounts = new Map();
  for (const candidate of candidates) {
    productCounts.set(candidate.psnProductId, (productCounts.get(candidate.psnProductId) ?? 0) + 1);
    if (candidate.psnConceptId) {
      conceptCounts.set(candidate.psnConceptId, (conceptCounts.get(candidate.psnConceptId) ?? 0) + 1);
    }
  }
  const failures = [];
  const safe = [];
  for (const candidate of candidates) {
    const duplicateProduct = productCounts.get(candidate.psnProductId) > 1;
    const duplicateConcept = candidate.psnConceptId && conceptCounts.get(candidate.psnConceptId) > 1;
    if (duplicateProduct || duplicateConcept) {
      failures.push({
        slug: candidate.slug,
        reason: duplicateProduct ? 'duplicate_product_identity' : 'duplicate_concept_identity',
      });
    } else safe.push(candidate);
  }
  return { candidates: safe, failures };
}

export async function discoverPsnMappings({
  entries,
  fetchPage = fetchPsnUsPage,
  now = new Date(),
} = {}) {
  if (!Array.isArray(entries) || entries.length > POC_LIMIT) throw new Error(`PSN POC supports at most ${POC_LIMIT} entries`);
  const observed = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(observed.valueOf())) throw new Error('PSN discovery time is invalid');
  const candidates = [];
  const failures = [];
  let attempted = 0;

  for (const [entryIndex, entry] of entries.entries()) {
    if (shouldTripCircuit(attempted, failures.length)) {
      for (const skipped of entries.slice(entryIndex)) failures.push({ slug: skipped.slug, reason: 'circuit_open_unrequested' });
      break;
    }
    attempted += 1;
    const searchUrl = psnSearchUrl(entry.title);
    let searchResponse;
    try {
      searchResponse = await fetchPage(searchUrl, { label: `psn search ${entry.slug}` });
    } catch (error) {
      failures.push({ slug: entry.slug, reason: failureReason(error, 'search_request_failed') });
      continue;
    }
    const matches = parsePsnSearchPage(searchResponse.text, {
      expectedTitle: entry.title,
      finalUrl: searchResponse.finalUrl,
    });
    if (matches === null) {
      failures.push({ slug: entry.slug, reason: 'search_identity_or_structure_failed' });
      continue;
    }
    if (matches.length === 0) {
      failures.push({ slug: entry.slug, reason: 'no_exact_official_product' });
      continue;
    }
    if (matches.length > MAX_EXACT_SEARCH_RESULTS) {
      failures.push({ slug: entry.slug, reason: 'too_many_exact_search_results', count: matches.length });
      continue;
    }

    const verified = [];
    for (const match of matches) {
      let productResponse;
      try {
        productResponse = await fetchPage(match.sourceUrl, { label: `psn product ${entry.slug}` });
      } catch (error) {
        failures.push({
          slug: entry.slug,
          productId: match.productId,
          reason: failureReason(error, 'product_request_failed'),
        });
        continue;
      }
      const parsed = parsePsnProductPage(productResponse.text, {
        productId: match.productId,
        expectedTitle: entry.title,
        edition: 'standard',
        finalUrl: productResponse.finalUrl,
      }, observed.valueOf());
      if (!parsed) continue;
      verified.push({ match, parsed, productResponse });
    }
    if (verified.length === 0) {
      failures.push({ slug: entry.slug, reason: 'no_standard_public_paid_product' });
      continue;
    }
    if (verified.length > 1) {
      failures.push({
        slug: entry.slug,
        reason: 'ambiguous_standard_products',
        productIds: verified.map(({ match }) => match.productId).sort(),
      });
      continue;
    }

    const [{ match, parsed, productResponse }] = verified;
    try {
      candidates.push(buildPsnMappingCandidate(readyEntry(entry, match), parsed, {
        observedAt: observed,
        finalUrl: productResponse.finalUrl,
        discovery: {
          kind: 'psn-official-search-result',
          sourceUrl: searchUrl,
          finalUrl: searchResponse.finalUrl,
          queryTitle: entry.title,
          matchedTitle: match.matchedTitle,
          productId: match.productId,
          rank: match.index,
          pageDigest: sha256Digest({ text: searchResponse.text, finalUrl: searchResponse.finalUrl }),
        },
      }));
    } catch {
      failures.push({ slug: entry.slug, productId: match.productId, reason: 'candidate_evidence_failed' });
    }
  }
  const unique = duplicateIdentityFailures(candidates);
  return {
    candidates: unique.candidates,
    failures: [...failures, ...unique.failures],
    attempted,
  };
}

async function main() {
  const options = parseDiscoverPsnArgs(process.argv.slice(2));
  if (process.env.PSN_AUTOMATION_AUTHORIZED !== 'true') {
    throw new Error('PSN automation requires the explicit PSN_AUTOMATION_AUTHORIZED=true safety switch');
  }
  const input = JSON.parse(fs.readFileSync(options.input, 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
  const validated = validatePsnManualInput(input, { catalog });
  const requested = new Set(options.slugs);
  if (requested.size > 0) {
    const known = new Set(validated.entries.map((entry) => entry.slug));
    const unknown = [...requested].filter((slug) => !known.has(slug));
    if (unknown.length) throw new Error(`Unknown PSN discovery slug(s): ${unknown.join(', ')}`);
  }
  const selected = validated.entries
    .filter((entry) => requested.size === 0 || requested.has(entry.slug))
    .slice(0, options.maxItems);
  const selectedSlugs = new Set(selected.map((entry) => entry.slug));
  const pending = validated.entries.filter((entry) => !selectedSlugs.has(entry.slug)).map((entry) => entry.slug);
  if (selected.length === 0) {
    console.log('No unmapped PSN POC entries selected.');
    return;
  }

  setRequestBudget(PSN_US_PAGE_DAILY_LIMIT);
  const release = acquirePsnUsRequestRun();
  let report;
  try {
    report = await discoverPsnMappings({ entries: selected });
  } finally {
    release();
  }
  for (const candidate of report.candidates) {
    console.log(`${candidate.slug.padEnd(36)} ${candidate.psnProductId} · ${candidate.platforms.join('+')}`);
  }
  for (const failure of report.failures) console.warn(`  ${failure.slug}: ${failure.reason}`);
  const document = createPsnSuggestionDocument({
    generatedAt: new Date(),
    candidates: report.candidates,
    pending,
    failures: report.failures,
    discoveryMode: 'official-search-v1',
  });
  console.log(`Verified PSN search candidates: ${report.candidates.length}/${selected.length}; failures: ${report.failures.length}`);
  if (!options.apply) {
    console.log('Dry run. Re-run with --apply to write sealed suggestions; catalog remains unchanged.');
    return;
  }
  writePsnSuggestionDocument(document);
  console.log(`${report.candidates.length} candidate(s) written to ${path.relative(ROOT, PSN_SUGGESTION_PATH)}; catalog unchanged.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  });
}
