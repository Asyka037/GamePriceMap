import {
  assertDocumentDigest,
  assertUtcDate,
  canonicalJson,
  sealEvidenceDocument,
  sha256Digest,
  validateDailySteamRankingEvidence,
} from './candidate-evidence.mjs';

export const STEAM_CANDIDATE_SCHEMA_VERSION = 1;
export const STEAM_CANDIDATE_KIND = 'steam-candidates';
export const STEAM_APPDETAILS_EVIDENCE_SCHEMA_VERSION = 1;
export const STEAM_APPDETAILS_EVIDENCE_KIND = 'steam-appdetails-evidence';
export const FINAL_MINIMUM_DISTINCT_DATES = 14;
// Day-one launch cohort (user policy 2026-07-17): capped at 100 titles, each
// hard-gated on long-term popularity (appdetails recommendations.total) so a
// single day's revenue chart cannot smuggle in a flash-in-the-pan release.
export const DAY_ONE_LIMIT = 100;
export const DAY_ONE_MIN_RECOMMENDATIONS = 10000;
export const RANK_POINTS_CEILING = 2001;

const NOISE_TITLE = /(?:\b(?:demo|soundtrack|playtest|dedicated server|season pass|upgrade pack|artbook)\b|\bdlc\b)/iu;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function timestamp(value, label = 'timestamp') {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.valueOf())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function appIdNumber(value, label = 'appId') {
  const appId = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(appId) || appId <= 0) throw new Error(`${label} must be a positive integer`);
  return appId;
}

function normalizedTitle(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

export function steamCandidateSlugHint(title, appId) {
  const numericAppId = appIdNumber(appId);
  const base = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/u, '');
  return base || `steam-${numericAppId}`;
}

/**
 * Retain only fields used by the paid/base-game gate and popularity score.
 * Steam appdetails responses contain large descriptions and media arrays that
 * are irrelevant to candidate selection; dropping them keeps the resumable,
 * reviewable evidence small enough to commit.
 */
export function compactSteamAppDetailsPayload(appId, payload) {
  const numericAppId = appIdNumber(appId);
  assertPlainObject(payload, 'appdetails response');
  const source = payload[String(numericAppId)];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return structuredClone(payload);
  const compact = { success: source.success };
  if (source.data && typeof source.data === 'object' && !Array.isArray(source.data)) {
    const data = source.data;
    compact.data = Object.fromEntries([
      'steam_appid',
      'name',
      'type',
      'is_free',
    ].filter((key) => Object.hasOwn(data, key)).map((key) => [key, structuredClone(data[key])]));
    const retain = (value, keys) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value);
      return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, structuredClone(value[key])]));
    };
    if (Object.hasOwn(data, 'release_date')) {
      compact.data.release_date = retain(data.release_date, ['coming_soon', 'date']);
    }
    if (Object.hasOwn(data, 'price_overview')) {
      compact.data.price_overview = retain(data.price_overview, ['currency', 'initial', 'final', 'discount_percent']);
    }
    if (Object.hasOwn(data, 'recommendations')) {
      compact.data.recommendations = retain(data.recommendations, ['total']);
    }
  }
  return { [numericAppId]: compact };
}

export function createSteamAppDetailsEvidence({ appId, payload, sourceUrl, fetchedAt }) {
  const numericAppId = appIdNumber(appId);
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('https://store.steampowered.com/')) {
    throw new Error('appdetails evidence must use the official Steam Store host');
  }
  const compactPayload = compactSteamAppDetailsPayload(numericAppId, payload);
  return sealEvidenceDocument({
    schemaVersion: STEAM_APPDETAILS_EVIDENCE_SCHEMA_VERSION,
    kind: STEAM_APPDETAILS_EVIDENCE_KIND,
    appId: numericAppId,
    fetchedAt: timestamp(fetchedAt, 'fetchedAt'),
    sourceUrl,
    responseDigest: sha256Digest(compactPayload),
    payload: compactPayload,
  });
}

