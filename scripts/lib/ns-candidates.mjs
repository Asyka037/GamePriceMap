import { assertDocumentDigest, sha256Digest } from './candidate-evidence.mjs';
import { titleMatches } from './match.mjs';
import { switchGenerations } from './nsuid-discovery.mjs';

export const NINTENDO_SEED_SCHEMA_VERSION = 1;
export const NINTENDO_SUGGESTION_SCHEMA_VERSION = 1;
export const NINTENDO_SEED_KIND = 'nintendo-candidate-seeds';
export const NINTENDO_SUGGESTION_KIND = 'nintendo-discovery-suggestions';
export const NINTENDO_EXCLUSIVITY = Object.freeze({
  OFFICIAL: 'official_exclusive_or_first_party',
  KNOWN_CROSS_PLATFORM: 'known_cross_platform',
  UNVERIFIED: 'unverified',
});

const BASE_NSUID_RE = /^7001\d{10}$/u;
const CANDIDATE_ID_RE = /^ns:7001\d{10}$/u;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const EXCLUSIVITY_EVIDENCE = new Set(['first_party', 'official_exclusive', 'official_cross_platform']);
const STEAM_MATCH_STATUSES = new Set(['not_found', 'exact_title']);
const POPULARITY_KINDS = new Set(['nintendo_official_rank', 'steam_heat']);
const CATALOG_ACTIONS = new Set(['new_game', 'add_platform_mapping']);
const GROUPS = ['americas', 'europe', 'japan'];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isoTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) fail('invalid_timestamp', `${label} must be a valid timestamp`);
  return date.toISOString();
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail('invalid_evidence_url', `${label} must be HTTPS`);
    return url;
  } catch (error) {
    if (error?.code) throw error;
    return fail('invalid_evidence_url', `${label} must be an absolute HTTPS URL`);
  }
}

function withoutDigest(value) {
  const { evidenceDigest: _digest, ...payload } = value;
  return payload;
}

function validateBoundEvidence(value, label) {
  if (!plainObject(value)) fail('invalid_evidence', `${label} must be an object`);
  if (!DIGEST_RE.test(value.evidenceDigest ?? '')) fail('missing_evidence_digest', `${label}.evidenceDigest is required`);
  if (value.evidenceDigest !== sha256Digest(withoutDigest(value))) fail('evidence_digest_mismatch', `${label}.evidenceDigest mismatch`);
  return value;
}

export function sealDatedEvidence(evidence) {
  const payload = withoutDigest(evidence);
  return { ...payload, evidenceDigest: sha256Digest(payload) };
}

function validateDatedEvidence(evidence, label) {
  validateBoundEvidence(evidence, label);
  if (!(typeof evidence.kind === 'string' && evidence.kind)) fail('missing_evidence_kind', `${label}.kind is required`);
  httpsUrl(evidence.sourceUrl, `${label}.sourceUrl`);
  isoTimestamp(evidence.observedAt, `${label}.observedAt`);
  if (evidence.nsuid != null && !BASE_NSUID_RE.test(String(evidence.nsuid))) {
    fail('invalid_evidence_nsuid', `${label}.nsuid must be a base-game NSUID`);
  }
  return evidence;
}

export function sealManualUsEvidence(evidence) {
  return sealDatedEvidence(evidence);
}

export function validateManualUsEvidence(evidence, { title, platforms } = {}) {
  validateBoundEvidence(evidence, 'manualUsEvidence');
  const source = httpsUrl(evidence.sourceUrl, 'manualUsEvidence.sourceUrl');
  if (!['nintendo.com', 'www.nintendo.com'].includes(source.hostname)) {
    fail('manual_us_not_official', 'manualUsEvidence must point to Nintendo US');
  }
  if (!SLUG_RE.test(evidence.productSlug ?? '')) fail('manual_us_bad_product_slug', 'manualUsEvidence.productSlug is invalid');
  const expectedPath = `/us/store/products/${evidence.productSlug}`;
  if (source.pathname.replace(/\/+$/u, '') !== expectedPath) {
    fail('manual_us_url_slug_mismatch', 'manualUsEvidence URL does not match productSlug');
  }
  if (!BASE_NSUID_RE.test(String(evidence.nsuid ?? ''))) fail('manual_us_bad_nsuid', 'manualUsEvidence.nsuid is not a base game');
  if (!titleMatches(evidence.title, title)) fail('manual_us_title_mismatch', 'manualUsEvidence title does not match candidate');
  const reviewedAt = isoTimestamp(evidence.reviewedAt, 'manualUsEvidence.reviewedAt');
  const releasedAt = isoTimestamp(evidence.releasedAt, 'manualUsEvidence.releasedAt');
  if (Date.parse(releasedAt) > Date.parse(reviewedAt)) fail('manual_us_unreleased', 'manualUsEvidence was reviewed before release');
  if (evidence.paid !== true) fail('manual_us_not_paid', 'manualUsEvidence must explicitly confirm a paid product');
  if (!['HAC', 'BEE'].includes(evidence.generation)) fail('manual_us_bad_generation', 'manualUsEvidence generation is required');
  if (!switchGenerations(platforms).has(evidence.generation)) {
    fail('manual_us_generation_mismatch', 'manualUsEvidence generation does not match candidate platforms');
  }
  return {
    region: 'americas',
    nsuid: String(evidence.nsuid),
    matchedTitle: evidence.title,
    generation: evidence.generation,
    paid: true,
    released: true,
    manual: true,
    sourceUrl: evidence.sourceUrl,
    collectedAt: reviewedAt,
    sourceDigest: evidence.evidenceDigest,
    sourceEvidence: evidence,
    publishers: normalizeStringList(evidence.publisher),
    developers: normalizeStringList(evidence.developer),
  };
}

