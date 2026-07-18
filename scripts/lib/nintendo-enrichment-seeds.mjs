import { sha256Digest } from './candidate-evidence.mjs';
import { titleMatches } from './match.mjs';

export const NINTENDO_ENRICHMENT_DRAFT_KIND = 'nintendo-candidate-seed-draft';
export const NINTENDO_ENRICHMENT_REPORT_KIND = 'nintendo-enrichment-seed-report';
export const NINTENDO_ENRICHMENT_CACHE_KIND = 'nintendo-europe-enrichment-cache';
export const NINTENDO_ENRICHMENT_SCHEMA_VERSION = 1;
export const NINTENDO_ENRICHMENT_MIN_BATCH_SIZE = 25;
export const NINTENDO_ENRICHMENT_MAX_BATCH_SIZE = 50;
export const NINTENDO_ENRICHMENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const BASE_GAME_NSUID_RE = /^7001\d{10}$/u;
const GROUPS = ['americas', 'europe', 'japan'];
const PROJECTED_SOLR_FIELDS = Object.freeze([
  'title',
  'nsuid_txt',
  'type',
  'playable_on_txt',
  'system_names_txt',
  'digital_version_b',
  'eshop_removed_b',
  'date_from',
  'dates_released_dts',
  'price_regular_f',
  'price_lowest_f',
  'publisher',
  'publisher_txt',
  'developer',
  'developer_txt',
]);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function values(value) {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function stringValues(value) {
  return values(value).map((entry) => String(entry).trim()).filter(Boolean);
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value) {
  if (value === true || value === false) return value;
  const normalized = String(value ?? '').toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return null;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function catalogGames(catalog) {
  const games = Array.isArray(catalog) ? catalog : catalog?.games;
  if (!Array.isArray(games)) throw new Error('catalog must contain games');
  return games;
}

function hasNintendoIdentity(game) {
  return GROUPS.some((group) => BASE_GAME_NSUID_RE.test(String(game?.nsuids?.[group] ?? '')));
}

function hasSwitchPlatform(game) {
  return game?.platforms?.some((platform) => platform === 'switch' || platform === 'switch-2') ?? false;
}

/**
 * Stable target universe for a cursor-based enrichment pass. A cursor is used
 * instead of page numbers because applying an earlier batch removes games from
 * this filtered set and would otherwise make later offsets skip rows.
 */
export function selectNintendoEnrichmentTargets(catalog, {
  batchSize = NINTENDO_ENRICHMENT_MIN_BATCH_SIZE,
  startAfter = null,
} = {}) {
  if (!(Number.isInteger(batchSize)
    && batchSize >= NINTENDO_ENRICHMENT_MIN_BATCH_SIZE
    && batchSize <= NINTENDO_ENRICHMENT_MAX_BATCH_SIZE)) {
    throw new Error(`batchSize must be ${NINTENDO_ENRICHMENT_MIN_BATCH_SIZE}..${NINTENDO_ENRICHMENT_MAX_BATCH_SIZE}`);
  }
  if (startAfter != null && !(typeof startAfter === 'string' && startAfter.trim())) {
    throw new Error('startAfter must be a non-empty slug or null');
  }

  const eligible = catalogGames(catalog)
    .filter((game) => Number.isSafeInteger(game.steamAppId) && game.steamAppId > 0)
    .filter((game) => !hasSwitchPlatform(game) && !hasNintendoIdentity(game))
    .map((game) => ({
      slug: game.slug,
      title: game.title,
      steamAppId: game.steamAppId,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug, 'en'));
  const remaining = startAfter == null
    ? eligible
    : eligible.filter((target) => target.slug.localeCompare(startAfter, 'en') > 0);
  const targets = remaining.slice(0, batchSize);
  return {
    targets,
    totalEligible: eligible.length,
    remainingFromCursor: remaining.length,
    nextCursor: targets.at(-1)?.slug ?? startAfter,
    complete: remaining.length <= targets.length,
  };
}

export function catalogNintendoNsuidOwners(catalog) {
  const owners = new Map();
  for (const game of catalogGames(catalog)) {
    for (const nsuid of Object.values(game.nsuids ?? {}).filter(Boolean).map(String)) {
      const previous = owners.get(nsuid);
      if (previous && previous !== game.slug) throw new Error(`catalog NSUID ${nsuid} has multiple owners`);
      owners.set(nsuid, game.slug);
    }
  }
  return owners;
}

/** Official EU Solr query. The projection intentionally omits hits_i/score. */
export function nintendoEuropeEnrichmentUrl(title) {
  const url = new URL('https://searching.nintendo-europe.com/en/select');
  url.searchParams.set('q', String(title));
  url.searchParams.set('fq', 'type:GAME');
  url.searchParams.set('rows', '8');
  url.searchParams.set('wt', 'json');
  url.searchParams.set('fl', PROJECTED_SOLR_FIELDS.join(','));
  return url.href;
}

/**
 * Retain only identity, generation, release, and price fields. Search hit
 * counts and Solr scores are deliberately neither cached nor exposed as heat.
 */
export function projectNintendoEuropeSolrResponse(body) {
  if (!plainObject(body) || !plainObject(body.response) || !Array.isArray(body.response.docs)) {
    throw new Error('Nintendo Europe Solr response.docs is missing');
  }
  return {
    docs: body.response.docs.map((doc, index) => {
      if (!plainObject(doc)) throw new Error(`Nintendo Europe Solr doc ${index + 1} is invalid`);
      return Object.fromEntries(PROJECTED_SOLR_FIELDS
        .filter((field) => Object.hasOwn(doc, field))
        .map((field) => [field, structuredClone(doc[field])]));
    }),
  };
}

function codeGenerations(input) {
  const generations = new Set();
  for (const entry of stringValues(input)) {
    const normalized = entry.toUpperCase();
    if (normalized.includes('HAC')) generations.add('HAC');
    if (normalized.includes('BEE')) generations.add('BEE');
  }
  return generations;
}

function systemGenerations(input) {
  const generations = new Set();
  for (const entry of stringValues(input)) {
    const normalized = entry.toLowerCase();
    if (/nintendo\s+switch\s*2/u.test(normalized)) generations.add('BEE');
    else if (/nintendo\s+switch/u.test(normalized)) generations.add('HAC');
  }
  return generations;
}

function generationOf(doc) {
  const codes = codeGenerations(doc.playable_on_txt);
  const systems = systemGenerations(doc.system_names_txt);
  const combined = new Set([...codes, ...systems]);
  if (combined.size !== 1) return null;
  const generation = [...combined][0];
  if (codes.size > 0 && !codes.has(generation)) return null;
  if (systems.size > 0 && !systems.has(generation)) return null;
  return generation;
}

function baseNsuidOf(doc) {
  const ids = [...new Set(stringValues(doc.nsuid_txt).filter((id) => BASE_GAME_NSUID_RE.test(id)))];
  return ids.length === 1 ? ids[0] : null;
}

function releasedAtOf(doc) {
  const candidates = [doc.date_from, ...values(doc.dates_released_dts)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function paidPriceOf(doc) {
  const lowest = finiteNumber(doc.price_lowest_f);
  if (lowest !== null) return lowest > 0 ? { kind: 'lowest', amount: lowest } : null;
  const regular = finiteNumber(doc.price_regular_f);
  return regular !== null && regular > 0 ? { kind: 'regular', amount: regular } : null;
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function reject(reason, audit, extra = {}) {
  return { status: 'rejected', reason, candidate: null, audit, ...extra };
}

/**
 * Select exactly one official, exact-title, released, paid 7001 base game.
 * `digital_version_b=false` is not authoritative for Nintendo first-party
 * titles; a positive official indexed price is the digital-sale gate.
 */
export function evaluateNintendoEuropeEnrichment(payload, target, {
  now = Date.now(),
  existingNsuids = new Map(),
} = {}) {
  if (!plainObject(payload) || !Array.isArray(payload.docs)) {
    throw new Error('projected Nintendo Europe payload must contain docs');
  }
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('now must be a valid timestamp');
  if (!target || !(typeof target.title === 'string' && target.title.trim())) {
    throw new Error('target title is required');
  }

  const rejectedByReason = {};
  const matches = new Map();
  let exactTitleDocuments = 0;
  for (const doc of payload.docs) {
    if (!titleMatches(doc.title, target.title)) {
      increment(rejectedByReason, 'title_mismatch');
      continue;
    }
    exactTitleDocuments += 1;
    if (String(doc.type ?? '').toUpperCase() !== 'GAME') {
      increment(rejectedByReason, 'not_game');
      continue;
    }
    const nsuid = baseNsuidOf(doc);
    if (!nsuid) {
      increment(rejectedByReason, 'base_nsuid_missing_or_ambiguous');
      continue;
    }
    if (booleanValue(doc.eshop_removed_b) === true) {
      increment(rejectedByReason, 'eshop_removed');
      continue;
    }
    const releasedAt = releasedAtOf(doc);
    if (!releasedAt || Date.parse(releasedAt) > nowMs) {
      increment(rejectedByReason, 'not_released');
      continue;
    }
    const paidPrice = paidPriceOf(doc);
    if (!paidPrice) {
      increment(rejectedByReason, 'paid_digital_evidence_missing');
      continue;
    }
    const generation = generationOf(doc);
    if (!generation) {
      increment(rejectedByReason, 'generation_missing_or_conflicting');
      continue;
    }

    const key = `${nsuid}:${generation}`;
    matches.set(key, {
      nsuid,
      matchedTitle: String(doc.title),
      generation,
      releasedAt,
      paidPrice,
      publishers: stringValues(doc.publisher_txt ?? doc.publisher),
      developers: stringValues(doc.developer_txt ?? doc.developer),
    });
  }

  const audit = {
    documentsExamined: payload.docs.length,
    exactTitleDocuments,
    rejectedByReason: Object.fromEntries(Object.entries(rejectedByReason).sort()),
  };
  if (matches.size === 0) {
    const reason = exactTitleDocuments === 0
      ? 'no_exact_title_match'
      : 'no_exact_paid_released_base_generation_match';
    return reject(reason, audit);
  }
  if (matches.size > 1) {
    return reject('ambiguous_exact_matches', audit, {
      matches: [...matches.values()]
        .map(({ nsuid, generation }) => ({ nsuid, generation }))
        .sort((left, right) => `${left.nsuid}:${left.generation}`.localeCompare(`${right.nsuid}:${right.generation}`, 'en')),
    });
  }

  const candidate = [...matches.values()][0];
  const owner = existingNsuids instanceof Map
    ? existingNsuids.get(candidate.nsuid)
    : existingNsuids?.[candidate.nsuid];
  if (owner && owner !== target.slug) {
    return reject('catalog_nsuid_owned_by_other_slug', audit, {
      conflictingNsuid: candidate.nsuid,
      catalogOwner: owner,
    });
  }
  return { status: 'matched', reason: null, candidate, audit };
}

export function createNintendoEnrichmentDraftCandidate(target, match, {
  sourceUrl,
  sourceDigest,
  observedAt,
} = {}) {
  const timestamp = isoTimestamp(observedAt, 'observedAt');
  if (!(typeof sourceUrl === 'string' && sourceUrl.startsWith('https://'))) {
    throw new Error('sourceUrl must be HTTPS');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(sourceDigest ?? '')) throw new Error('sourceDigest is invalid');
  if (!BASE_GAME_NSUID_RE.test(String(match?.nsuid ?? ''))) throw new Error('match NSUID is not a 7001 base game');
  if (!['HAC', 'BEE'].includes(match.generation)) throw new Error('match generation must be HAC or BEE');
  return {
    candidateId: `ns:${match.nsuid}`,
    catalogAction: 'add_platform_mapping',
    slug: target.slug,
    title: target.title,
    platforms: [match.generation === 'BEE' ? 'switch-2' : 'switch'],
    publisher: match.publishers[0] ?? null,
    developer: match.developers[0] ?? null,
    knownNsuids: null,
    nintendoUsSlugHint: null,
    manualUsEvidence: null,
    seedEvidence: [{
      kind: 'nintendo_europe_solr_identity',
      sourceUrl,
      observedAt: timestamp,
      sourceDigest,
      nsuid: match.nsuid,
      matchedTitle: match.matchedTitle,
      generation: match.generation,
      paid: true,
      digitalBaseGame: true,
      released: true,
      releasedAt: match.releasedAt,
      indexedPriceKind: match.paidPrice.kind,
      indexedPriceAmount: match.paidPrice.amount,
    }],
    exclusivityEvidence: null,
    // Catalog membership is not independent cross-platform evidence.
    steamMatchEvidence: null,
    // EU hits_i / score are intentionally never treated as popularity.
    popularityEvidence: [],
  };
}

/** Reject every participant in a cross-game NSUID collision; never first-wins. */
export function guardNintendoEnrichmentBatchCollisions(results) {
  const owners = new Map();
  results.forEach((result, index) => {
    if (result.evaluation.status !== 'matched') return;
    const nsuid = result.evaluation.candidate.nsuid;
    owners.set(nsuid, [...(owners.get(nsuid) ?? []), index]);
  });
  const collisions = new Map([...owners].filter(([, indexes]) => indexes.length > 1));
  if (collisions.size === 0) return results;
  return results.map((result, index) => {
    if (result.evaluation.status !== 'matched') return result;
    const nsuid = result.evaluation.candidate.nsuid;
    const indexes = collisions.get(nsuid);
    if (!indexes) return result;
    return {
      ...result,
      evaluation: reject('batch_nsuid_collision', result.evaluation.audit, {
        conflictingNsuid: nsuid,
        conflictingSlugs: indexes.map((owner) => results[owner].target.slug).sort(),
      }),
    };
  });
}

export function createNintendoEnrichmentDraft({ generatedAt, candidates }) {
  return {
    schemaVersion: NINTENDO_ENRICHMENT_SCHEMA_VERSION,
    kind: NINTENDO_ENRICHMENT_DRAFT_KIND,
    generatedAt: isoTimestamp(generatedAt, 'generatedAt'),
    candidates,
  };
}

function sealDocument(payload) {
  return { ...payload, documentDigest: sha256Digest(payload) };
}

export function createNintendoEnrichmentReport(payload) {
  return sealDocument({
    schemaVersion: NINTENDO_ENRICHMENT_SCHEMA_VERSION,
    kind: NINTENDO_ENRICHMENT_REPORT_KIND,
    ...payload,
    generatedAt: isoTimestamp(payload.generatedAt, 'generatedAt'),
  });
}

export function createEmptyNintendoEnrichmentCache() {
  return sealDocument({
    schemaVersion: NINTENDO_ENRICHMENT_SCHEMA_VERSION,
    kind: NINTENDO_ENRICHMENT_CACHE_KIND,
    updatedAt: null,
    entries: {},
  });
}

export function validateNintendoEnrichmentCache(cache) {
  if (!plainObject(cache)
    || cache.schemaVersion !== NINTENDO_ENRICHMENT_SCHEMA_VERSION
    || cache.kind !== NINTENDO_ENRICHMENT_CACHE_KIND
    || !plainObject(cache.entries)) {
    throw new Error('unsupported Nintendo enrichment cache');
  }
  const { documentDigest, ...payload } = cache;
  if (!/^sha256:[0-9a-f]{64}$/u.test(documentDigest ?? '') || documentDigest !== sha256Digest(payload)) {
    throw new Error('Nintendo enrichment cache digest mismatch');
  }
  if (cache.updatedAt !== null) isoTimestamp(cache.updatedAt, 'cache.updatedAt');
  for (const [slug, entry] of Object.entries(cache.entries)) {
    if (!plainObject(entry) || entry.slug !== slug || !(typeof entry.title === 'string' && entry.title)) {
      throw new Error(`Nintendo enrichment cache entry ${slug} is invalid`);
    }
    if (!(typeof entry.sourceUrl === 'string' && entry.sourceUrl.startsWith('https://'))) {
      throw new Error(`Nintendo enrichment cache source URL is invalid: ${slug}`);
    }
    isoTimestamp(entry.collectedAt, `cache.entries.${slug}.collectedAt`);
    if (!plainObject(entry.payload) || !Array.isArray(entry.payload.docs)) {
      throw new Error(`Nintendo enrichment cache payload is invalid: ${slug}`);
    }
    if (entry.sourceDigest !== sha256Digest(entry.payload)) {
      throw new Error(`Nintendo enrichment cache source digest mismatch: ${slug}`);
    }
  }
  return cache;
}

export function cacheEntryForTarget(cache, target, {
  now = Date.now(),
  maxAgeMs = NINTENDO_ENRICHMENT_CACHE_MAX_AGE_MS,
} = {}) {
  validateNintendoEnrichmentCache(cache);
  const entry = cache.entries[target.slug];
  if (!entry
    || entry.title !== target.title
    || entry.sourceUrl !== nintendoEuropeEnrichmentUrl(target.title)) return null;
  const nowMs = now instanceof Date ? now.valueOf() : Number(now);
  const collectedMs = Date.parse(entry.collectedAt);
  if (!Number.isFinite(nowMs) || collectedMs > nowMs || nowMs - collectedMs > maxAgeMs) return null;
  return entry;
}

export function withNintendoEnrichmentCacheEntry(cache, target, {
  sourceUrl,
  collectedAt,
  payload,
} = {}) {
  validateNintendoEnrichmentCache(cache);
  const projected = plainObject(payload) && Array.isArray(payload.docs)
    ? structuredClone(payload)
    : projectNintendoEuropeSolrResponse(payload);
  const timestamp = isoTimestamp(collectedAt, 'collectedAt');
  const nextPayload = {
    schemaVersion: NINTENDO_ENRICHMENT_SCHEMA_VERSION,
    kind: NINTENDO_ENRICHMENT_CACHE_KIND,
    updatedAt: timestamp,
    entries: {
      ...structuredClone(cache.entries),
      [target.slug]: {
        slug: target.slug,
        title: target.title,
        sourceUrl,
        collectedAt: timestamp,
        sourceDigest: sha256Digest(projected),
        payload: projected,
      },
    },
  };
  return sealDocument(nextPayload);
}