export function validateSteamAppDetailsEvidence(document, { appId } = {}) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== STEAM_APPDETAILS_EVIDENCE_SCHEMA_VERSION
    || document.kind !== STEAM_APPDETAILS_EVIDENCE_KIND) {
    throw new Error('unsupported Steam appdetails evidence schema');
  }
  const actualAppId = appIdNumber(document.appId, 'appdetails evidence appId');
  if (appId !== undefined && actualAppId !== appIdNumber(appId)) throw new Error('appdetails evidence appId mismatch');
  timestamp(document.fetchedAt, 'appdetails evidence fetchedAt');
  if (typeof document.sourceUrl !== 'string'
    || !document.sourceUrl.startsWith('https://store.steampowered.com/api/appdetails?')) {
    throw new Error('appdetails evidence source URL invalid');
  }
  const sourceUrl = new URL(document.sourceUrl);
  if (sourceUrl.host !== 'store.steampowered.com'
    || sourceUrl.pathname !== '/api/appdetails'
    || sourceUrl.searchParams.get('appids') !== String(actualAppId)
    || sourceUrl.searchParams.get('cc') !== 'us'
    || sourceUrl.searchParams.get('l') !== 'english') {
    throw new Error('appdetails evidence must be a single-app US English request');
  }
  if (document.responseDigest !== sha256Digest(document.payload)) throw new Error('appdetails responseDigest mismatch');
  return document;
}

function rejected(reason, details = {}) {
  return { accepted: false, reason, ...details };
}

/**
 * Fail-closed paid-base-game gate. recommendations.total is deliberately
 * exposed as recommendationCount, never as reviews or reviewCount.
 */
export function gateSteamAppDetails(appId, payload, { expectedTitles = [], now = new Date() } = {}) {
  const numericAppId = appIdNumber(appId);
  assertPlainObject(payload, 'appdetails response');
  const keys = Object.keys(payload);
  const entry = payload[String(numericAppId)];
  if (!entry) {
    if (keys.length > 0) return rejected('appid_response_mismatch', { responseKeys: keys.sort() });
    throw new Error('appdetails response is empty');
  }
  assertPlainObject(entry, `appdetails entry ${numericAppId}`);
  if (typeof entry.success !== 'boolean') throw new Error('appdetails success marker changed');
  if (!entry.success) return rejected('appdetails_unsuccessful');
  const data = assertPlainObject(entry.data, `appdetails data ${numericAppId}`);

  if (data.steam_appid !== numericAppId) return rejected('steam_appid_mismatch');
  if (typeof data.name !== 'string' || !data.name.trim()) return rejected('missing_title');
  const title = data.name.trim();
  if (NOISE_TITLE.test(title)) return rejected('excluded_title_noise', { title });

  const distinctExpectedTitles = [...new Set(expectedTitles.map(normalizedTitle).filter(Boolean))];
  if (distinctExpectedTitles.length > 1) {
    return rejected('conflicting_ranking_titles', { expectedTitles: [...expectedTitles].sort() });
  }
  if (distinctExpectedTitles.length === 1 && distinctExpectedTitles[0] !== normalizedTitle(title)) {
    return rejected('title_mismatch', { title, expectedTitles: [...expectedTitles].sort() });
  }

  if (data.type !== 'game') return rejected('not_base_game', { productType: data.type ?? null });
  if (data.is_free !== false) return rejected(data.is_free === true ? 'free_game' : 'missing_is_free');

  const release = data.release_date;
  if (!release || typeof release !== 'object' || typeof release.coming_soon !== 'boolean') {
    return rejected('missing_release_status');
  }
  if (release.coming_soon) return rejected('unreleased');
  if (typeof release.date !== 'string' || !release.date.trim()) return rejected('missing_release_date');
  const parsedRelease = Date.parse(release.date);
  const current = new Date(now);
  if (!Number.isFinite(current.valueOf())) throw new Error('invalid appdetails gate reference time');
  if (Number.isFinite(parsedRelease) && parsedRelease > current.valueOf() + 86_400_000) {
    return rejected('future_release_date', { releaseDate: release.date });
  }

  const price = data.price_overview;
  if (!price || typeof price !== 'object') return rejected('missing_us_price');
  if (price.currency !== 'USD') return rejected('non_usd_us_price', { currency: price.currency ?? null });
  if (!Number.isSafeInteger(price.initial) || price.initial <= 0) return rejected('missing_positive_us_list_price');
  if (!Number.isSafeInteger(price.final) || price.final < 0) return rejected('invalid_us_current_price');
  if (!Number.isInteger(price.discount_percent)
    || price.discount_percent < 0
    || price.discount_percent > 100) {
    return rejected('invalid_discount_percent');
  }

  let recommendationCount = null;
  if (data.recommendations !== undefined) {
    if (!data.recommendations
      || typeof data.recommendations !== 'object'
      || !Number.isSafeInteger(data.recommendations.total)
      || data.recommendations.total < 0) {
      return rejected('invalid_recommendation_count');
    }
    recommendationCount = data.recommendations.total;
  }

  return {
    accepted: true,
    appId: numericAppId,
    candidateId: `steam:${numericAppId}`,
    title,
    productType: data.type,
    isFree: data.is_free,
    releaseDate: release.date,
    usListPrice: price.initial / 100,
    usCurrentPrice: price.final / 100,
    usDiscountPercent: price.discount_percent,
    currency: price.currency,
    recommendationCount,
    titleEvidence: distinctExpectedTitles.length === 1 ? 'ranking_exact_match' : 'appdetails_only',
    sourceUrl: `https://store.steampowered.com/app/${numericAppId}/`,
  };
}

