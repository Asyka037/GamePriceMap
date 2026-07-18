import crypto from 'node:crypto';
import { normTitle, titleMatches } from './match.mjs';
import { validateSteamCandidateDocument } from './steam-candidates.mjs';

export const NINTENDO_POPULARITY_MANIFEST_SCHEMA_VERSION = 1;
export const NINTENDO_POPULARITY_MANIFEST_KIND = 'nintendo-popularity-source-manifest';
export const NINTENDO_POPULARITY_DRAFT_KIND = 'nintendo-candidate-seed-draft';
export const NINTENDO_POPULARITY_REPORT_KIND = 'nintendo-popularity-seed-report';
export const NINTENDO_POPULARITY_BATCH_SIZE = 25;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SWITCH_PLATFORMS = new Set(['switch', 'switch-2']);
const SOURCE_KINDS = new Set([
  'nintendo_ir_top_sellers_html',
  'nintendo_ir_reviewed_table',
  'steam_final_candidates',
]);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function isoTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) fail('invalid_timestamp', `${label} must be a valid timestamp`);
  return date.toISOString();
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') fail('invalid_source_url', `${label} must be HTTPS`);
    return url;
  } catch (error) {
    if (error?.code) throw error;
    return fail('invalid_source_url', `${label} must be an absolute HTTPS URL`);
  }
}

function officialNintendoIrUrl(value, label) {
  const url = httpsUrl(value, label);
  if (!['nintendo.co.jp', 'www.nintendo.co.jp'].includes(url.hostname)
    || !url.pathname.startsWith('/ir/')) {
    fail('nintendo_ir_source_not_official', `${label} must point to Nintendo IR`);
  }
  return url;
}

function officialNintendoUrl(value, label) {
  const url = httpsUrl(value, label);
  const host = url.hostname.toLowerCase();
  if (!(host === 'nintendo.com'
    || host.endsWith('.nintendo.com')
    || host === 'nintendo.co.jp'
    || host.endsWith('.nintendo.co.jp')
    || host === 'nintendo-europe.com'
    || host.endsWith('.nintendo-europe.com'))) {
    fail('nintendo_platform_source_not_official', `${label} must point to an official Nintendo host`);
  }
  return url;
}

function normalizedSwitchPlatforms(value, label) {
  if (!Array.isArray(value) || value.length !== 1 || !SWITCH_PLATFORMS.has(value[0])) {
    fail('platform_generation_not_explicit', `${label} must contain exactly one of switch or switch-2`);
  }
  return [...value];
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid_positive_integer', `${label} must be a positive integer`);
  return value;
}

function positiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) fail('invalid_positive_number', `${label} must be a positive number`);
  return value;
}

function nonEmptyString(value, label) {
  if (!(typeof value === 'string' && value.trim())) fail('missing_string', `${label} must be a non-empty string`);
  return value.trim();
}

function digest(value, label) {
  if (!DIGEST_RE.test(value ?? '')) fail('invalid_source_digest', `${label} must be a sha256 digest`);
  return value;
}

export function sourceBytesDigest(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?\s*>/giu, ' ')
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

function classBlock(block, tag, className) {
  const pattern = new RegExp(`<${tag}\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`, 'iu');
  return block.match(pattern)?.[1] ?? null;
}

function canonicalUrl(value) {
  const url = new URL(value);
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.href;
}

function slugFromTitle(title) {
  const slug = String(title)
    .replace(/[™®©℠]/gu, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/gu, ' and ')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72)
    .replace(/-+$/u, '');
  if (!SLUG_RE.test(slug)) fail('ir_title_has_no_safe_slug', `Nintendo IR title needs an explicit reviewed slug: ${title}`);
  return slug;
}

/**
 * Parse Nintendo's saved IR "Top Selling Title Sales Units" page. Titles,
 * generation, rank, and unit figures all come from the retained page; no
 * product identity or platform is inferred from EU/JP search scores.
 */