function normalizeStringList(value) {
  return (Array.isArray(value) ? value : value == null ? [] : [value])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function normalizeNsuids(value, label = 'knownNsuids') {
  if (value == null) return { americas: null, europe: null, japan: null };
  if (!plainObject(value)) fail('invalid_nsuids', `${label} must be an object`);
  const unknown = Object.keys(value).filter((group) => !GROUPS.includes(group));
  if (unknown.length > 0) fail('invalid_nsuid_group', `${label} has unknown groups: ${unknown.join(', ')}`);
  return Object.fromEntries(GROUPS.map((group) => {
    const raw = value[group];
    if (raw == null || raw === '') return [group, null];
    const id = String(raw);
    if (!BASE_NSUID_RE.test(id)) fail('invalid_nsuid', `${label}.${group} is not a base-game NSUID`);
    return [group, id];
  }));
}

export function stableNintendoCandidateId(explicitCandidateId, nsuids) {
  if (explicitCandidateId != null && explicitCandidateId !== '') {
    const candidateId = String(explicitCandidateId).toLowerCase();
    if (!CANDIDATE_ID_RE.test(candidateId)) fail('invalid_candidate_id', `invalid Nintendo candidateId: ${explicitCandidateId}`);
    return candidateId;
  }
  const normalized = normalizeNsuids(nsuids, 'discoveredNsuids');
  const anchor = normalized.americas ?? normalized.europe ?? normalized.japan;
  return anchor ? `ns:${anchor}` : null;
}

function validateSteamMatchEvidence(evidence, candidate) {
  if (evidence == null) return null;
  validateDatedEvidence(evidence, 'steamMatchEvidence');
  if (!STEAM_MATCH_STATUSES.has(evidence.status)) fail('invalid_steam_match_status', 'steamMatchEvidence.status is invalid');
  if (evidence.status === 'exact_title') {
    if (!(Number.isSafeInteger(evidence.steamAppId) && evidence.steamAppId > 0)) fail('invalid_steam_appid', 'steamMatchEvidence.steamAppId is invalid');
    if (!titleMatches(evidence.title, candidate.title)) fail('steam_title_mismatch', 'Steam title is not an exact candidate title match');
  }
  return evidence;
}

function validateExclusivityEvidence(evidence, candidate) {
  if (evidence == null) return null;
  validateDatedEvidence(evidence, 'exclusivityEvidence');
  if (!EXCLUSIVITY_EVIDENCE.has(evidence.classification)) {
    fail('invalid_exclusivity_evidence', 'exclusivityEvidence.classification is invalid');
  }
  if (!titleMatches(evidence.title, candidate?.title)) {
    fail('exclusivity_title_mismatch', 'exclusivity evidence title does not match candidate');
  }
  if (evidence.classification === 'first_party' && normalizeStringList(evidence.publisher).length === 0) {
    fail('first_party_publisher_missing', 'first-party evidence must name the publisher');
  }
  if (evidence.classification !== 'first_party' && !(typeof evidence.statement === 'string' && evidence.statement.trim())) {
    fail('official_platform_statement_missing', 'official platform evidence must preserve the reviewed statement');
  }
  return evidence;
}

function validatePopularityEvidence(entries) {
  if (entries == null) return [];
  if (!Array.isArray(entries)) fail('invalid_popularity_evidence', 'popularityEvidence must be an array');
  return entries.map((evidence, index) => {
    validateDatedEvidence(evidence, `popularityEvidence[${index}]`);
    if (!POPULARITY_KINDS.has(evidence.kind)) {
      fail('untrusted_popularity_source', `popularityEvidence[${index}] source is not trusted for popularity`);
    }
    if (evidence.kind === 'nintendo_official_rank' && !(Number.isSafeInteger(evidence.rank) && evidence.rank > 0)) {
      fail('invalid_popularity_rank', 'Nintendo official popularity evidence needs a positive rank');
    }
    if (evidence.kind === 'steam_heat' && !(Number.isFinite(evidence.score) && evidence.score >= 0)) {
      fail('invalid_popularity_score', 'Steam heat evidence needs a non-negative score');
    }
    if (!DIGEST_RE.test(evidence.sourceDigest ?? '')) fail('missing_popularity_source_digest', 'popularity evidence must bind its source document');
    return evidence;
  });
}

export function validateNintendoSeedCandidate(candidate, { requireCandidateId = true, requireSeedEvidence = true } = {}) {
  if (!plainObject(candidate)) fail('invalid_seed_candidate', 'Nintendo seed candidate must be an object');
  if (!SLUG_RE.test(candidate.slug ?? '')) fail('invalid_seed_slug', `invalid seed slug: ${candidate.slug}`);
  if (!(typeof candidate.title === 'string' && candidate.title.trim())) fail('missing_seed_title', 'Nintendo seed title is required');
  if (!Array.isArray(candidate.platforms) || !candidate.platforms.some((platform) => platform === 'switch' || platform === 'switch-2')) {
    fail('missing_switch_platform', 'Nintendo seed must include switch or switch-2');
  }
  const catalogAction = candidate.catalogAction ?? 'new_game';
  if (!CATALOG_ACTIONS.has(catalogAction)) fail('invalid_catalog_action', 'Nintendo seed catalogAction is invalid');
  const knownNsuids = normalizeNsuids(candidate.knownNsuids);
  if (requireCandidateId && !candidate.candidateId) fail('missing_candidate_id', 'Nintendo seed candidateId is required');
  const candidateId = candidate.candidateId ? stableNintendoCandidateId(candidate.candidateId, knownNsuids) : null;

  const seedEvidence = candidate.seedEvidence ?? [];
  if (!Array.isArray(seedEvidence)) fail('invalid_seed_evidence', 'seedEvidence must be an array');
  seedEvidence.forEach((evidence, index) => validateDatedEvidence(evidence, `seedEvidence[${index}]`));
  const manualUsEvidence = candidate.manualUsEvidence
    ? validateManualUsEvidence(candidate.manualUsEvidence, candidate)
    : null;
  if (requireSeedEvidence && seedEvidence.length === 0 && !manualUsEvidence) {
    fail('seed_evidence_missing', 'candidate has no dated source evidence; unsubstantiated seed lists are rejected');
  }

  const boundIds = new Set([
    ...Object.values(knownNsuids).filter(Boolean),
    ...seedEvidence.map((evidence) => evidence.nsuid).filter(Boolean).map(String),
    manualUsEvidence?.nsuid,
  ].filter(Boolean));
  if (candidateId && boundIds.size > 0 && !boundIds.has(candidateId.slice(3))) {
    fail('candidate_id_unbound', 'candidateId is not bound to any supplied NSUID evidence');
  }
  if (candidateId && boundIds.size === 0) fail('candidate_id_unbound', 'candidateId lacks source evidence for its NSUID');

  validateExclusivityEvidence(candidate.exclusivityEvidence, candidate);
  validateSteamMatchEvidence(candidate.steamMatchEvidence, candidate);
  validatePopularityEvidence(candidate.popularityEvidence);
  return { ...candidate, candidateId, knownNsuids, catalogAction };
}

function sealDocument(payload) {
  return { ...payload, documentDigest: sha256Digest(payload) };
}

export function createNintendoSeedDocument({ generatedAt, candidates }) {
  const payload = {
    schemaVersion: NINTENDO_SEED_SCHEMA_VERSION,
    kind: NINTENDO_SEED_KIND,
    generatedAt: isoTimestamp(generatedAt, 'generatedAt'),
    candidates,
  };
  const document = sealDocument(payload);
  validateNintendoSeedDocument(document);
  return document;
}

export function validateNintendoSeedDocument(document) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== NINTENDO_SEED_SCHEMA_VERSION || document.kind !== NINTENDO_SEED_KIND) {
    fail('unsupported_seed_schema', 'unsupported Nintendo seed document schema');
  }
  isoTimestamp(document.generatedAt, 'generatedAt');
  if (!Array.isArray(document.candidates)) fail('missing_seed_candidates', 'Nintendo seed candidates must be an array');
  const ids = new Set();
  const slugs = new Set();
  for (const candidate of document.candidates) {
    const normalized = validateNintendoSeedCandidate(candidate);
    if (ids.has(normalized.candidateId)) fail('duplicate_candidate_id', `duplicate seed candidateId ${normalized.candidateId}`);
    if (slugs.has(normalized.slug)) fail('duplicate_candidate_slug', `duplicate seed slug ${normalized.slug}`);
    ids.add(normalized.candidateId);
    slugs.add(normalized.slug);
  }
  return document;
}

function organizationKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\b(?:incorporated|inc|ltd|limited|llc|corp|corporation|co)\b/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim();
}

function organizationOverlap(candidate, steamEvidence) {
  const candidateOrganizations = new Set([
    ...normalizeStringList(candidate.publisher),
    ...normalizeStringList(candidate.developer),
    ...normalizeStringList(candidate.manualUsEvidence?.publisher),
    ...normalizeStringList(candidate.manualUsEvidence?.developer),
  ].map(organizationKey).filter(Boolean));
  return [...normalizeStringList(steamEvidence?.publisher), ...normalizeStringList(steamEvidence?.developer)]
    .map(organizationKey)
    .some((key) => key && candidateOrganizations.has(key));
}

export function classifyNintendoExclusivity(candidate) {
  const official = validateExclusivityEvidence(candidate.exclusivityEvidence, candidate);
  const steam = validateSteamMatchEvidence(candidate.steamMatchEvidence, candidate);
  const exactSteamTitle = steam?.status === 'exact_title';
  const knownFromSteam = exactSteamTitle && organizationOverlap(candidate, steam);
  const officialExclusive = ['first_party', 'official_exclusive'].includes(official?.classification);
  const officialCrossPlatform = official?.classification === 'official_cross_platform';
  const conflict = officialExclusive && (knownFromSteam || officialCrossPlatform);
  if (conflict) {
    return {
      classification: NINTENDO_EXCLUSIVITY.UNVERIFIED,
      possibleCrossPlatform: Boolean(exactSteamTitle),
      conflict: true,
      reason: 'exclusivity_evidence_conflict',
    };
  }
  if (officialExclusive) {
    return {
      classification: NINTENDO_EXCLUSIVITY.OFFICIAL,
      possibleCrossPlatform: false,
      conflict: false,
      reason: official.classification,
    };
  }
  if (knownFromSteam || officialCrossPlatform) {
    return {
      classification: NINTENDO_EXCLUSIVITY.KNOWN_CROSS_PLATFORM,
      possibleCrossPlatform: false,
      conflict: false,
      reason: officialCrossPlatform ? 'official_cross_platform' : 'exact_title_and_organization_overlap',
    };
  }
  return {
    classification: NINTENDO_EXCLUSIVITY.UNVERIFIED,
    possibleCrossPlatform: Boolean(exactSteamTitle),
    conflict: false,
    reason: exactSteamTitle ? 'exact_title_without_organization_overlap' : 'no_affirmative_platform_evidence',
  };
}

