import crypto from 'node:crypto';

export const STEAM_RANKING_EVIDENCE_SCHEMA_VERSION = 1;
export const RAW_EVIDENCE_SCHEMA_VERSION = 1;
export const STEAM_RANKING_EVIDENCE_KIND = 'steam-ranking-daily';
export const RAW_EVIDENCE_KIND = 'steam-ranking-raw-response';
export const MOST_PLAYED_MAX_AGE_DAYS = 14;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(',')}}`;
  }
  throw new Error(`canonical JSON rejects ${typeof value}`);
}

export function canonicalJson(value) {
  return canonicalValue(value);
}

export function sha256Digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function withoutDocumentDigest(document) {
  const { documentDigest: _documentDigest, ...payload } = assertPlainObject(document, 'document');
  return payload;
}

export function sealEvidenceDocument(document) {
  const payload = withoutDocumentDigest(document);
  return { ...payload, documentDigest: sha256Digest(payload) };
}

export function assertDocumentDigest(document) {
  assertPlainObject(document, 'document');
  if (!DIGEST_RE.test(document.documentDigest ?? '')) throw new Error('invalid documentDigest');
  const expected = sha256Digest(withoutDocumentDigest(document));
  if (document.documentDigest !== expected) throw new Error('documentDigest mismatch');
  return document;
}

export function utcDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`invalid date: ${value}`);
  return date.toISOString().slice(0, 10);
}

export function assertUtcDate(value, label = 'date') {
  if (!DATE_RE.test(value ?? '')) throw new Error(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a real UTC date`);
  }
  return value;
}

function isoTimestamp(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`${label} must be an ISO timestamp`);
  return date.toISOString();
}

export function createRawEvidence({ sourceUrl, payload, collectedAt, sourceKind }) {
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('https://')) {
    throw new Error('raw evidence sourceUrl must be HTTPS');
  }
  if (typeof sourceKind !== 'string' || !sourceKind) throw new Error('raw evidence sourceKind is required');
  const document = {
    schemaVersion: RAW_EVIDENCE_SCHEMA_VERSION,
    kind: RAW_EVIDENCE_KIND,
    sourceKind,
    collectedAt: isoTimestamp(collectedAt, 'collectedAt'),
    sourceUrl,
    payloadDigest: sha256Digest(payload),
    payload,
  };
  return sealEvidenceDocument(document);
}

export function validateRawEvidence(document, { sourceUrl, sourceKind } = {}) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== RAW_EVIDENCE_SCHEMA_VERSION || document.kind !== RAW_EVIDENCE_KIND) {
    throw new Error('unsupported raw evidence schema');
  }
  isoTimestamp(document.collectedAt, 'raw evidence collectedAt');
  if (typeof document.sourceUrl !== 'string' || !document.sourceUrl.startsWith('https://')) {
    throw new Error('invalid raw evidence sourceUrl');
  }
  if (typeof document.sourceKind !== 'string' || !document.sourceKind) {
    throw new Error('invalid raw evidence sourceKind');
  }
  if (sourceUrl && document.sourceUrl !== sourceUrl) throw new Error('raw evidence URL mismatch');
  if (sourceKind && document.sourceKind !== sourceKind) throw new Error('raw evidence source kind mismatch');
  if (document.payloadDigest !== sha256Digest(document.payload)) throw new Error('raw payloadDigest mismatch');
  return document;
}

function integerLike(value, label, { min = 0 } = {}) {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < min) throw new Error(`${label} must be an integer >= ${min}`);
  return number;
}

function decodeHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/gu, '')
    .replace(/&#(\d+);/gu, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&nbsp;/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tagAttributes(tag) {
  const attributes = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of tag.matchAll(pattern)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function titleFromSearchRow(block) {
  for (const match of block.matchAll(/<span\b[^>]*>[\s\S]*?<\/span>/giu)) {
    const opening = match[0].match(/^<span\b[^>]*>/iu)?.[0];
    if (!opening) continue;
    const classes = (tagAttributes(opening).class ?? '').split(/\s+/u);
    if (classes.includes('title')) return decodeHtml(match[0]);
  }
  return null;
}

/**
 * Parse Steam search's JSON-wrapped HTML. Rows only supply candidate IDs and
 * ranking evidence; appdetails remains the authoritative product-type gate.
 */
export function parseSteamSearchResults(payload, { start = 0 } = {}) {
  assertPlainObject(payload, 'Steam search response');
  if (![1, true].includes(payload.success)) throw new Error('Steam search success marker changed');
  const totalCount = integerLike(payload.total_count, 'Steam search total_count');
  const responseStart = payload.start === undefined ? start : integerLike(payload.start, 'Steam search start');
  if (responseStart !== start) throw new Error(`Steam search start mismatch: ${responseStart} != ${start}`);
  if (typeof payload.results_html !== 'string') throw new Error('Steam search results_html missing');

  const rows = [];
  for (const match of payload.results_html.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu)) {
    const opening = match[0].match(/^<a\b[^>]*>/iu)?.[0];
    if (!opening) continue;
    const attributes = tagAttributes(opening);
    const classes = (attributes.class ?? '').split(/\s+/u);
    if (!classes.includes('search_result_row')) continue;
    rows.push({ block: match[0], attributes });
  }
  if (rows.length === 0 && totalCount > start) {
    throw new Error('Steam search HTML structure drift: no search_result_row anchors');
  }

  const items = [];
  const rejectedRows = [];
  for (let index = 0; index < rows.length; index += 1) {
    const { block, attributes } = rows[index];
    const rank = start + index + 1;
    const attributeId = /^\d+$/u.test(attributes['data-ds-appid'] ?? '')
      ? Number(attributes['data-ds-appid'])
      : null;
    const hrefId = attributes.href?.match(/\/app\/(\d+)(?:\/|$)/u)?.[1];
    const linkId = hrefId ? Number(hrefId) : null;
    if (!attributeId && !linkId) {
      rejectedRows.push({ rank, reason: 'missing_single_appid' });
      continue;
    }
    if (attributeId && linkId && attributeId !== linkId) {
      rejectedRows.push({ rank, reason: 'appid_href_mismatch' });
      continue;
    }
    const appId = attributeId ?? linkId;
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      rejectedRows.push({ rank, reason: 'invalid_appid' });
      continue;
    }
    const title = titleFromSearchRow(block);
    if (!title) {
      rejectedRows.push({ rank, appId, reason: 'missing_title' });
      continue;
    }
    items.push({ appId, rank, title });
  }
  if (rows.length >= 5 && rejectedRows.length > rows.length * 0.2) {
    throw new Error(`Steam search structure drift: ${rejectedRows.length}/${rows.length} rows rejected`);
  }
  return { totalCount, start, rowCount: rows.length, items, rejectedRows };
}

export function parseFeaturedTopSellers(payload) {
  assertPlainObject(payload, 'featuredcategories response');
  const items = payload.top_sellers?.items;
  if (!Array.isArray(items)) throw new Error('featuredcategories top_sellers.items missing');
  if (items.length === 0) throw new Error('featuredcategories top_sellers.items unexpectedly empty');
  const acceptedById = new Map();
  const rejectedItems = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const appId = item?.id;
    const title = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!Number.isSafeInteger(appId) || appId <= 0 || !title) {
      rejectedItems.push({ rank: index + 1, reason: 'invalid_featured_item' });
      continue;
    }
    const previous = acceptedById.get(appId);
    if (previous) {
      if (titleKey(previous.title) !== titleKey(title)) {
        throw new Error(`featuredcategories title conflict for app ${appId}`);
      }
      rejectedItems.push({
        rank: index + 1,
        appId,
        reason: 'duplicate_featured_appid',
        keptRank: previous.rank,
      });
      continue;
    }
    acceptedById.set(appId, { appId, rank: index + 1, title });
  }
  return { items: [...acceptedById.values()], rejectedItems };
}

function rollupDate(value) {
  let date;
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value > 10_000_000_000 ? value : value * 1000);
  } else if (typeof value === 'string' && /^\d+$/u.test(value)) {
    const numeric = Number(value);
    date = new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000);
  } else {
    date = new Date(value);
  }
  if (!Number.isFinite(date.valueOf())) throw new Error('GetMostPlayedGames rollup_date invalid');
  return date;
}