function dedupeSamples(samples, mode) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error('Steam ranking evidence is empty');
  if (!['pilot', 'final', 'day-one'].includes(mode)) throw new Error(`unsupported candidate mode: ${mode}`);
  const byDate = new Map();
  for (const source of samples) {
    const sample = validateDailySteamRankingEvidence(source);
    const previous = byDate.get(sample.date);
    if (previous && previous.documentDigest !== sample.documentDigest) {
      throw new Error(`conflicting Steam ranking evidence for UTC date ${sample.date}`);
    }
    byDate.set(sample.date, sample);
  }
  const distinct = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (mode === 'final' && distinct.length < FINAL_MINIMUM_DISTINCT_DATES) {
    throw new Error(`final mode requires ${FINAL_MINIMUM_DISTINCT_DATES} distinct UTC dates; found ${distinct.length}`);
  }
  return distinct;
}

function candidatePool(samples) {
  const pool = new Map();
  const entry = (appId) => {
    if (!pool.has(appId)) {
      pool.set(appId, {
        appId,
        titles: new Set(),
        topSellerRanks: new Map(),
        featuredRanks: [],
        mostPlayed: [],
        sampleDigests: new Set(),
      });
    }
    return pool.get(appId);
  };
  const sourceRejections = [];

  for (const sample of samples) {
    for (const item of sample.sources.topSellers.items) {
      const record = entry(item.appId);
      record.titles.add(item.title);
      record.topSellerRanks.set(sample.date, item.rank);
      record.sampleDigests.add(sample.documentDigest);
    }
    for (const item of sample.sources.featuredTopSellers.items) {
      const record = entry(item.appId);
      record.titles.add(item.title);
      record.featuredRanks.push({ date: sample.date, rank: item.rank });
      record.sampleDigests.add(sample.documentDigest);
    }
    const mostPlayed = sample.sources.mostPlayed;
    if (mostPlayed.accepted) {
      for (const item of mostPlayed.rankedItems) {
        const record = entry(item.appId);
        record.mostPlayed.push({ date: sample.date, rank: item.rank, peakInGame: item.peakInGame });
        record.sampleDigests.add(sample.documentDigest);
      }
    } else {
      sourceRejections.push({
        date: sample.date,
        source: 'GetMostPlayedGames',
        reason: mostPlayed.rejectedReason,
        rollupDate: mostPlayed.rollupDate,
      });
    }
  }
  return { pool, sourceRejections };
}

function knownCatalogAppIds(catalog) {
  const games = Array.isArray(catalog) ? catalog : catalog?.games;
  if (!Array.isArray(games)) throw new Error('catalog must be a games array or { games }');
  const known = new Set();
  for (const game of games) {
    if (game?.steamAppId === null || game?.steamAppId === undefined) continue;
    known.add(appIdNumber(game.steamAppId, 'catalog steamAppId'));
  }
  return known;
}

function appDetailsEvidenceMap(input) {
  const records = input instanceof Map ? [...input.entries()] : Object.entries(input ?? {});
  const result = new Map();
  for (const [key, value] of records) {
    const appId = appIdNumber(key, 'appdetails map key');
    validateSteamAppDetailsEvidence(value, { appId });
    result.set(appId, value);
  }
  return result;
}