export function derivePopularity(candidate) {
  const evidence = validatePopularityEvidence(candidate.popularityEvidence);
  if (evidence.length === 0) {
    return { popularityUnverified: true, score: null, rank: null, evidence: [] };
  }
  const scores = evidence.map((item) => item.score).filter(Number.isFinite);
  const ranks = evidence.map((item) => item.rank).filter((rank) => Number.isSafeInteger(rank) && rank > 0);
  return {
    popularityUnverified: false,
    score: scores.length > 0 ? Math.max(...scores) : null,
    rank: ranks.length > 0 ? Math.min(...ranks) : null,
    evidence,
  };
}

export function sealRegionalDiscoveryEvidence(evidence) {
  return sealDatedEvidence(evidence);
}

function normalizeRegionalEvidence(evidence, region, candidate) {
  if (evidence == null || evidence.status === 'none') return { evidence: null, warning: `${region}_not_found`, exception: null };
  if (evidence.status === 'exception') {
    return { evidence: null, warning: null, exception: `${region}_${evidence.reason ?? 'exception'}` };
  }
  validateBoundEvidence(evidence, `${region}Evidence`);
  if (evidence.region !== region) fail('regional_evidence_group_mismatch', `${region} evidence has the wrong group`);
  if (!BASE_NSUID_RE.test(String(evidence.nsuid ?? ''))) fail('regional_evidence_bad_nsuid', `${region} evidence is not a base game`);
  if (!titleMatches(evidence.matchedTitle, candidate.title)) fail('regional_evidence_title_mismatch', `${region} title does not match`);
  if (!switchGenerations(candidate.platforms).has(evidence.generation)) {
    fail('regional_evidence_generation_mismatch', `${region} generation does not match candidate`);
  }
  if (evidence.paid !== true || evidence.released !== true) {
    fail('regional_evidence_not_paid_released', `${region} evidence must prove paid and released`);
  }
  httpsUrl(evidence.sourceUrl, `${region}Evidence.sourceUrl`);
  isoTimestamp(evidence.collectedAt, `${region}Evidence.collectedAt`);
  if (!DIGEST_RE.test(evidence.sourceDigest ?? '')) fail('regional_source_digest_missing', `${region} evidence must bind its source response`);
  return { evidence, warning: null, exception: null };
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function sealSuggestionCandidate(payload) {
  const { evidenceDigest: _digest, ...unsigned } = payload;
  return { ...unsigned, evidenceDigest: sha256Digest(unsigned) };
}

export function buildNintendoSuggestion(candidate, discoveries = {}, { existingNsuids = new Set() } = {}) {
  const normalized = validateNintendoSeedCandidate(candidate, {
    requireCandidateId: false,
    requireSeedEvidence: false,
  });
  const exceptions = [];
  const warnings = [];
  let usEvidence = null;
  if (candidate.manualUsEvidence) {
    try {
      usEvidence = validateManualUsEvidence(candidate.manualUsEvidence, candidate);
    } catch (error) {
      exceptions.push(error.code ?? 'manual_us_evidence_invalid');
    }
  } else {
    exceptions.push('manual_us_evidence_missing');
  }

  const regional = {
    americas: usEvidence,
    europe: null,
    japan: null,
  };
  for (const region of ['europe', 'japan']) {
    try {
      const normalizedEvidence = normalizeRegionalEvidence(discoveries[region], region, candidate);
      regional[region] = normalizedEvidence.evidence;
      if (normalizedEvidence.warning) warnings.push(normalizedEvidence.warning);
      if (normalizedEvidence.exception) exceptions.push(normalizedEvidence.exception);
    } catch (error) {
      exceptions.push(error.code ?? `${region}_evidence_invalid`);
    }
  }

  const nsuids = Object.fromEntries(GROUPS.map((group) => [group, regional[group]?.nsuid ?? null]));
  const generationEvidence = uniqueStrings(Object.values(regional).map((item) => item?.generation));
  if (generationEvidence.length > 1) exceptions.push('generation_fingerprint_conflict');
  const candidateId = stableNintendoCandidateId(normalized.candidateId, nsuids);
  if (!Object.values(nsuids).some(Boolean)) exceptions.push('no_verified_nsuid');
  for (const nsuid of Object.values(nsuids).filter(Boolean)) {
    if (existingNsuids.has(String(nsuid))) exceptions.push(`catalog_nsuid_conflict:${nsuid}`);
  }

  const exclusivity = classifyNintendoExclusivity(candidate);
  if (exclusivity.conflict) exceptions.push(exclusivity.reason);
  const popularity = derivePopularity(candidate);
  if (popularity.popularityUnverified) exceptions.push('popularity_evidence_missing');
  return sealSuggestionCandidate({
    schemaVersion: NINTENDO_SUGGESTION_SCHEMA_VERSION,
    candidateId,
    sourceCandidateId: normalized.candidateId ?? null,
    catalogAction: normalized.catalogAction,
    slug: normalized.slug,
    title: normalized.title,
    platforms: [...normalized.platforms],
    publisher: normalized.publisher ?? null,
    developer: normalized.developer ?? null,
    nsuids,
    // Flat aliases keep the generic workbook/review pipeline compatible while
    // nsuids remains the authoritative grouped representation.
    nsuidAm: nsuids.americas,
    nsuidEu: nsuids.europe,
    nsuidJp: nsuids.japan,
    nintendoUsSlug: usEvidence?.sourceEvidence?.productSlug ?? null,
    primaryRegionalChannel: 'eshop',
    humanDecision: '待定',
    sourceUrl: usEvidence?.sourceUrl
      ?? regional.europe?.sourceUrl
      ?? regional.japan?.sourceUrl
      ?? null,
    generation: generationEvidence.length === 1 ? generationEvidence[0] : null,
    manualUsEvidence: usEvidence,
    regionalEvidence: {
      europe: regional.europe,
      japan: regional.japan,
    },
    exclusivityEvidence: normalized.exclusivityEvidence ?? null,
    steamMatchEvidence: normalized.steamMatchEvidence ?? null,
    exclusivity,
    popularity,
    popularityUnverified: popularity.popularityUnverified,
    verifyStatus: exceptions.length === 0 ? 'passed' : 'exception',
    exceptionReasons: uniqueStrings(exceptions).sort(),
    warnings: uniqueStrings(warnings).sort(),
  });
}

function resealWithException(candidate, reason) {
  return sealSuggestionCandidate({
    ...candidate,
    verifyStatus: 'exception',
    exceptionReasons: uniqueStrings([...(candidate.exceptionReasons ?? []), reason]).sort(),
  });
}

export function guardDuplicateNintendoCandidates(candidates) {
  const byNsuid = new Map();
  const byCandidateId = new Map();
  const reasons = new Map();
  const addReason = (index, reason) => reasons.set(index, [...(reasons.get(index) ?? []), reason]);

  candidates.forEach((candidate, index) => {
    if (candidate.candidateId) {
      const owners = byCandidateId.get(candidate.candidateId) ?? [];
      owners.push(index);
      byCandidateId.set(candidate.candidateId, owners);
    }
    const local = new Map();
    for (const [group, nsuid] of Object.entries(candidate.nsuids ?? {}).filter(([, value]) => value)) {
      const groups = local.get(nsuid) ?? [];
      groups.push(group);
      local.set(nsuid, groups);
      const owners = byNsuid.get(nsuid) ?? [];
      owners.push(index);
      byNsuid.set(nsuid, owners);
    }
    for (const [nsuid, groups] of local) {
      if (groups.length > 1) addReason(index, `cross_region_duplicate:${nsuid}`);
    }
  });
  for (const [candidateId, owners] of byCandidateId) {
    if (new Set(owners).size > 1) for (const owner of owners) addReason(owner, `duplicate_candidate_id:${candidateId}`);
  }
  for (const [nsuid, owners] of byNsuid) {
    if (new Set(owners).size > 1) for (const owner of owners) addReason(owner, `duplicate_nsuid:${nsuid}`);
  }
  return candidates.map((candidate, index) => {
    let result = candidate;
    for (const reason of uniqueStrings(reasons.get(index) ?? [])) result = resealWithException(result, reason);
    return result;
  });
}

const EXCLUSIVITY_WEIGHT = Object.freeze({
  [NINTENDO_EXCLUSIVITY.OFFICIAL]: 0,
  [NINTENDO_EXCLUSIVITY.UNVERIFIED]: 1,
  [NINTENDO_EXCLUSIVITY.KNOWN_CROSS_PLATFORM]: 2,
});

export function sortNintendoSuggestions(candidates) {
  return [...candidates].sort((left, right) => {
    const group = EXCLUSIVITY_WEIGHT[left.exclusivity?.classification]
      - EXCLUSIVITY_WEIGHT[right.exclusivity?.classification];
    if (group) return group;
    if (left.popularityUnverified !== right.popularityUnverified) return left.popularityUnverified ? 1 : -1;
    const leftScore = left.popularity?.score ?? Number.NEGATIVE_INFINITY;
    const rightScore = right.popularity?.score ?? Number.NEGATIVE_INFINITY;
    if (rightScore !== leftScore) return rightScore - leftScore;
    const leftRank = left.popularity?.rank ?? Number.POSITIVE_INFINITY;
    const rightRank = right.popularity?.rank ?? Number.POSITIVE_INFINITY;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.title.localeCompare(right.title, 'en');
  });
}

export async function discoverNintendoCandidates(candidates, {
  discoverEurope,
  discoverJapan,
  existingNsuids = new Set(),
  afterEach = async () => {},
} = {}) {
  if (typeof discoverEurope !== 'function' || typeof discoverJapan !== 'function') {
    throw new TypeError('EU and JP discovery functions are required; US discovery is intentionally unsupported');
  }
  const suggestions = [];
  for (const candidate of candidates) {
    let europe;
    let japan;
    try {
      europe = await discoverEurope(candidate);
    } catch (error) {
      europe = { status: 'exception', reason: error?.code ?? 'network_error' };
    }
    try {
      japan = await discoverJapan(candidate);
    } catch (error) {
      japan = { status: 'exception', reason: error?.code ?? 'network_error' };
    }
    suggestions.push(buildNintendoSuggestion(candidate, { europe, japan }, { existingNsuids }));
    await afterEach(candidate);
  }
  return sortNintendoSuggestions(guardDuplicateNintendoCandidates(suggestions));
}

export function createNintendoSuggestionDocument({ generatedAt, inputDigest, candidates }) {
  if (!DIGEST_RE.test(inputDigest ?? '')) fail('invalid_input_digest', 'Nintendo suggestion inputDigest is invalid');
  const payload = {
    schemaVersion: NINTENDO_SUGGESTION_SCHEMA_VERSION,
    kind: NINTENDO_SUGGESTION_KIND,
    generatedAt: isoTimestamp(generatedAt, 'generatedAt'),
    inputDigest,
    policy: {
      americasIdentity: 'manual_reviewed_official_evidence_only',
      automaticNetworkDiscovery: ['nintendo_europe_official_search_and_price', 'nintendo_japan_official_search'],
    },
    candidates: sortNintendoSuggestions(candidates),
  };
  const document = sealDocument(payload);
  validateNintendoSuggestionDocument(document);
  return document;
}

function sameCanonicalValue(left, right) {
  return sha256Digest(left) === sha256Digest(right);
}

function validateSuggestionCandidate(candidate, index) {
  const label = `candidates[${index}]`;
  validateBoundEvidence(candidate, label);
  if (candidate.schemaVersion !== NINTENDO_SUGGESTION_SCHEMA_VERSION) {
    fail('unsupported_suggestion_candidate_schema', `${label}.schemaVersion is unsupported`);
  }
  if (!SLUG_RE.test(candidate.slug ?? '')) fail('invalid_suggestion_slug', `${label}.slug is invalid`);
  if (!(typeof candidate.title === 'string' && candidate.title.trim())) {
    fail('missing_suggestion_title', `${label}.title is required`);
  }
  if (!Array.isArray(candidate.platforms)
    || !candidate.platforms.some((platform) => platform === 'switch' || platform === 'switch-2')) {
    fail('missing_switch_platform', `${label}.platforms needs a Switch generation`);
  }
  if (!CATALOG_ACTIONS.has(candidate.catalogAction)) {
    fail('invalid_catalog_action', `${label}.catalogAction is invalid`);
  }
  if (candidate.primaryRegionalChannel !== 'eshop') {
    fail('invalid_primary_regional_channel', `${label}.primaryRegionalChannel must be eshop`);
  }
  if (candidate.humanDecision !== '待定') {
    fail('invalid_initial_human_decision', `${label}.humanDecision must remain pending until user review`);
  }
  if (candidate.candidateId != null) stableNintendoCandidateId(candidate.candidateId, candidate.nsuids);
  if (candidate.sourceCandidateId != null) stableNintendoCandidateId(candidate.sourceCandidateId, candidate.nsuids);
  const nsuids = normalizeNsuids(candidate.nsuids, `${label}.nsuids`);
  const flatNsuids = {
    americas: candidate.nsuidAm ?? null,
    europe: candidate.nsuidEu ?? null,
    japan: candidate.nsuidJp ?? null,
  };
  if (!sameCanonicalValue(nsuids, flatNsuids)) {
    fail('suggestion_flat_nsuid_mismatch', `${label} flat NSUID aliases do not match nsuids`);
  }

  let americas = null;
  if (candidate.manualUsEvidence != null) {
    if (!plainObject(candidate.manualUsEvidence.sourceEvidence)) {
      fail('manual_us_source_evidence_missing', `${label}.manualUsEvidence must retain its reviewed source evidence`);
    }
    americas = validateManualUsEvidence(candidate.manualUsEvidence.sourceEvidence, candidate);
  if (!sameCanonicalValue(candidate.manualUsEvidence, americas)) {
      fail('manual_us_derived_evidence_mismatch', `${label}.manualUsEvidence does not match its reviewed source evidence`);
    }
  }
  const expectedNintendoUsSlug = americas?.sourceEvidence?.productSlug ?? null;
  if (candidate.nintendoUsSlug !== expectedNintendoUsSlug) {
    fail('suggestion_us_slug_evidence_mismatch', `${label}.nintendoUsSlug must come from reviewed manual US evidence`);
  }

  const regional = {};
  for (const region of ['europe', 'japan']) {
    const result = normalizeRegionalEvidence(candidate.regionalEvidence?.[region], region, candidate);
    regional[region] = result.evidence;
  }
  const derivedNsuids = {
    americas: americas?.nsuid ?? null,
    europe: regional.europe?.nsuid ?? null,
    japan: regional.japan?.nsuid ?? null,
  };
  if (!sameCanonicalValue(nsuids, derivedNsuids)) {
    fail('suggestion_nsuid_evidence_mismatch', `${label}.nsuids do not match the retained regional evidence`);
  }
  const expectedSourceUrl = americas?.sourceUrl
    ?? regional.europe?.sourceUrl
    ?? regional.japan?.sourceUrl
    ?? null;
  if (candidate.sourceUrl !== expectedSourceUrl) {
    fail('suggestion_source_url_mismatch', `${label}.sourceUrl does not match its retained evidence`);
  }

  const generationEvidence = uniqueStrings([
    americas?.generation,
    regional.europe?.generation,
    regional.japan?.generation,
  ]);
  const expectedGeneration = generationEvidence.length === 1 ? generationEvidence[0] : null;
  if (candidate.generation !== expectedGeneration) {
    fail('suggestion_generation_evidence_mismatch', `${label}.generation does not match the retained evidence`);
  }

  const auditCandidate = {
    title: candidate.title,
    publisher: candidate.publisher,
    developer: candidate.developer,
    manualUsEvidence: candidate.manualUsEvidence?.sourceEvidence ?? null,
    exclusivityEvidence: candidate.exclusivityEvidence,
    steamMatchEvidence: candidate.steamMatchEvidence,
  };
  const expectedExclusivity = classifyNintendoExclusivity(auditCandidate);
  if (!sameCanonicalValue(candidate.exclusivity, expectedExclusivity)) {
    fail('suggestion_exclusivity_evidence_mismatch', `${label}.exclusivity does not match its evidence`);
  }
  if (!Object.values(NINTENDO_EXCLUSIVITY).includes(candidate.exclusivity?.classification)) {
    fail('invalid_suggestion_exclusivity', `${label}.exclusivity classification is invalid`);
  }

  const expectedPopularity = derivePopularity({ popularityEvidence: candidate.popularity?.evidence });
  if (!sameCanonicalValue(candidate.popularity, expectedPopularity)
    || candidate.popularityUnverified !== expectedPopularity.popularityUnverified) {
    fail('suggestion_popularity_evidence_mismatch', `${label}.popularity does not match its evidence`);
  }

  if (!['passed', 'exception'].includes(candidate.verifyStatus)) {
    fail('invalid_suggestion_status', `${label}.verifyStatus is invalid`);
  }
  if (!Array.isArray(candidate.exceptionReasons)
    || candidate.exceptionReasons.some((reason) => !(typeof reason === 'string' && reason))) {
    fail('invalid_suggestion_exceptions', `${label}.exceptionReasons is invalid`);
  }
  if (!Array.isArray(candidate.warnings)
    || candidate.warnings.some((warning) => !(typeof warning === 'string' && warning))) {
    fail('invalid_suggestion_warnings', `${label}.warnings is invalid`);
  }
  if (candidate.verifyStatus === 'passed'
    && (!candidate.candidateId
      || !candidate.nintendoUsSlug
      || candidate.popularityUnverified
      || candidate.exceptionReasons.length > 0)) {
    fail('invalid_passed_suggestion', `${label} cannot pass without identity, popularity evidence, and zero exceptions`);
  }
  if (candidate.verifyStatus === 'exception' && candidate.exceptionReasons.length === 0) {
    fail('unexplained_suggestion_exception', `${label} exception needs an explicit reason`);
  }
  return candidate;
}

export function validateNintendoSuggestionDocument(document) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== NINTENDO_SUGGESTION_SCHEMA_VERSION
    || document.kind !== NINTENDO_SUGGESTION_KIND) {
    fail('unsupported_suggestion_schema', 'unsupported Nintendo suggestion document schema');
  }
  isoTimestamp(document.generatedAt, 'generatedAt');
  if (!DIGEST_RE.test(document.inputDigest ?? '')) fail('invalid_input_digest', 'Nintendo suggestion inputDigest is invalid');
  if (document.policy?.americasIdentity !== 'manual_reviewed_official_evidence_only'
    || !sameCanonicalValue(document.policy?.automaticNetworkDiscovery, [
      'nintendo_europe_official_search_and_price',
      'nintendo_japan_official_search',
    ])) {
    fail('invalid_suggestion_policy', 'Nintendo suggestion policy does not match the no-US-scraping contract');
  }
  if (!Array.isArray(document.candidates)) fail('missing_suggestion_candidates', 'Nintendo suggestions must be an array');
  const ids = new Set();
  const slugs = new Set();
  document.candidates.forEach((candidate, index) => {
    validateSuggestionCandidate(candidate, index);
    if (candidate.candidateId && ids.has(candidate.candidateId)) {
      fail('duplicate_candidate_id', `duplicate suggestion candidateId ${candidate.candidateId}`);
    }
    if (slugs.has(candidate.slug)) fail('duplicate_candidate_slug', `duplicate suggestion slug ${candidate.slug}`);
    if (candidate.candidateId) ids.add(candidate.candidateId);
    slugs.add(candidate.slug);
  });
  return document;
}