export function parseNintendoIrTopSellersHtml(html, { sourceUrl } = {}) {
  const source = officialNintendoIrUrl(sourceUrl, 'Nintendo IR sourceUrl');
  const text = Buffer.isBuffer(html) ? html.toString('utf8') : String(html ?? '');
  const og = text.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["'][^>]*>/iu)
    ?? text.match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:url["'][^>]*>/iu);
  if (!og || canonicalUrl(og[1]) !== canonicalUrl(source.href)) {
    fail('ir_canonical_url_mismatch', 'saved Nintendo IR page canonical URL does not match sourceUrl');
  }

  const hardware = text.match(/<div\b[^>]*class=["'][^"']*\bsales_hard\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*alt=["'](Nintendo Switch(?: 2)? software)["']/iu)?.[1];
  const platform = hardware === 'Nintendo Switch software'
    ? 'switch'
    : hardware === 'Nintendo Switch 2 software'
      ? 'switch-2'
      : null;
  if (!platform) fail('ir_platform_marker_missing', 'saved Nintendo IR page lacks one exact Switch generation marker');

  const rows = [];
  const rowPattern = /<li\b[^>]*class=["'][^"']*\bsales_layout_list\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/giu;
  for (const match of text.matchAll(rowPattern)) {
    const titleHtml = classBlock(match[1], 'p', 'sales_title');
    const valueHtml = classBlock(match[1], 'p', 'sales_value');
    if (!titleHtml || !valueHtml) fail('ir_row_structure_changed', 'Nintendo IR sales row is missing title or value');
    const title = decodeHtml(titleHtml);
    const unitsMatch = valueHtml.match(/<span\b[^>]*>([0-9]+(?:\.[0-9]+)?)<\/span>\s*million\s+pcs\./iu);
    if (!title || !unitsMatch) fail('ir_row_structure_changed', 'Nintendo IR sales row value structure changed');
    rows.push({
      rank: rows.length + 1,
      title,
      platforms: [platform],
      unitsMillions: Number(unitsMatch[1]),
      combinedTitles: /\s\/\s|\/\s*<br/iu.test(titleHtml),
      sourceLocator: `sales_layout_list:${rows.length + 1}`,
    });
  }
  if (rows.length === 0) fail('ir_rows_missing', 'saved Nintendo IR page contains no sales rows');
  return { platform, rows };
}

function catalogGames(catalog) {
  const games = Array.isArray(catalog) ? catalog : catalog?.games;
  if (!Array.isArray(games)) fail('invalid_catalog', 'catalog must contain games');
  return games;
}

function hasNintendoMapping(game) {
  return Object.values(game?.nsuids ?? {}).some(Boolean);
}

function catalogIndexes(catalog) {
  const games = catalogGames(catalog);
  const byTitle = new Map();
  const bySlug = new Map();
  const bySteamAppId = new Map();
  for (const game of games) {
    const titleKey = normTitle(game.title);
    if (!titleKey) fail('catalog_title_invalid', `catalog title is invalid for ${game.slug}`);
    if (byTitle.has(titleKey) && byTitle.get(titleKey).slug !== game.slug) {
      fail('catalog_title_ambiguous', `catalog has duplicate normalized title ${game.title}`);
    }
    byTitle.set(titleKey, game);
    bySlug.set(game.slug, game);
    if (Number.isSafeInteger(game.steamAppId) && game.steamAppId > 0) bySteamAppId.set(game.steamAppId, game);
  }
  return { byTitle, bySlug, bySteamAppId };
}

function catalogCandidateIdentity(record, indexes) {
  const steamOwner = record.steamAppId ? indexes.bySteamAppId.get(record.steamAppId) : null;
  const titleOwner = indexes.byTitle.get(normTitle(record.title));
  if (steamOwner && titleOwner && steamOwner.slug !== titleOwner.slug) {
    return { rejected: 'catalog_identity_conflict' };
  }
  const existing = steamOwner ?? titleOwner ?? null;
  if (existing) {
    if (!titleMatches(record.title, existing.title)) return { rejected: 'catalog_title_conflict' };
    if (hasNintendoMapping(existing)) return { rejected: 'already_has_nintendo_mapping' };
    return {
      existing,
      slug: existing.slug,
      catalogAction: 'add_platform_mapping',
    };
  }
  const slugOwner = indexes.bySlug.get(record.slug);
  if (slugOwner) return { rejected: 'catalog_slug_conflict' };
  return { existing: null, slug: record.slug, catalogAction: 'new_game' };
}

function evidenceBase(source, row) {
  return {
    sourceUrl: source.sourceUrl,
    observedAt: source.observedAt,
    sourceDigest: source.sourceDigest,
    title: row.title,
    platforms: [...row.platforms],
    sourceLocator: row.sourceLocator,
  };
}

function irRecord(source, row) {
  const base = evidenceBase(source, row);
  return {
    sourceKey: `ir:${source.sourceDigest.slice(7, 19)}:${String(row.rank).padStart(4, '0')}:${row.slug}`,
    sourceType: 'nintendo_ir',
    priorityGroup: 0,
    priorityValue: row.rank,
    title: row.title,
    slug: row.slug,
    platforms: row.platforms,
    steamAppId: null,
    publisher: row.publisher ?? null,
    developer: row.developer ?? null,
    seedEvidence: [{
      kind: 'nintendo_ir_sales_table_row',
      ...base,
      rank: row.rank,
      unitsMillions: row.unitsMillions,
      extractionMode: source.extractionMode,
    }],
    popularityEvidence: [{
      kind: 'nintendo_official_rank',
      ...base,
      rank: row.rank,
      unitsMillions: row.unitsMillions,
      extractionMode: source.extractionMode,
    }],
    steamMatchEvidence: null,
  };
}

function validatedReviewedIrRows(source) {
  if (!Array.isArray(source.rows) || source.rows.length === 0) {
    fail('ir_reviewed_rows_missing', 'reviewed Nintendo IR table source needs rows');
  }
  const ranks = new Set();
  return source.rows.map((row, index) => {
    if (!plainObject(row)) fail('ir_reviewed_row_invalid', `reviewed IR row ${index + 1} must be an object`);
    const title = nonEmptyString(row.title, `reviewed IR row ${index + 1}.title`);
    const slug = nonEmptyString(row.slug, `reviewed IR row ${index + 1}.slug`);
    if (!SLUG_RE.test(slug)) fail('invalid_seed_slug', `reviewed IR row ${index + 1}.slug is invalid`);
    const platforms = normalizedSwitchPlatforms(row.platforms, `reviewed IR row ${index + 1}.platforms`);
    const rank = positiveInteger(row.rank, `reviewed IR row ${index + 1}.rank`);
    if (ranks.has(rank)) fail('duplicate_ir_rank', `reviewed IR rank ${rank} is duplicated`);
    ranks.add(rank);
    return {
      title,
      slug,
      platforms,
      rank,
      unitsMillions: positiveNumber(row.unitsMillions, `reviewed IR row ${index + 1}.unitsMillions`),
      sourceLocator: nonEmptyString(row.sourceLocator, `reviewed IR row ${index + 1}.sourceLocator`),
      publisher: row.publisher == null ? null : nonEmptyString(row.publisher, `reviewed IR row ${index + 1}.publisher`),
      developer: row.developer == null ? null : nonEmptyString(row.developer, `reviewed IR row ${index + 1}.developer`),
      combinedTitles: false,
    };
  });
}

function readBoundBytes(source, readSource) {
  nonEmptyString(source.file, 'source.file');
  const bytes = readSource(source.file);
  if (!(Buffer.isBuffer(bytes) || typeof bytes === 'string')) {
    fail('source_file_invalid', `source reader did not return bytes for ${source.file}`);
  }
  const expected = digest(source.sourceDigest, 'source.sourceDigest');
  const actual = sourceBytesDigest(bytes);
  if (actual !== expected) fail('source_digest_mismatch', `${source.file} source digest mismatch`);
  return bytes;
}

function loadIrSource(source, readSource) {
  const sourceUrl = officialNintendoIrUrl(source.sourceUrl, 'source.sourceUrl').href;
  const observedAt = isoTimestamp(source.observedAt, 'source.observedAt');
  const bytes = readBoundBytes(source, readSource);
  const common = { ...source, sourceUrl, observedAt, sourceDigest: source.sourceDigest };
  if (source.kind === 'nintendo_ir_top_sellers_html') {
    const parsed = parseNintendoIrTopSellersHtml(bytes, { sourceUrl });
    return {
      ...common,
      extractionMode: 'machine_html',
      rows: parsed.rows.map((row) => ({ ...row, slug: slugFromTitle(row.title) })),
    };
  }
  return {
    ...common,
    extractionMode: 'reviewed_table',
    rows: validatedReviewedIrRows(source),
  };
}

function validatePlatformEvidence(evidence, binding, readSource) {
  if (!plainObject(evidence)) fail('platform_evidence_missing', `Steam binding ${binding.steamAppId} needs platformEvidence`);
  const sourceUrl = officialNintendoUrl(evidence.sourceUrl, 'platformEvidence.sourceUrl').href;
  const observedAt = isoTimestamp(evidence.observedAt, 'platformEvidence.observedAt');
  nonEmptyString(evidence.sourceLocator, 'platformEvidence.sourceLocator');
  if (!titleMatches(evidence.matchedTitle, binding.title)) {
    fail('platform_evidence_title_mismatch', `Steam binding ${binding.steamAppId} platform evidence title mismatch`);
  }
  const platforms = normalizedSwitchPlatforms(evidence.platforms, 'platformEvidence.platforms');
  if (platforms[0] !== binding.platforms[0]) {
    fail('platform_evidence_generation_mismatch', `Steam binding ${binding.steamAppId} platform evidence generation mismatch`);
  }
  readBoundBytes(evidence, readSource);
  return {
    kind: 'nintendo_official_platform_binding',
    sourceUrl,
    observedAt,
    sourceDigest: evidence.sourceDigest,
    title: binding.title,
    platforms,
    sourceLocator: evidence.sourceLocator,
  };
}

function loadSteamSource(source, readSource) {
  nonEmptyString(source.file, 'Steam final source.file');
  const raw = readSource(source.file);
  let document;
  try {
    document = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch (error) {
    fail('steam_final_json_invalid', `Steam final source is not JSON: ${error.message}`);
  }
  validateSteamCandidateDocument(document);
  digest(source.documentDigest, 'Steam final source.documentDigest');
  if (document.documentDigest !== source.documentDigest) {
    fail('steam_final_digest_mismatch', 'Steam final candidate document digest does not match manifest');
  }
  if (document.mode !== 'final' || document.provisional !== false) {
    fail('steam_final_required', 'Steam popularity bindings require a non-provisional final candidate document');
  }
  if (!Array.isArray(source.bindings) || source.bindings.length === 0) {
    fail('steam_bindings_missing', 'Steam final source needs explicit Nintendo platform bindings');
  }
  const byAppId = new Map(document.candidates.map((candidate) => [candidate.steamAppId, candidate]));
  return source.bindings.map((binding, index) => {
    if (!plainObject(binding)) fail('steam_binding_invalid', `Steam binding ${index + 1} must be an object`);
    const steamAppId = positiveInteger(binding.steamAppId, `Steam binding ${index + 1}.steamAppId`);
    const steam = byAppId.get(steamAppId);
    if (!steam) fail('steam_binding_candidate_missing', `Steam final document does not contain ${steamAppId}`);
    const title = nonEmptyString(binding.title, `Steam binding ${index + 1}.title`);
    if (!titleMatches(title, steam.title)) fail('steam_binding_title_mismatch', `Steam binding ${steamAppId} title mismatch`);
    const slug = nonEmptyString(binding.slug, `Steam binding ${index + 1}.slug`);
    if (!SLUG_RE.test(slug)) fail('invalid_seed_slug', `Steam binding ${steamAppId} slug is invalid`);
    const platforms = normalizedSwitchPlatforms(binding.platforms, `Steam binding ${steamAppId}.platforms`);
    const platformEvidence = validatePlatformEvidence(binding.platformEvidence, {
      steamAppId,
      title,
      platforms,
    }, readSource);
    const score = Number(steam.popularityScore);
    if (!Number.isFinite(score) || score < 0) fail('steam_heat_invalid', `Steam final candidate ${steamAppId} has invalid heat`);
    return {
      sourceKey: `steam:${steamAppId}`,
      sourceType: 'steam_final_heat',
      priorityGroup: 1,
      priorityValue: -score,
      title,
      slug,
      platforms,
      steamAppId,
      publisher: binding.publisher ?? null,
      developer: binding.developer ?? null,
      seedEvidence: [platformEvidence],
      popularityEvidence: [{
        kind: 'steam_heat',
        sourceUrl: steam.sourceUrl,
        observedAt: document.generatedAt,
        sourceDigest: document.documentDigest,
        score,
        steamAppId,
        sourceCandidateDigest: steam.evidenceDigest,
        distinctUtcDates: [...document.distinctUtcDates],
      }],
      steamMatchEvidence: {
        kind: 'steam_final_candidate_exact_title',
        sourceUrl: steam.sourceUrl,
        observedAt: document.generatedAt,
        sourceDigest: document.documentDigest,
        status: 'exact_title',
        steamAppId,
        title: steam.title,
        sourceCandidateDigest: steam.evidenceDigest,
      },
    };
  });
}

function candidateFromRecord(record, identity) {
  const existing = identity.existing;
  const knownNsuids = existing?.nsuids
    ? {
      americas: existing.nsuids.americas ?? null,
      europe: existing.nsuids.europe ?? null,
      japan: existing.nsuids.japan ?? null,
    }
    : { americas: null, europe: null, japan: null };
  return {
    candidateId: null,
    catalogAction: identity.catalogAction,
    slug: identity.slug,
    title: existing?.title ?? record.title,
    platforms: [...record.platforms],
    publisher: record.publisher,
    developer: record.developer,
    knownNsuids,
    knownNintendoUsSlug: existing?.nintendoUsSlug ?? null,
    nintendoUsSlugHint: null,
    manualUsEvidence: null,
    seedEvidence: record.seedEvidence,
    exclusivityEvidence: null,
    steamMatchEvidence: record.steamMatchEvidence,
    popularityEvidence: record.popularityEvidence,
  };
}

function sortRecords(records) {
  return records.toSorted((left, right) => left.priorityGroup - right.priorityGroup
    || left.priorityValue - right.priorityValue
    || left.title.localeCompare(right.title, 'en')
    || left.sourceKey.localeCompare(right.sourceKey, 'en'));
}

function isNintendoSwitch2Edition(title) {
  return /(?:[-–—:]\s*)?nintendo\s+switch\s*2\s+edition\s*$/iu.test(String(title ?? ''));
}

function mergeRecords(records, rejected) {
  const grouped = new Map();
  for (const record of records) {
    const key = normTitle(record.title);
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }

  const merged = [];
  for (const group of grouped.values()) {
    const identities = new Set(group.map((record) => `${record.slug}\u0000${record.platforms[0]}`));
    const steamAppIds = new Set(group.map((record) => record.steamAppId).filter(Boolean));
    if (identities.size > 1 || steamAppIds.size > 1) {
      for (const record of group) {
        rejected.push({
          sourceKey: record.sourceKey,
          title: record.title,
          slug: record.slug,
          reason: 'source_identity_conflict',
        });
      }
      continue;
    }

    const [first, ...rest] = group;
    const combined = structuredClone(first);
    for (const record of rest) {
      combined.seedEvidence.push(...record.seedEvidence);
      combined.popularityEvidence.push(...record.popularityEvidence);
      combined.steamMatchEvidence ??= record.steamMatchEvidence;
      combined.steamAppId ??= record.steamAppId;
      if (record.priorityGroup < combined.priorityGroup) {
        combined.priorityGroup = record.priorityGroup;
        combined.priorityValue = record.priorityValue;
      } else if (record.priorityGroup === combined.priorityGroup) {
        combined.priorityValue = Math.min(combined.priorityValue, record.priorityValue);
      }
    }
    merged.push(combined);
  }
  return merged;
}

/**
 * Build one deterministic <=25 row Nintendo seed draft from retained evidence.
 * This pure entry point never performs network I/O and never mutates catalog.
 */
export function buildNintendoPopularitySeedBatch({
  manifest,
  catalog,
  readSource,
  batchSize = NINTENDO_POPULARITY_BATCH_SIZE,
  generatedAt = new Date(),
} = {}) {
  if (!plainObject(manifest)
    || manifest.schemaVersion !== NINTENDO_POPULARITY_MANIFEST_SCHEMA_VERSION
    || manifest.kind !== NINTENDO_POPULARITY_MANIFEST_KIND) {
    fail('manifest_schema_invalid', `manifest must be schemaVersion 1 ${NINTENDO_POPULARITY_MANIFEST_KIND}`);
  }
  if (typeof readSource !== 'function') fail('source_reader_missing', 'readSource is required');
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0 || batchSize > NINTENDO_POPULARITY_BATCH_SIZE) {
    fail('batch_size_invalid', `batchSize must be 1..${NINTENDO_POPULARITY_BATCH_SIZE}`);
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    fail('manifest_sources_missing', 'manifest needs at least one retained evidence source');
  }
  const generated = isoTimestamp(generatedAt, 'generatedAt');
  const excludedSlugs = new Set(manifest.excludedSlugs ?? []);
  if ([...excludedSlugs].some((slug) => !SLUG_RE.test(slug))) {
    fail('excluded_slug_invalid', 'manifest excludedSlugs contains an invalid slug');
  }

  const rawRecords = [];
  const rejected = [];
  const sources = [];
  for (const [index, source] of manifest.sources.entries()) {
    if (!plainObject(source) || !SOURCE_KINDS.has(source.kind)) {
      fail('source_kind_invalid', `manifest source ${index + 1} kind is unsupported`);
    }
    if (source.kind === 'steam_final_candidates') {
      const records = loadSteamSource(source, readSource);
      rawRecords.push(...records);
      sources.push({ kind: source.kind, digest: source.documentDigest, rows: records.length });
      continue;
    }
    const loaded = loadIrSource(source, readSource);
    let acceptedRows = 0;
    for (const row of loaded.rows) {
      if (row.combinedTitles) {
        rejected.push({
          sourceKey: `ir:${loaded.sourceDigest.slice(7, 19)}:${String(row.rank).padStart(4, '0')}`,
          title: row.title,
          reason: 'combined_title_row_requires_explicit_product_evidence',
        });
        continue;
      }
      rawRecords.push(irRecord(loaded, row));
      acceptedRows += 1;
    }
    sources.push({
      kind: source.kind,
      digest: loaded.sourceDigest,
      rows: loaded.rows.length,
      acceptedRows,
      extractionMode: loaded.extractionMode,
    });
  }

  const records = sortRecords(mergeRecords(rawRecords, rejected));
  const indexes = catalogIndexes(catalog);
  const eligible = [];
  for (const record of records) {
    if (excludedSlugs.has(record.slug)) {
      rejected.push({ sourceKey: record.sourceKey, title: record.title, slug: record.slug, reason: 'manifest_excluded' });
      continue;
    }
    // A Switch 2 Edition is not automatically a distinct logical game and is
    // not automatically equivalent to its Switch base game. The catalog's
    // one-row-per-logical-game rule requires separate equivalence evidence,
    // which this popularity-only entry point intentionally cannot manufacture.
    if (isNintendoSwitch2Edition(record.title)) {
      rejected.push({
        sourceKey: record.sourceKey,
        title: record.title,
        slug: record.slug,
        reason: 'edition_variant_requires_equivalence_evidence',
      });
      continue;
    }
    const identity = catalogCandidateIdentity(record, indexes);
    if (identity.rejected) {
      rejected.push({ sourceKey: record.sourceKey, title: record.title, slug: record.slug, reason: identity.rejected });
      continue;
    }
    eligible.push({ record, identity });
  }
  const selected = eligible.slice(0, batchSize);
  const candidates = selected.map(({ record, identity }) => candidateFromRecord(record, identity));
  const draft = {
    schemaVersion: 1,
    kind: NINTENDO_POPULARITY_DRAFT_KIND,
    generatedAt: generated,
    candidates,
  };
  const report = {
    schemaVersion: 1,
    kind: NINTENDO_POPULARITY_REPORT_KIND,
    generatedAt: generated,
    sourceCount: sources.length,
    sources,
    candidateEvidenceRows: records.length,
    eligible: eligible.length,
    selected: candidates.length,
    remaining: Math.max(0, eligible.length - candidates.length),
    batchSize,
    selectedCandidates: selected.map(({ record, identity }) => ({
      sourceKey: record.sourceKey,
      slug: identity.slug,
      title: identity.existing?.title ?? record.title,
      catalogAction: identity.catalogAction,
      popularityKind: record.popularityEvidence.map((entry) => entry.kind),
    })),
    rejected: rejected.toSorted((left, right) => (left.reason ?? '').localeCompare(right.reason ?? '', 'en')
      || (left.title ?? '').localeCompare(right.title ?? '', 'en')),
  };
  return { draft, report };
}