function rankPoints(rank) {
  return Math.max(1, RANK_POINTS_CEILING - rank);
}

function poolPriority(record) {
  const rankScore = [...record.topSellerRanks.values()].reduce((sum, rank) => sum + rankPoints(rank), 0);
  const featured = record.featuredRanks.length ? 101 - Math.min(...record.featuredRanks.map((item) => item.rank)) : 0;
  const mostPlayed = record.mostPlayed.length ? 101 - Math.min(...record.mostPlayed.map((item) => item.rank)) : 0;
  return record.topSellerRanks.size * 100_000 + rankScore + Math.max(0, featured) + Math.max(0, mostPlayed);
}

function scoredCandidate(record, gate, mode) {
  const topSellerRanks = [...record.topSellerRanks.entries()]
    .map(([date, rank]) => ({ date, rank }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const appearanceCount = topSellerRanks.length;
  const topSellerRankPoints = topSellerRanks.reduce((sum, observation) => sum + rankPoints(observation.rank), 0);
  const recommendationProxyPoints = Math.round(Math.log10((gate.recommendationCount ?? 0) + 1) * 1000);
  const bestFeaturedRank = record.featuredRanks.length
    ? Math.min(...record.featuredRanks.map((item) => item.rank))
    : null;
  const bestMostPlayedRank = record.mostPlayed.length
    ? Math.min(...record.mostPlayed.map((item) => item.rank))
    : null;
  const auxiliaryPoints = (bestFeaturedRank ? Math.max(1, 101 - bestFeaturedRank) : 0)
    + (bestMostPlayedRank ? Math.max(1, 101 - bestMostPlayedRank) : 0);
  const popularityScore = appearanceCount * 100_000
    + topSellerRankPoints
    + recommendationProxyPoints
    + auxiliaryPoints;
  return {
    candidateId: gate.candidateId,
    catalogAction: 'new_game',
    steamAppId: gate.appId,
    slugHint: steamCandidateSlugHint(gate.title, gate.appId),
    title: gate.title,
    platforms: ['pc'],
    sourceUrl: gate.sourceUrl,
    humanDecision: '待定',
    provisional: mode === 'pilot',
    popularityScore,
    recommendationCount: gate.recommendationCount,
    signals: {
      topSellersAppearanceCount: appearanceCount,
      topSellersRankPoints: topSellerRankPoints,
      bestFeaturedTopSellerRank: bestFeaturedRank,
      bestMostPlayedRank,
      recommendationProxyPoints,
      auxiliaryPoints,
    },
    paidGate: {
      productType: gate.productType,
      isFree: gate.isFree,
      releaseDate: gate.releaseDate,
      usListPrice: gate.usListPrice,
      usCurrentPrice: gate.usCurrentPrice,
      usDiscountPercent: gate.usDiscountPercent,
      currency: gate.currency,
      titleEvidence: gate.titleEvidence,
    },
    evidence: {
      schemaVersion: 1,
      expectedTitles: [...record.titles].sort(),
      topSellerRanks,
      featuredTopSellerObservations: record.featuredRanks
        .toSorted((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank),
      mostPlayedObservations: record.mostPlayed
        .toSorted((a, b) => a.date.localeCompare(b.date) || a.rank - b.rank),
      rankingSampleDigests: [...record.sampleDigests].sort(),
    },
  };
}

export function compareSteamCandidates(a, b) {
  return b.popularityScore - a.popularityScore
    || b.signals.topSellersAppearanceCount - a.signals.topSellersAppearanceCount
    || b.signals.topSellersRankPoints - a.signals.topSellersRankPoints
    || (b.recommendationCount ?? 0) - (a.recommendationCount ?? 0)
    || a.steamAppId - b.steamAppId;
}

function candidateEvidencePayload(candidate) {
  return {
    candidateId: candidate.candidateId,
    steamAppId: candidate.steamAppId,
    slugHint: candidate.slugHint,
    title: candidate.title,
    sourceRank: candidate.sourceRank,
    provisional: candidate.provisional,
    popularityScore: candidate.popularityScore,
    recommendationCount: candidate.recommendationCount,
    signals: candidate.signals,
    paidGate: candidate.paidGate,
    evidence: candidate.evidence,
  };
}

export function buildSteamCandidateDocument({
  samples,
  appDetailsById,
  catalog,
  mode = 'pilot',
  limit = 1000,
  generatedAt = new Date(),
}) {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5000) throw new Error('candidate limit must be 1..5000');
  if (mode === 'day-one' && limit > DAY_ONE_LIMIT) throw new Error(`day-one limit must be <= ${DAY_ONE_LIMIT}`);
  const distinctSamples = dedupeSamples(samples, mode);
  const { pool, sourceRejections } = candidatePool(distinctSamples);
  const known = knownCatalogAppIds(catalog);
  const appDetails = appDetailsEvidenceMap(appDetailsById);
  const rejectedCandidates = [];
  const pendingCandidates = [];
  const acceptedCandidates = [];
  let headIncomplete = false;

  const prioritizedPool = [...pool.values()].sort((a, b) => poolPriority(b) - poolPriority(a) || a.appId - b.appId);
  for (const record of prioritizedPool) {
    const candidateId = `steam:${record.appId}`;
    if (known.has(record.appId)) {
      rejectedCandidates.push({ candidateId, steamAppId: record.appId, reason: 'already_in_catalog' });
      continue;
    }
    const details = appDetails.get(record.appId);
    if (!details) {
      // In day-one mode a coverage gap ahead of the cut-off makes the cohort
      // unrankable: the head of the official chart must be fully evidenced.
      if (mode === 'day-one' && acceptedCandidates.length < limit) headIncomplete = true;
      pendingCandidates.push({ candidateId, steamAppId: record.appId, reason: 'missing_appdetails_evidence' });
      continue;
    }
    const gate = gateSteamAppDetails(record.appId, details.payload, {
      expectedTitles: [...record.titles],
      now: generatedAt,
    });
    if (!gate.accepted) {
      rejectedCandidates.push({
        candidateId,
        steamAppId: record.appId,
        reason: gate.reason,
        details: Object.fromEntries(Object.entries(gate).filter(([key]) => !['accepted', 'reason'].includes(key))),
        appDetailsEvidenceDigest: details.documentDigest,
      });
      continue;
    }
    if (mode === 'day-one' && (gate.recommendationCount ?? 0) < DAY_ONE_MIN_RECOMMENDATIONS) {
      rejectedCandidates.push({
        candidateId,
        steamAppId: record.appId,
        reason: 'below_day_one_recommendation_floor',
        appDetailsEvidenceDigest: details.documentDigest,
      });
      continue;
    }
    const candidate = scoredCandidate(record, gate, mode);
    candidate.evidence.appDetailsEvidenceDigest = details.documentDigest;
    acceptedCandidates.push(candidate);
  }

  if (mode !== 'day-one') acceptedCandidates.sort(compareSteamCandidates);
  const candidates = acceptedCandidates.slice(0, limit).map((candidate, index) => {
    const ranked = { ...candidate, sourceRank: index + 1 };
    ranked.evidenceDigest = sha256Digest(candidateEvidencePayload(ranked));
    return ranked;
  });
  const generatedTimestamp = timestamp(generatedAt, 'generatedAt');
  return sealEvidenceDocument({
    schemaVersion: STEAM_CANDIDATE_SCHEMA_VERSION,
    kind: STEAM_CANDIDATE_KIND,
    generatedAt: generatedTimestamp,
    mode,
    provisional: mode === 'pilot',
    minimumDistinctDatesForFinal: FINAL_MINIMUM_DISTINCT_DATES,
    distinctUtcDates: distinctSamples.map((sample) => sample.date),
    rankingSampleDigests: distinctSamples.map((sample) => sample.documentDigest),
    scorePolicy: {
      version: 1,
      description: 'daily top-seller frequency + rank points, then recommendationCount and official auxiliary signals',
      topSellerAppearanceWeight: 100000,
      rankPointsCeiling: RANK_POINTS_CEILING,
      recommendationTransform: 'round(log10(recommendationCount + 1) * 1000)',
      auxiliaryTransform: 'max(1, 101 - best official rank) for featured and fresh most-played signals',
      recommendationFieldSemantics: 'appdetails.recommendations.total (long-term popularity proxy; not reviewCount)',
      slugPolicy: 'slugHint is title kebab only; import verification freezes base, then release year, then AppID on collision',
    },
    pool: {
      discovered: pool.size,
      appDetailsEvidence: [...pool.keys()].filter((appId) => appDetails.has(appId)).length,
      acceptedBeforeLimit: acceptedCandidates.length,
      emitted: candidates.length,
      rejected: rejectedCandidates.length,
      pending: pendingCandidates.length,
      incomplete: pendingCandidates.length > 0,
      headIncomplete,
    },
    sourceRejections,
    candidates,
    rejectedCandidates,
    pendingCandidates,
  });
}

export function validateSteamCandidateDocument(document) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== STEAM_CANDIDATE_SCHEMA_VERSION || document.kind !== STEAM_CANDIDATE_KIND) {
    throw new Error('unsupported Steam candidate schema');
  }
  if (!['pilot', 'final', 'day-one'].includes(document.mode)) throw new Error('Steam candidate mode invalid');
  if (document.mode === 'day-one') {
    if (document.candidates.length > DAY_ONE_LIMIT) throw new Error('day-one cohort exceeds 100 candidates');
    for (const candidate of document.candidates) {
      if (!(candidate.recommendationCount >= DAY_ONE_MIN_RECOMMENDATIONS)) {
        throw new Error(`day-one candidate ${candidate.candidateId} below the ${DAY_ONE_MIN_RECOMMENDATIONS} recommendation floor`);
      }
    }
  }
  if (!Array.isArray(document.distinctUtcDates)
    || new Set(document.distinctUtcDates).size !== document.distinctUtcDates.length
    || document.distinctUtcDates.some((date, index, dates) => {
      try {
        assertUtcDate(date);
      } catch {
        return true;
      }
      return index > 0 && date <= dates[index - 1];
    })) {
    throw new Error('Steam candidate UTC dates must be distinct and sorted');
  }
  if (document.provisional !== (document.mode === 'pilot')) throw new Error('Steam candidate document provisional flag mismatch');
  if (!Array.isArray(document.rankingSampleDigests)
    || document.rankingSampleDigests.length !== document.distinctUtcDates.length
    || document.rankingSampleDigests.some((digest) => !/^sha256:[0-9a-f]{64}$/u.test(digest))) {
    throw new Error('Steam candidate ranking sample digests invalid');
  }
  if (document.mode === 'final' && document.distinctUtcDates.length < FINAL_MINIMUM_DISTINCT_DATES) {
    throw new Error('final candidate document lacks 14 distinct UTC dates');
  }
  if (!Array.isArray(document.candidates)) throw new Error('Steam candidate list missing');
  const ids = new Set();
  for (let index = 0; index < document.candidates.length; index += 1) {
    const candidate = document.candidates[index];
    if (candidate.candidateId !== `steam:${candidate.steamAppId}`) throw new Error('Steam candidateId mismatch');
    if (candidate.catalogAction !== 'new_game'
      || candidate.platforms?.length !== 1
      || candidate.platforms[0] !== 'pc') {
      throw new Error('Steam candidate catalog action/platform invalid');
    }
    if (candidate.slugHint !== steamCandidateSlugHint(candidate.title, candidate.steamAppId)) {
      throw new Error('Steam candidate slugHint is not deterministic');
    }
    if (ids.has(candidate.candidateId)) throw new Error(`duplicate candidate ${candidate.candidateId}`);
    ids.add(candidate.candidateId);
    if (candidate.sourceRank !== index + 1) throw new Error('Steam candidate sourceRank is not contiguous');
    if (candidate.provisional !== document.provisional) throw new Error('Steam candidate provisional flag mismatch');
    if (candidate.humanDecision !== '待定') throw new Error('machine-generated Steam candidate decision must be pending');
    if (candidate.evidence?.schemaVersion !== 1) throw new Error('Steam candidate evidence schema invalid');
    if (candidate.evidenceDigest !== sha256Digest(candidateEvidencePayload(candidate))) {
      throw new Error('candidate evidenceDigest invalid');
    }
    if ('reviewCount' in candidate) throw new Error('Steam candidates must not relabel recommendations as reviewCount');
  }
  return document;
}

export function candidateDocumentJson(document) {
  validateSteamCandidateDocument(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

// Kept exported for fixture/debug tooling without duplicating digest semantics.
export { canonicalJson };