export function parseDiscoverNsuidArgs(args) {
  const result = { apply: false, inputPath: null, outputPath: null, slugs: [] };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--apply') {
      if (seen.has('--apply')) fail('duplicate_cli_option', '--apply may only appear once');
      seen.add('--apply');
      result.apply = true;
      continue;
    }
    const matched = arg.match(/^(--input|--output)(?:=(.*))?$/u);
    if (matched) {
      const flag = matched[1];
      if (seen.has(flag)) fail('duplicate_cli_option', `${flag} may only appear once`);
      seen.add(flag);
      const value = matched[2] ?? args[++index];
      if (!value || value.startsWith('--')) fail('missing_cli_value', `${flag} requires a path`);
      if (flag === '--input') result.inputPath = value;
      else result.outputPath = value;
      continue;
    }
    if (arg.startsWith('-')) fail('unknown_cli_option', `unknown discover-nsuid option: ${arg}`);
    if (!SLUG_RE.test(arg)) fail('invalid_cli_slug', `invalid slug argument: ${arg}`);
    result.slugs.push(arg);
  }
  if (result.inputPath && result.slugs.length > 0) fail('input_slug_conflict', '--input and positional slugs are mutually exclusive');
  if (result.outputPath && !result.apply) fail('output_requires_apply', '--output requires --apply');
  if (new Set(result.slugs).size !== result.slugs.length) fail('duplicate_cli_slug', 'duplicate slug argument');
  return result;
}