export function parseMostPlayedGames(payload, { now = new Date() } = {}) {
  assertPlainObject(payload, 'GetMostPlayedGames response');
  const response = assertPlainObject(payload.response, 'GetMostPlayedGames response.response');
  if (!Array.isArray(response.ranks)) throw new Error('GetMostPlayedGames ranks missing');
  if (response.ranks.length === 0) throw new Error('GetMostPlayedGames ranks unexpectedly empty');
  const rolledUpAt = rollupDate(response.rollup_date);
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.valueOf())) throw new Error('invalid freshness reference time');
  const ageMs = current.valueOf() - rolledUpAt.valueOf();
  const maxAgeMs = MOST_PLAYED_MAX_AGE_DAYS * 86_400_000;
  const accepted = ageMs >= -300_000 && ageMs <= maxAgeMs;
  const rejectedReason = accepted
    ? null
    : ageMs < -300_000 ? 'future_rollup_date' : 'stale_rollup_date';

  const rankedItems = [];
  const rejectedItems = [];
  for (const item of response.ranks) {
    try {
      const appId = integerLike(item?.appid, 'most-played appid', { min: 1 });
      const rank = integerLike(item?.rank, 'most-played rank', { min: 1 });
      const peakInGame = integerLike(item?.peak_in_game, 'most-played peak_in_game');
      rankedItems.push({ appId, rank, peakInGame });
    } catch (error) {
      rejectedItems.push({ reason: error.message });
    }
  }
  rankedItems.sort((a, b) => a.rank - b.rank || a.appId - b.appId);
  return {
    rollupDate: rolledUpAt.toISOString(),
    ageDays: Math.max(0, Math.floor(ageMs / 86_400_000)),
    accepted,
    rejectedReason,
    rankedItems,
    rejectedItems,
  };
}

function titleKey(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('en-US');
}

