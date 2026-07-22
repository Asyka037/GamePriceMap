import {
  assertDocumentDigest,
  sealEvidenceDocument,
  sha256Digest,
} from './candidate-evidence.mjs';
import { normTitle } from './match.mjs';
import {
  validXboxBigId,
  xboxProductsUrl,
  xboxSuggestUrl,
} from './xbox.mjs';

export const XBOX_MAPPING_SUGGESTIONS_KIND = 'xbox-mapping-suggestions';
export const XBOX_MAPPING_CANDIDATE_KIND = 'xbox-mapping-candidate';
export const XBOX_STABILITY_LEDGER_KIND = 'xbox-weekly-stability';
export const XBOX_MAPPING_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const XBOX_MAPPING_MAX_CANDIDATES = 25;

const SCHEMA_VERSION = 1;
const SOURCE_KEY = 'xbox-us';
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

function exactTitle(left, right) {
  const a = normTitle(left);
  const b = normTitle(right);
  return Boolean(a && b && a === b);
}

function utcWeekKey(value) {
  const date = new Date(value);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const day = new Date(midnight).getUTCDay();
  const monday = midnight - ((day + 6) % 7) * 24 * 60 * 60 * 1000;
  return new Date(monday).toISOString().slice(0, 10);
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function validateStabilitySuccess(record, index) {
  if (!plainObject(record)) throw new Error(`Xbox stability successes[${index}] must be an object`);
  const lastSuccessAt = isoTimestamp(record.lastSuccessAt, `successes[${index}].lastSuccessAt`);
  const expected = nonNegativeInteger(record.expected, `successes[${index}].expected`);
  const changed = nonNegativeInteger(record.changed, `successes[${index}].changed`);
  const unchanged = nonNegativeInteger(record.unchanged, `successes[${index}].unchanged`);
  const failedProducts = nonNegativeInteger(record.failedProducts, `successes[${index}].failedProducts`);
  const failedRequests = nonNegativeInteger(record.failedRequests, `successes[${index}].failedRequests`);
  if (expected <= 0 || changed + unchanged !== expected || failedProducts !== 0 || failedRequests !== 0) {
    throw new Error(`Xbox stability successes[${index}] is not a complete zero-failure run`);
  }
  return { lastSuccessAt, expected, changed, unchanged, failedProducts, failedRequests };
}

/**
 * Validate the immutable audit ledger that opens Wave 2. A qualifying ledger
 * contains complete zero-failure observations from at least two distinct UTC
 * calendar weeks, with the first and last observations at least six days apart.
 */
export function validateXboxStabilityLedger(document, { now = Date.now() } = {}) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== SCHEMA_VERSION
    || document.kind !== XBOX_STABILITY_LEDGER_KIND
    || document.sourceKey !== SOURCE_KEY) {
    throw new Error('unsupported Xbox stability ledger');
  }
  const generatedAt = isoTimestamp(document.generatedAt, 'stability.generatedAt');
  if (Date.parse(generatedAt) > now) throw new Error('Xbox stability ledger is from the future');
  if (!Array.isArray(document.successes) || document.successes.length < 2 || document.successes.length > 52) {
    throw new Error('Xbox stability ledger requires 2-52 successful weekly runs');
  }
  const successes = document.successes.map(validateStabilitySuccess);
  const seenWeeks = new Set();
  let previous = -Infinity;
  for (const record of successes) {
    const timestamp = Date.parse(record.lastSuccessAt);
    if (timestamp <= previous) throw new Error('Xbox stability successes must be strictly chronological');
    if (timestamp > Date.parse(generatedAt) || timestamp > now) {
      throw new Error('Xbox stability success cannot be newer than its ledger');
    }
    const week = utcWeekKey(timestamp);
    if (seenWeeks.has(week)) throw new Error('Xbox stability ledger may contain only one success per UTC week');
    seenWeeks.add(week);
    previous = timestamp;
  }
  if (Date.parse(successes.at(-1).lastSuccessAt) - Date.parse(successes[0].lastSuccessAt) < SIX_DAYS_MS) {
    throw new Error('Xbox stability observations must be at least 6 days apart');
  }
  return { generatedAt, successes };
}

