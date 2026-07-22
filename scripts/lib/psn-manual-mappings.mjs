/**
 * Auditable manual-input path for PSN mappings.
 *
 * A manual official-URL fallback remains available, while the separately
 * authorized bounded search pipeline can attach machine discovery provenance
 * before this module seals the same product-page evidence contract.
 */
import { assertDocumentDigest, sealEvidenceDocument, sha256Digest } from './candidate-evidence.mjs';
import { normTitle } from './match.mjs';
import { psnProductUrl, validPsnProductId } from './psn.mjs';

export const PSN_MANUAL_INPUT_SCHEMA_VERSION = 1;
export const PSN_MANUAL_INPUT_KIND = 'psn-manual-mapping-input';
export const PSN_MAPPING_CANDIDATE_KIND = 'psn-mapping-candidate';
export const PSN_MAPPING_SUGGESTIONS_KIND = 'psn-mapping-suggestions';
export const PSN_MAPPING_EVIDENCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PSN_MANUAL_MIN_ENTRIES = 10;
export const PSN_MANUAL_MAX_ENTRIES = 20;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const ENTRY_KEYS = new Set(['slug', 'title', 'productUrl', 'selectedAt', 'note']);
const DISCOVERY_MODES = new Set(['manual-official-url', 'official-search-v1']);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isoTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp${nullable ? ' or null' : ''}`);
  }
  return new Date(value).toISOString();
}

function exactCatalogTitle(left, right) {
  const a = normTitle(left);
  const b = normTitle(right);
  return Boolean(a && b && a === b);
}

function officialSearchTerm(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PSN discovery URL must be absolute');
  }
  if (url.origin !== 'https://store.playstation.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('PSN discovery URL must be a clean official Store search URL');
  }
  const prefix = '/en-us/search/';
  if (!url.pathname.startsWith(prefix)) throw new Error('PSN discovery URL must use the en-us search surface');
  try {
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    throw new Error('PSN discovery URL has malformed encoding');
  }
}

function validateDiscoveryEvidence(discovery, candidate) {
  if (!plainObject(discovery) || discovery.kind !== 'psn-official-search-result') {
    throw new Error('PSN candidate discovery evidence is invalid');
  }
  const sourceTerm = officialSearchTerm(discovery.sourceUrl);
  const finalTerm = officialSearchTerm(discovery.finalUrl);
  if (!exactCatalogTitle(sourceTerm, candidate.title)
    || !exactCatalogTitle(finalTerm, candidate.title)
    || !exactCatalogTitle(discovery.queryTitle, candidate.title)
    || !verifiedPsnTitle(discovery.matchedTitle, candidate.title)
    || discovery.productId !== candidate.psnProductId
    || !Number.isSafeInteger(discovery.rank)
    || discovery.rank < 0
    || discovery.rank >= 24
    || !DIGEST_RE.test(discovery.pageDigest ?? '')) {
    throw new Error('PSN candidate discovery evidence does not match the candidate');
  }
  return discovery;
}

function verifiedPsnTitle(candidate, wanted) {
  const candidateTitle = normTitle(candidate).replace(/(?:ps4(?:and)?ps5|ps5(?:and)?ps4|ps4|ps5)$/u, '');
  const wantedTitle = normTitle(wanted);
  return Boolean(candidateTitle && wantedTitle && candidateTitle === wantedTitle);
}

function sameStrings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseManualPsnProductUrl(value) {
  if (typeof value !== 'string' || !value) throw new Error('productUrl must be an official PlayStation URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('productUrl must be an absolute URL');
  }
  if (url.origin !== 'https://store.playstation.com' || url.username || url.password || url.search || url.hash) {
    throw new Error('productUrl must be a clean https://store.playstation.com URL without credentials, query, or fragment');
  }
  const match = decodeURIComponent(url.pathname).match(/^\/en-us\/product\/([^/]+)\/?$/u);
  const productId = match?.[1]?.toUpperCase() ?? null;
  if (!validPsnProductId(productId)) throw new Error('productUrl must target one valid en-us product id');
  return { productId, canonicalUrl: psnProductUrl(productId) };
}

export function validatePsnManualInput(document, { catalog, now = Date.now() } = {}) {
  if (!plainObject(document)) throw new Error('PSN manual input must be an object');
  if (document.schemaVersion !== PSN_MANUAL_INPUT_SCHEMA_VERSION || document.kind !== PSN_MANUAL_INPUT_KIND) {
    throw new Error('unsupported PSN manual input schema');
  }
  const createdAt = isoTimestamp(document.createdAt, 'createdAt');
  if (Date.parse(createdAt) > now) throw new Error('createdAt cannot be in the future');
  if (!Array.isArray(document.entries)
    || document.entries.length < PSN_MANUAL_MIN_ENTRIES
    || document.entries.length > PSN_MANUAL_MAX_ENTRIES) {
    throw new Error(`PSN manual input requires ${PSN_MANUAL_MIN_ENTRIES}-${PSN_MANUAL_MAX_ENTRIES} entries`);
  }
  if (!plainObject(catalog) || !Array.isArray(catalog.games)) throw new Error('catalog.games is required');

  const games = new Map(catalog.games.map((game) => [game.slug, game]));
  const existingIds = new Map(catalog.games
    .filter((game) => game.psnProductId)
    .map((game) => [game.psnProductId, game.slug]));
  const seenSlugs = new Set();
  const seenProductIds = new Set();
  const entries = [];

  for (const [index, source] of document.entries.entries()) {
    if (!plainObject(source)) throw new Error(`entries[${index}] must be an object`);
    const unknown = Object.keys(source).filter((key) => !ENTRY_KEYS.has(key));
    if (unknown.length) throw new Error(`entries[${index}] has unknown fields: ${unknown.join(', ')}`);
    if (!SLUG_RE.test(source.slug ?? '')) throw new Error(`entries[${index}].slug is invalid`);
    if (typeof source.title !== 'string' || !source.title.trim()) throw new Error(`entries[${index}].title is required`);
    if (source.note != null && typeof source.note !== 'string') throw new Error(`entries[${index}].note must be a string or null`);
    if (seenSlugs.has(source.slug)) throw new Error(`duplicate manual mapping slug: ${source.slug}`);
    seenSlugs.add(source.slug);
    const game = games.get(source.slug);
    if (!game) throw new Error(`manual mapping slug is absent from catalog: ${source.slug}`);
    if (!exactCatalogTitle(source.title, game.title)) throw new Error(`manual mapping title mismatch: ${source.slug}`);
    if (game.psnProductId) throw new Error(`manual mapping already exists in catalog: ${source.slug}`);

    if (source.productUrl == null) {
      if (source.selectedAt != null) throw new Error(`pending manual mapping cannot have selectedAt: ${source.slug}`);
      entries.push({ ...source, status: 'pending', game, productId: null, canonicalUrl: null });
      continue;
    }

    const selectedAt = isoTimestamp(source.selectedAt, `${source.slug}.selectedAt`);
    if (Date.parse(selectedAt) > now) throw new Error(`selectedAt cannot be in the future: ${source.slug}`);
    const { productId, canonicalUrl } = parseManualPsnProductUrl(source.productUrl);
    if (seenProductIds.has(productId)) throw new Error(`duplicate manual PSN product id: ${productId}`);
    seenProductIds.add(productId);
    const owner = existingIds.get(productId);
    if (owner) throw new Error(`PSN product id ${productId} already belongs to ${owner}`);
    entries.push({ ...source, selectedAt, status: 'ready', game, productId, canonicalUrl });
  }

  return {
    createdAt,
    entries,
    pending: entries.filter((entry) => entry.status === 'pending'),
    ready: entries.filter((entry) => entry.status === 'ready'),
  };
}

function withoutEvidenceDigest(value) {
  const { evidenceDigest: _digest, ...payload } = value;
  return payload;
}

function sealMappingEvidence(evidence) {
  const payload = withoutEvidenceDigest(evidence);
  return { ...payload, evidenceDigest: sha256Digest(payload) };
}

export function buildPsnMappingCandidate(entry, parsed, {
  observedAt = new Date(),
  finalUrl,
  evidenceTtlMs = PSN_MAPPING_EVIDENCE_TTL_MS,
  discovery = null,
} = {}) {
  if (entry?.status !== 'ready') throw new Error('PSN mapping candidate requires a ready manual entry');
  if (!parsed || parsed.productId !== entry.productId || parsed.edition !== 'standard') {
    throw new Error('PSN product verification does not match the manual entry');
  }
  if (!verifiedPsnTitle(parsed.matchedTitle, entry.title)) {
    throw new Error('PSN product verification title does not match the manual entry');
  }
  if (!Array.isArray(parsed.platforms) || parsed.platforms.length === 0
    || parsed.platforms.some((platform) => !['ps4', 'ps5'].includes(platform))) {
    throw new Error('PSN product verification lacks a supported PlayStation platform');
  }
  if (parsed.row?.cc !== 'US' || parsed.row?.currency !== 'USD' || !(parsed.row?.amount > 0)) {
    throw new Error('PSN product verification lacks a public paid US offer');
  }
  const observed = observedAt instanceof Date ? observedAt : new Date(observedAt);
  if (!Number.isFinite(observed.valueOf())) throw new Error('observedAt must be a valid timestamp');
  if (!(Number.isFinite(evidenceTtlMs) && evidenceTtlMs > 0)) throw new Error('evidenceTtlMs must be positive');
  const observedIso = observed.toISOString();
  const finalIdentity = parseManualPsnProductUrl(finalUrl);
  if (finalIdentity.productId !== entry.productId) throw new Error('PSN final URL does not match the manual entry');
  const evidencePayload = {
    kind: 'psn-official-product-verification',
    sourceUrl: entry.canonicalUrl,
    finalUrl,
    observedAt: observedIso,
    expiresAt: new Date(observed.valueOf() + evidenceTtlMs).toISOString(),
    productId: parsed.productId,
    conceptId: parsed.conceptId,
    matchedTitle: parsed.matchedTitle,
    edition: parsed.edition,
    skuId: parsed.skuId,
    platforms: [...parsed.platforms],
    publicUsOffer: { ...parsed.row },
    psPlusOfferExcluded: Boolean(parsed.annotations?.psPlus),
    excludedTrials: parsed.annotations?.excludedTrials ?? 0,
  };
  const candidate = {
    schemaVersion: 1,
    kind: PSN_MAPPING_CANDIDATE_KIND,
    candidateId: `psn:${parsed.productId}`,
    catalogAction: 'add_platform_mapping',
    slug: entry.slug,
    title: entry.title,
    psnProductId: parsed.productId,
    psnConceptId: parsed.conceptId,
    psnEdition: 'standard',
    platforms: [...parsed.platforms],
  };
  if (discovery != null) {
    candidate.evidence = { ...evidencePayload, discovery: { ...discovery } };
    validateDiscoveryEvidence(candidate.evidence.discovery, candidate);
  } else {
    candidate.evidence = evidencePayload;
  }
  candidate.evidence = sealMappingEvidence(candidate.evidence);
  candidate.evidenceDigest = candidate.evidence.evidenceDigest;
  return candidate;
}

export function validatePsnMappingCandidate(candidate, { now = Date.now(), allowExpired = false } = {}) {
  if (!plainObject(candidate) || candidate.schemaVersion !== 1 || candidate.kind !== PSN_MAPPING_CANDIDATE_KIND) {
    throw new Error('unsupported PSN mapping candidate');
  }
  if (!validPsnProductId(candidate.psnProductId)
    || candidate.candidateId !== `psn:${candidate.psnProductId}`
    || candidate.catalogAction !== 'add_platform_mapping'
    || candidate.psnEdition !== 'standard'
    || !SLUG_RE.test(candidate.slug ?? '')
    || typeof candidate.title !== 'string'
    || !candidate.title) {
    throw new Error('invalid PSN mapping candidate identity');
  }
  const evidence = candidate.evidence;
  if (!plainObject(evidence) || !DIGEST_RE.test(evidence.evidenceDigest ?? '')) {
    throw new Error('PSN mapping candidate evidence digest is missing');
  }
  if (evidence.evidenceDigest !== sha256Digest(withoutEvidenceDigest(evidence))
    || candidate.evidenceDigest !== evidence.evidenceDigest) {
    throw new Error('PSN mapping candidate evidence digest mismatch');
  }
  if (evidence.productId !== candidate.psnProductId || evidence.edition !== 'standard') {
    throw new Error('PSN mapping candidate evidence identity mismatch');
  }
  if (evidence.kind !== 'psn-official-product-verification'
    || !verifiedPsnTitle(evidence.matchedTitle, candidate.title)) {
    throw new Error('PSN mapping candidate evidence title mismatch');
  }
  const sourceIdentity = parseManualPsnProductUrl(evidence.sourceUrl);
  const finalIdentity = parseManualPsnProductUrl(evidence.finalUrl);
  if (sourceIdentity.productId !== candidate.psnProductId || finalIdentity.productId !== candidate.psnProductId) {
    throw new Error('PSN mapping candidate evidence URL mismatch');
  }
  if (evidence.conceptId !== candidate.psnConceptId
    || (evidence.conceptId != null && !/^\d{8}$/u.test(evidence.conceptId))) {
    throw new Error('PSN mapping candidate concept identity mismatch');
  }
  if (typeof evidence.skuId !== 'string' || !evidence.skuId.startsWith(`${candidate.psnProductId}-U`)) {
    throw new Error('PSN mapping candidate SKU identity mismatch');
  }
  const platforms = [...new Set(candidate.platforms ?? [])].sort();
  if (platforms.length === 0 || platforms.some((platform) => !['ps4', 'ps5'].includes(platform))
    || !sameStrings(candidate.platforms, platforms)
    || !sameStrings(evidence.platforms, platforms)) {
    throw new Error('PSN mapping candidate platform evidence mismatch');
  }
  const offer = evidence.publicUsOffer;
  if (!plainObject(offer) || offer.cc !== 'US' || offer.currency !== 'USD' || !(offer.amount > 0)
    || (offer.list != null && (!(offer.list >= offer.amount) || offer.discountPct !== Math.round((1 - offer.amount / offer.list) * 100)))
    || (offer.list == null && offer.discountPct != null)
    || (offer.saleEndsAt != null && !Number.isFinite(Date.parse(offer.saleEndsAt)))) {
    throw new Error('PSN mapping candidate public offer evidence is invalid');
  }
  if (typeof evidence.psPlusOfferExcluded !== 'boolean'
    || !Number.isInteger(evidence.excludedTrials)
    || evidence.excludedTrials < 0) {
    throw new Error('PSN mapping candidate exclusion evidence is invalid');
  }
  if (evidence.discovery != null) validateDiscoveryEvidence(evidence.discovery, candidate);
  const observedAt = isoTimestamp(evidence.observedAt, 'evidence.observedAt');
  const expiresAt = isoTimestamp(evidence.expiresAt, 'evidence.expiresAt');
  const ageMs = Date.parse(expiresAt) - Date.parse(observedAt);
  if (ageMs <= 0 || ageMs > PSN_MAPPING_EVIDENCE_TTL_MS || Date.parse(observedAt) > now) {
    throw new Error('PSN mapping candidate evidence TTL is invalid');
  }
  if (!allowExpired && Date.parse(expiresAt) <= now) throw new Error('PSN mapping candidate evidence expired');
  return candidate;
}

function validateCandidateSet(candidates, { now, discoveryMode }) {
  if (!Array.isArray(candidates) || candidates.length > PSN_MANUAL_MAX_ENTRIES) {
    throw new Error(`PSN suggestions support at most ${PSN_MANUAL_MAX_ENTRIES} candidates`);
  }
  const dimensions = [
    ['candidate id', (candidate) => candidate.candidateId],
    ['catalog slug', (candidate) => candidate.slug],
    ['product id', (candidate) => candidate.psnProductId],
    ['concept id', (candidate) => candidate.psnConceptId],
  ];
  const seen = new Map(dimensions.map(([label]) => [label, new Set()]));
  for (const candidate of candidates) {
    validatePsnMappingCandidate(candidate, { now });
    const hasDiscovery = candidate.evidence?.discovery != null;
    if (discoveryMode === 'official-search-v1' && !hasDiscovery) {
      throw new Error('official-search-v1 PSN candidate lacks discovery evidence');
    }
    if (discoveryMode === 'manual-official-url' && hasDiscovery) {
      throw new Error('manual PSN candidate must not contain automated discovery evidence');
    }
    for (const [label, select] of dimensions) {
      const value = select(candidate);
      if (value == null) continue;
      if (seen.get(label).has(value)) throw new Error(`duplicate PSN suggestion ${label}: ${value}`);
      seen.get(label).add(value);
    }
  }
}

export function createPsnSuggestionDocument({
  generatedAt = new Date(),
  candidates,
  pending,
  failures,
  discoveryMode = 'manual-official-url',
}) {
  const generated = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (!Number.isFinite(generated.valueOf())) throw new Error('generatedAt must be valid');
  if (!DISCOVERY_MODES.has(discoveryMode)) throw new Error('unsupported PSN discovery mode');
  validateCandidateSet(candidates ?? [], { now: generated.valueOf(), discoveryMode });
  return sealEvidenceDocument({
    schemaVersion: 1,
    kind: PSN_MAPPING_SUGGESTIONS_KIND,
    discoveryMode,
    generatedAt: generated.toISOString(),
    stabilityStatus: 'day-1-only',
    candidates: candidates ?? [],
    pending: pending ?? [],
    failures: failures ?? [],
  });
}

export function validatePsnSuggestionDocument(document, { now = Date.now() } = {}) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== 1 || document.kind !== PSN_MAPPING_SUGGESTIONS_KIND
    || !DISCOVERY_MODES.has(document.discoveryMode) || document.stabilityStatus !== 'day-1-only') {
    throw new Error('unsupported PSN mapping suggestions document');
  }
  validateCandidateSet(document.candidates ?? [], { now, discoveryMode: document.discoveryMode });
  return document;
}