function assertOfficialUrl(value, { host, pathname }, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} source URL invalid`);
  }
  if (url.protocol !== 'https:' || url.host !== host || url.pathname !== pathname) {
    throw new Error(`${label} source URL is not the expected official endpoint`);
  }
  return value;
}

function assertTopSellerSearchUrl(value, { start, count }) {
  assertOfficialUrl(value, {
    host: 'store.steampowered.com',
    pathname: '/search/results/',
  }, 'Steam search');
  const url = new URL(value);
  const required = {
    start: String(start),
    count: String(count),
    filter: 'topsellers',
    infinite: '1',
    cc: 'us',
    l: 'english',
  };
  for (const [key, expected] of Object.entries(required)) {
    if (url.searchParams.get(key) !== expected) {
      throw new Error(`Steam search URL ${key} does not match collection policy`);
    }
  }
  return value;
}

function assertFeaturedUrl(value) {
  assertOfficialUrl(value, {
    host: 'store.steampowered.com',
    pathname: '/api/featuredcategories',
  }, 'featuredcategories');
  const url = new URL(value);
  if (url.searchParams.get('cc') !== 'us' || url.searchParams.get('l') !== 'english') {
    throw new Error('featuredcategories evidence must be US English');
  }
  return value;
}

function mergeRankedItems(pages) {
  const byAppId = new Map();
  for (const page of pages) {
    for (const item of page.items) {
      const previous = byAppId.get(item.appId);
      if (previous && titleKey(previous.title) !== titleKey(item.title)) {
        throw new Error(`Steam search title conflict for app ${item.appId}`);
      }
      if (!previous || item.rank < previous.rank) byAppId.set(item.appId, item);
    }
  }
  return [...byAppId.values()].sort((a, b) => a.rank - b.rank || a.appId - b.appId);
}

/** Build the small, committed daily evidence document from cached raw responses. */
export function buildDailySteamRankingEvidence({
  date,
  collectedAt,
  searchPages,
  collectionPolicy = null,
  featured,
  mostPlayed,
  freshnessNow = collectedAt,
}) {
  assertUtcDate(date);
  const observedAt = isoTimestamp(collectedAt, 'collectedAt');
  if (utcDate(observedAt) !== date) throw new Error('collectedAt must fall on the evidence UTC date');
  if (!Array.isArray(searchPages) || searchPages.length === 0) throw new Error('at least one search page is required');

  const starts = new Set();
  const parsedPages = searchPages.map((page) => {
    const sourceUrl = page?.sourceUrl;
    const start = integerLike(page?.start, 'search page start');
    const count = integerLike(page?.count, 'search page count', { min: 1 });
    if (starts.has(start)) throw new Error(`duplicate Steam search start: ${start}`);
    starts.add(start);
    assertTopSellerSearchUrl(sourceUrl, { start, count });
    const parsed = parseSteamSearchResults(page.payload, { start });
    if (parsed.rowCount > count) throw new Error('Steam search returned more rows than requested');
    return {
      start,
      count,
      sourceUrl,
      responseDigest: sha256Digest(page.payload),
      totalCount: parsed.totalCount,
      rowCount: parsed.rowCount,
      rejectedRows: parsed.rejectedRows,
      items: parsed.items,
    };
  }).sort((a, b) => a.start - b.start);

  if (parsedPages[0].start !== 0 || parsedPages[0].rowCount === 0) {
    throw new Error('Steam top-seller evidence must contain a non-empty first page');
  }

  const requestedPages = collectionPolicy?.requestedPages ?? parsedPages.length;
  const pageSize = collectionPolicy?.pageSize ?? parsedPages[0].count;
  const actualPages = parsedPages.length;
  const lastPage = parsedPages.at(-1);
  const inferredTermination = lastPage.rowCount === 0 || lastPage.start + lastPage.rowCount >= lastPage.totalCount
    ? 'source_exhausted'
    : 'requested_limit';
  const terminationReason = collectionPolicy?.terminationReason ?? inferredTermination;
  if (!Number.isSafeInteger(requestedPages) || requestedPages < 1 || requestedPages > 20) {
    throw new Error('collectionPolicy.requestedPages must be 1..20');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize < 10 || pageSize > 100) {
    throw new Error('collectionPolicy.pageSize must be 10..100');
  }
  if (actualPages > requestedPages || !['requested_limit', 'source_exhausted'].includes(terminationReason)) {
    throw new Error('collectionPolicy page coverage is inconsistent');
  }
  if (actualPages < requestedPages && terminationReason !== 'source_exhausted') {
    throw new Error('short page coverage must be marked source_exhausted');
  }
  if (parsedPages.some((page) => page.count !== pageSize)) {
    throw new Error('search page count does not match collectionPolicy.pageSize');
  }

  assertFeaturedUrl(featured.sourceUrl);
  assertOfficialUrl(mostPlayed.sourceUrl, {
    host: 'api.steampowered.com',
    pathname: '/ISteamChartsService/GetMostPlayedGames/v1/',
  }, 'GetMostPlayedGames');

  const featuredParsed = parseFeaturedTopSellers(featured.payload);
  const mostPlayedParsed = parseMostPlayedGames(mostPlayed.payload, { now: freshnessNow });
  const document = {
    schemaVersion: STEAM_RANKING_EVIDENCE_SCHEMA_VERSION,
    kind: STEAM_RANKING_EVIDENCE_KIND,
    date,
    collectedAt: observedAt,
    sources: {
      topSellers: {
        collectionPolicy: {
          requestedPages,
          pageSize,
          actualPages,
          terminationReason,
        },
        pages: parsedPages.map(({ items: _items, ...page }) => page),
        items: mergeRankedItems(parsedPages),
      },
      featuredTopSellers: {
        sourceUrl: featured.sourceUrl,
        responseDigest: sha256Digest(featured.payload),
        ...featuredParsed,
      },
      mostPlayed: {
        sourceUrl: mostPlayed.sourceUrl,
        responseDigest: sha256Digest(mostPlayed.payload),
        ...mostPlayedParsed,
      },
    },
  };
  return validateDailySteamRankingEvidence(sealEvidenceDocument(document));
}

function assertUniqueRankedItems(items, label) {
  if (!Array.isArray(items)) throw new Error(`${label} items missing`);
  const ids = new Set();
  const ranks = new Set();
  for (const item of items) {
    if (!Number.isSafeInteger(item?.appId) || item.appId <= 0) throw new Error(`${label} appId invalid`);
    if (!Number.isSafeInteger(item?.rank) || item.rank <= 0) throw new Error(`${label} rank invalid`);
    if (label !== 'mostPlayed' && (typeof item.title !== 'string' || !item.title.trim())) {
      throw new Error(`${label} title invalid`);
    }
    if (ids.has(item.appId)) throw new Error(`${label} duplicate appId ${item.appId}`);
    if (ranks.has(item.rank)) throw new Error(`${label} duplicate rank ${item.rank}`);
    ids.add(item.appId);
    ranks.add(item.rank);
  }
}

export function validateDailySteamRankingEvidence(document) {
  assertDocumentDigest(document);
  if (document.schemaVersion !== STEAM_RANKING_EVIDENCE_SCHEMA_VERSION
    || document.kind !== STEAM_RANKING_EVIDENCE_KIND) {
    throw new Error('unsupported Steam ranking evidence schema');
  }
  assertUtcDate(document.date);
  if (utcDate(isoTimestamp(document.collectedAt, 'collectedAt')) !== document.date) {
    throw new Error('Steam ranking evidence collectedAt/date mismatch');
  }
  const sources = assertPlainObject(document.sources, 'Steam ranking evidence sources');
  assertUniqueRankedItems(sources.topSellers?.items, 'topSellers');
  assertUniqueRankedItems(sources.featuredTopSellers?.items, 'featuredTopSellers');
  assertUniqueRankedItems(sources.mostPlayed?.rankedItems, 'mostPlayed');
  if (!Array.isArray(sources.topSellers?.pages) || sources.topSellers.pages.length === 0) {
    throw new Error('topSellers page evidence missing');
  }
  const policy = assertPlainObject(sources.topSellers.collectionPolicy, 'topSellers collectionPolicy');
  if (!Number.isSafeInteger(policy.requestedPages) || policy.requestedPages < 1 || policy.requestedPages > 20
    || !Number.isSafeInteger(policy.pageSize) || policy.pageSize < 10 || policy.pageSize > 100
    || policy.actualPages !== sources.topSellers.pages.length
    || policy.actualPages > policy.requestedPages
    || !['requested_limit', 'source_exhausted'].includes(policy.terminationReason)
    || (policy.actualPages < policy.requestedPages && policy.terminationReason !== 'source_exhausted')) {
    throw new Error('topSellers collectionPolicy invalid');
  }
  const pageStarts = new Set();
  for (const page of sources.topSellers.pages) {
    if (!Number.isSafeInteger(page?.start) || page.start < 0 || pageStarts.has(page.start)) {
      throw new Error('topSellers page start invalid or duplicated');
    }
    pageStarts.add(page.start);
    if (page.count !== policy.pageSize) throw new Error('topSellers page size/policy mismatch');
    assertTopSellerSearchUrl(page.sourceUrl, { start: page.start, count: page.count });
    if (!DIGEST_RE.test(page.responseDigest ?? '')) throw new Error('topSellers responseDigest invalid');
  }
  if (!pageStarts.has(0)) throw new Error('topSellers first page evidence missing');
  const sortedStarts = [...pageStarts].sort((a, b) => a - b);
  for (let index = 0; index < sortedStarts.length; index += 1) {
    if (sortedStarts[index] !== index * policy.pageSize) throw new Error('topSellers page coverage has a gap');
  }
  const lastPage = sources.topSellers.pages.toSorted((a, b) => a.start - b.start).at(-1);
  if (policy.terminationReason === 'source_exhausted'
    && lastPage.rowCount !== 0
    && lastPage.start + lastPage.rowCount < lastPage.totalCount) {
    throw new Error('topSellers source_exhausted claim is not supported by page evidence');
  }
  if (policy.terminationReason === 'requested_limit' && policy.actualPages !== policy.requestedPages) {
    throw new Error('topSellers requested_limit coverage is incomplete');
  }
  if (sources.topSellers.items.some((item) => item.rank > policy.requestedPages * policy.pageSize)) {
    throw new Error('topSellers item rank exceeds collection policy');
  }
  assertFeaturedUrl(sources.featuredTopSellers?.sourceUrl);
  assertOfficialUrl(sources.mostPlayed?.sourceUrl, {
    host: 'api.steampowered.com',
    pathname: '/ISteamChartsService/GetMostPlayedGames/v1/',
  }, 'GetMostPlayedGames');
  if (!DIGEST_RE.test(sources.featuredTopSellers?.responseDigest ?? '')
    || !DIGEST_RE.test(sources.mostPlayed?.responseDigest ?? '')) {
    throw new Error('auxiliary Steam responseDigest invalid');
  }
  if (typeof sources.mostPlayed?.accepted !== 'boolean') throw new Error('mostPlayed accepted missing');
  if (!sources.mostPlayed.accepted && !sources.mostPlayed.rejectedReason) {
    throw new Error('rejected mostPlayed evidence needs a reason');
  }
  return document;
}

export function evidenceJson(document) {
  assertDocumentDigest(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}