/** Test/tooling helper; production may seal the same fields after a real run. */
export function createXboxStabilityLedger({ generatedAt = new Date(), successes }) {
  const document = sealEvidenceDocument({
    schemaVersion: SCHEMA_VERSION,
    kind: XBOX_STABILITY_LEDGER_KIND,
    sourceKey: SOURCE_KEY,
    generatedAt: isoTimestamp(generatedAt, 'stability.generatedAt'),
    successes: (successes ?? []).map((record) => ({ ...record })),
  });
  validateXboxStabilityLedger(document, { now: Date.parse(document.generatedAt) });
  return document;
}

function parseAutosuggestUrl(value, candidate) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Xbox autosuggest evidence URL is invalid'); }
  const expected = new URL(xboxSuggestUrl(candidate.title));
  if (url.href !== expected.href || url.username || url.password || url.hash) {
    throw new Error('Xbox autosuggest evidence URL does not match the candidate');
  }
  return url.href;
}

function parseProductsUrl(value, candidate) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Xbox products evidence URL is invalid'); }
  if (url.origin !== 'https://displaycatalog.mp.microsoft.com'
    || url.pathname !== '/v7.0/products'
    || url.username
    || url.password
    || url.hash) {
    throw new Error('Xbox products evidence URL is not the official v7.0 endpoint');
  }
  const allowed = new Set(['bigIds', 'market', 'languages']);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
    || url.searchParams.get('market') !== 'US'
    || url.searchParams.get('languages') !== 'en-US') {
    throw new Error('Xbox products evidence URL is not a US lookup');
  }
  const ids = (url.searchParams.get('bigIds') ?? '').split(',');
  if (ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length
    || ids.some((id) => !validXboxBigId(id)) || !ids.includes(candidate.xboxBigId)) {
    throw new Error('Xbox products evidence URL does not bind the candidate BigID');
  }
  return url.href;
}

function validateOffer(offer) {
  if (!plainObject(offer)
    || offer.cc !== 'US'
    || offer.currency !== 'USD'
    || !(Number.isFinite(offer.amount) && offer.amount > 0)
    || (offer.list != null && (!(Number.isFinite(offer.list) && offer.list > offer.amount)
      || offer.discountPct !== Math.round((1 - offer.amount / offer.list) * 100)))
    || (offer.list == null && offer.discountPct != null)
    || (offer.saleEndsAt != null && !Number.isFinite(Date.parse(offer.saleEndsAt)))) {
    throw new Error('Xbox mapping candidate public US offer is invalid');
  }
  return offer;
}

function withoutEvidenceDigest(evidence) {
  const { evidenceDigest: _digest, ...payload } = evidence;
  return payload;
}

export function buildXboxMappingCandidate({
  entry,
  suggestion,
  product,
  autosuggestUrl,
  autosuggestResponse,
  productsUrl,
  productsResponse,
  observedAt = new Date(),
  evidenceTtlMs = XBOX_MAPPING_EVIDENCE_TTL_MS,
}) {
  if (!plainObject(entry) || !SLUG_RE.test(entry.slug ?? '') || typeof entry.title !== 'string' || !entry.title.trim()) {
    throw new Error('Xbox mapping candidate requires a declared catalog entry');
  }
  if (!suggestion || !product || suggestion.edition !== 'standard'
    || !validXboxBigId(suggestion.bigId)
    || suggestion.bigId !== String(product.bigId ?? suggestion.bigId).toUpperCase()
    || !exactTitle(suggestion.matchedTitle, entry.title)
    || !exactTitle(product.matchedTitle, entry.title)
    || !exactTitle(product.skuTitle, entry.title)) {
    throw new Error('Xbox mapping discovery/product/SKU identity does not match the catalog entry');
  }
  if (!plainObject(product.row)) throw new Error('Xbox mapping candidate lacks a public US offer');
  validateOffer(product.row);
  const observed = isoTimestamp(observedAt, 'evidence.observedAt');
  if (!(Number.isFinite(evidenceTtlMs) && evidenceTtlMs > 0 && evidenceTtlMs <= XBOX_MAPPING_EVIDENCE_TTL_MS)) {
    throw new Error('Xbox mapping evidence TTL is invalid');
  }
  const candidate = {
    schemaVersion: SCHEMA_VERSION,
    kind: XBOX_MAPPING_CANDIDATE_KIND,
    candidateId: `xbox:${suggestion.bigId}`,
    catalogAction: 'add_platform_mapping',
    slug: entry.slug,
    title: entry.title,
    xboxBigId: suggestion.bigId,
    xboxEdition: 'standard',
    platforms: ['xbox'],
  };
  const evidencePayload = {
    kind: 'xbox-official-product-verification',
    observedAt: observed,
    expiresAt: new Date(Date.parse(observed) + evidenceTtlMs).toISOString(),
    bigId: suggestion.bigId,
    edition: 'standard',
    discovery: {
      kind: 'xbox-official-autosuggest-result',
      sourceUrl: autosuggestUrl,
      queryTitle: entry.title,
      matchedTitle: suggestion.matchedTitle,
      responseDigest: sha256Digest(autosuggestResponse),
    },
    product: {
      kind: 'xbox-official-products-result',
      sourceUrl: productsUrl,
      matchedTitle: product.matchedTitle,
      skuTitle: product.skuTitle,
      skuId: product.skuId,
      responseDigest: sha256Digest(productsResponse),
    },
    gates: {
      productKind: 'Game',
      edition: 'standard',
      skuType: 'full',
      isTrial: false,
      isBundle: false,
      purchaseActionRequired: true,
    },
    publicUsOffer: { ...product.row },
  };
  parseAutosuggestUrl(autosuggestUrl, candidate);
  parseProductsUrl(productsUrl, candidate);
  const evidence = {
    ...evidencePayload,
    evidenceDigest: sha256Digest(evidencePayload),
  };
  candidate.evidence = evidence;
  candidate.evidenceDigest = evidence.evidenceDigest;
  validateXboxMappingCandidate(candidate, { now: Date.parse(observed) });
  return candidate;
}

export function validateXboxMappingCandidate(candidate, { now = Date.now(), allowExpired = false } = {}) {
  if (!plainObject(candidate)
    || candidate.schemaVersion !== SCHEMA_VERSION
    || candidate.kind !== XBOX_MAPPING_CANDIDATE_KIND
    || candidate.catalogAction !== 'add_platform_mapping'
    || !SLUG_RE.test(candidate.slug ?? '')
    || typeof candidate.title !== 'string'
    || !candidate.title.trim()
    || !validXboxBigId(candidate.xboxBigId)
    || candidate.candidateId !== `xbox:${candidate.xboxBigId}`
    || candidate.xboxEdition !== 'standard'
    || JSON.stringify(candidate.platforms) !== JSON.stringify(['xbox'])) {
    throw new Error('invalid Xbox mapping candidate identity');
  }
  const evidence = candidate.evidence;
  if (!plainObject(evidence)
    || evidence.kind !== 'xbox-official-product-verification'
    || evidence.bigId !== candidate.xboxBigId
    || evidence.edition !== 'standard'
    || !DIGEST_RE.test(evidence.evidenceDigest ?? '')
    || evidence.evidenceDigest !== sha256Digest(withoutEvidenceDigest(evidence))
    || candidate.evidenceDigest !== evidence.evidenceDigest) {
    throw new Error('Xbox mapping candidate evidence digest or identity mismatch');
  }
  const discovery = evidence.discovery;
  const product = evidence.product;
  if (!plainObject(discovery)
    || discovery.kind !== 'xbox-official-autosuggest-result'
    || !exactTitle(discovery.queryTitle, candidate.title)
    || !exactTitle(discovery.matchedTitle, candidate.title)
    || !DIGEST_RE.test(discovery.responseDigest ?? '')) {
    throw new Error('Xbox autosuggest evidence is invalid');
  }
  parseAutosuggestUrl(discovery.sourceUrl, candidate);
  if (!plainObject(product)
    || product.kind !== 'xbox-official-products-result'
    || !exactTitle(product.matchedTitle, candidate.title)
    || !exactTitle(product.skuTitle, candidate.title)
    || typeof product.skuId !== 'string'
    || !product.skuId
    || !DIGEST_RE.test(product.responseDigest ?? '')) {
    throw new Error('Xbox product/SKU evidence is invalid');
  }
  parseProductsUrl(product.sourceUrl, candidate);
  const expectedGates = {
    productKind: 'Game',
    edition: 'standard',
    skuType: 'full',
    isTrial: false,
    isBundle: false,
    purchaseActionRequired: true,
  };
  if (JSON.stringify(evidence.gates) !== JSON.stringify(expectedGates)) {
    throw new Error('Xbox product exclusion gates are invalid');
  }
  validateOffer(evidence.publicUsOffer);
  const observedAt = isoTimestamp(evidence.observedAt, 'evidence.observedAt');
  const expiresAt = isoTimestamp(evidence.expiresAt, 'evidence.expiresAt');
  const ttl = Date.parse(expiresAt) - Date.parse(observedAt);
  if (Date.parse(observedAt) > now || ttl <= 0 || ttl > XBOX_MAPPING_EVIDENCE_TTL_MS) {
    throw new Error('Xbox mapping candidate evidence TTL is invalid');
  }
  if (!allowExpired && Date.parse(expiresAt) <= now) throw new Error('Xbox mapping candidate evidence expired');
  return candidate;
}

function validateCandidateSet(candidates, { now }) {
  if (!Array.isArray(candidates) || candidates.length > XBOX_MAPPING_MAX_CANDIDATES) {
    throw new Error(`Xbox suggestions support at most ${XBOX_MAPPING_MAX_CANDIDATES} candidates`);
  }
  const slugs = new Set();
  const ids = new Set();
  for (const candidate of candidates) {
    validateXboxMappingCandidate(candidate, { now });
    if (slugs.has(candidate.slug)) throw new Error(`duplicate Xbox candidate slug: ${candidate.slug}`);
    if (ids.has(candidate.xboxBigId)) throw new Error(`duplicate Xbox candidate BigID: ${candidate.xboxBigId}`);
    slugs.add(candidate.slug);
    ids.add(candidate.xboxBigId);
  }
}

function validateFailures(failures) {
  if (!Array.isArray(failures) || failures.length > XBOX_MAPPING_MAX_CANDIDATES) {
    throw new Error(`Xbox suggestions support at most ${XBOX_MAPPING_MAX_CANDIDATES} failures`);
  }
  const slugs = new Set();
  for (const failure of failures) {
    if (!plainObject(failure)
      || !SLUG_RE.test(failure.slug ?? '')
      || typeof failure.reason !== 'string'
      || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(failure.reason)) {
      throw new Error('Xbox suggestion failure is invalid');
    }
    if (slugs.has(failure.slug)) throw new Error(`duplicate Xbox failure slug: ${failure.slug}`);
    slugs.add(failure.slug);
  }
}

export function createXboxSuggestionDocument({
  generatedAt = new Date(),
  stabilityEvidence,
  candidates = [],
  failures = [],
}) {
  const generated = isoTimestamp(generatedAt, 'generatedAt');
  validateXboxStabilityLedger(stabilityEvidence, { now: Date.parse(generated) });
  validateCandidateSet(candidates, { now: Date.parse(generated) });
  validateFailures(failures);
  return sealEvidenceDocument({
    schemaVersion: SCHEMA_VERSION,
    kind: XBOX_MAPPING_SUGGESTIONS_KIND,
    discoveryMode: 'official-autosuggest-v1',
    generatedAt: generated,
    stabilityEvidence: structuredClone(stabilityEvidence),
    candidates: candidates.map((candidate) => structuredClone(candidate)),
    failures: failures.map((failure) => ({ ...failure })),
  });
}

export function validateXboxSuggestionDocument(document, { now = Date.now() } = {}) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== SCHEMA_VERSION
    || document.kind !== XBOX_MAPPING_SUGGESTIONS_KIND
    || document.discoveryMode !== 'official-autosuggest-v1') {
    throw new Error('unsupported Xbox mapping suggestions document');
  }
  const generatedAt = isoTimestamp(document.generatedAt, 'generatedAt');
  if (Date.parse(generatedAt) > now) throw new Error('Xbox suggestions are from the future');
  validateXboxStabilityLedger(document.stabilityEvidence, { now: Date.parse(generatedAt) });
  validateCandidateSet(document.candidates, { now });
  validateFailures(document.failures);
  return document;
}
