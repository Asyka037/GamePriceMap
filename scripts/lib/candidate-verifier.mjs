import { titleMatches } from './match.mjs';
import { gateSteamAppDetails } from './steam-candidates.mjs';
import {
  createNintendoSuggestionDocument,
  validateManualUsEvidence,
  validateNintendoSuggestionDocument,
} from './ns-candidates.mjs';
import {
  APPLY_STATUS,
  VERIFY_STATUS,
  transitionVerify,
} from './import-state.mjs';
import { freezeCandidateSlugs } from './import-selection.mjs';

export const DEFAULT_NINTENDO_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function catalogGames(catalog) {
  const games = Array.isArray(catalog) ? catalog : catalog?.games;
  if (!Array.isArray(games)) throw new Error('catalog must contain games');
  return games;
}

function appId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function catalogIdentityCheck(candidate, catalog) {
  const games = catalogGames(catalog);
  const action = candidate.catalogAction ?? 'new_game';
  const target = games.find((game) => game.slug === candidate.slug) ?? null;
  const numericAppId = appId(candidate.steamAppId);
  const appOwner = numericAppId === null
    ? null
    : games.find((game) => game.steamAppId === numericAppId) ?? null;
  const candidateNsuids = Object.values(candidate.nsuids ?? {}).filter(Boolean).map(String);
  const nsuidOwner = games.find((game) => Object.values(game.nsuids ?? {}).filter(Boolean).map(String)
    .some((id) => candidateNsuids.includes(id))) ?? null;

  if (action === 'new_game') {
    if (target) throw new Error(`slug 已存在于 catalog: ${candidate.slug}`);
    if (appOwner) throw new Error(`Steam AppID 已属于 ${appOwner.slug}`);
    if (nsuidOwner) throw new Error(`Nintendo NSUID 已属于 ${nsuidOwner.slug}`);
    return;
  }
  if (action !== 'add_platform_mapping' || !target) throw new Error('平台映射目标不存在');
  if (!titleMatches(candidate.title, target.title)) throw new Error(`标题与映射目标不一致: ${target.title}`);
  if (appOwner && appOwner.slug !== target.slug) throw new Error(`Steam AppID 已属于 ${appOwner.slug}`);
  if (nsuidOwner && nsuidOwner.slug !== target.slug) throw new Error(`Nintendo NSUID 已属于 ${nsuidOwner.slug}`);
}

const NINTENDO_SIGNED_FIELDS = Object.freeze([
  'schemaVersion',
  'candidateId',
  'sourceCandidateId',
  'catalogAction',
  'slug',
  'title',
  'platforms',
  'publisher',
  'developer',
  'nsuids',
  'nsuidAm',
  'nsuidEu',
  'nsuidJp',
  'nintendoUsSlug',
  'primaryRegionalChannel',
  'humanDecision',
  'sourceUrl',
  'generation',
  'manualUsEvidence',
  'regionalEvidence',
  'exclusivityEvidence',
  'steamMatchEvidence',
  'exclusivity',
  'popularity',
  'popularityUnverified',
  'verifyStatus',
  'exceptionReasons',
  'warnings',
]);

/**
 * S6 joins human and machine state onto a source candidate and intentionally
 * overwrites `humanDecision`/`verifyStatus`. Reconstruct only the A2-signed
 * suggestion fields so its original digest can still prove that discovery
 * passed, without trusting mutable workbook or state columns.
 */
function signedNintendoSuggestion(candidate) {
  const suggestion = Object.fromEntries(NINTENDO_SIGNED_FIELDS.map((field) => [field, candidate?.[field]]));
  suggestion.humanDecision = '待定';
  suggestion.verifyStatus = 'passed';
  suggestion.evidenceDigest = candidate?.evidenceDigest;
  return suggestion;
}

function assertNotFuture(value, nowMs, label) {
  const timestamp = Date.parse(value ?? '');
  if (!Number.isFinite(timestamp)) throw new Error(`${label} 时间无效`);
  if (timestamp > nowMs) throw new Error(`${label} 晚于当前核验时间`);
}

function assertCurrentEvidence(value, nowMs, ttlMs, label) {
  assertNotFuture(value, nowMs, label);
  const timestamp = Date.parse(value);
  if (nowMs - timestamp > ttlMs) throw new Error(`${label} 已超过 ${Math.floor(ttlMs / 86_400_000)} 天有效期`);
}

function nintendoCatalogIdentityCheck(candidate, catalog) {
  catalogIdentityCheck(candidate, catalog);
  if (candidate.catalogAction !== 'add_platform_mapping') return;
  const target = catalogGames(catalog).find((game) => game.slug === candidate.slug);
  for (const [group, nsuid] of Object.entries(candidate.nsuids ?? {})) {
    if (target?.nsuids?.[group] && String(target.nsuids[group]) !== String(nsuid)) {
      throw new Error(`${group} NSUID 会替换 catalog 现有身份`);
    }
  }
  if (target?.nintendoUsSlug
    && target.nintendoUsSlug !== candidate.nintendoUsSlug) {
    throw new Error('Nintendo US product slug 会替换 catalog 现有身份');
  }
}

/**
 * Verify one approved A2 Nintendo suggestion entirely from retained evidence.
 * This function is deliberately pure and never performs Nintendo US requests.
 */
export function verifyNintendoCandidate(candidate, catalog, {
  now = new Date(),
  evidenceTtlMs = DEFAULT_NINTENDO_EVIDENCE_TTL_MS,
} = {}) {
  try {
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(current.valueOf())) throw new Error('当前核验时间无效');
    if (!(Number.isFinite(evidenceTtlMs) && evidenceTtlMs >= 0)) throw new Error('Nintendo 证据有效期无效');
    if (!/^ns:7001\d{10}$/u.test(candidate?.candidateId ?? '')) {
      throw new Error('Nintendo candidateId 无效');
    }

    const suggestion = signedNintendoSuggestion(candidate);
    const document = createNintendoSuggestionDocument({
      generatedAt: current.toISOString(),
      inputDigest: suggestion.evidenceDigest,
      candidates: [suggestion],
    });
    validateNintendoSuggestionDocument(document);
    if (suggestion.verifyStatus !== 'passed' || suggestion.exceptionReasons.length > 0) {
      throw new Error('Nintendo suggestion 未通过 A2 发现核验');
    }

    const nsuids = Object.values(suggestion.nsuids ?? {}).filter(Boolean).map(String);
    if (!nsuids.includes(suggestion.candidateId.slice(3))) {
      throw new Error('Nintendo candidateId 与 retained NSUID 不一致');
    }

    const sourceEvidence = suggestion.manualUsEvidence?.sourceEvidence;
    const americas = validateManualUsEvidence(sourceEvidence, suggestion);
    if (suggestion.nsuids?.americas !== americas.nsuid) {
      throw new Error('Americas NSUID 与人工证据不一致');
    }
    if (suggestion.nintendoUsSlug !== sourceEvidence.productSlug) {
      throw new Error('nintendoUsSlug 不是人工证据中的产品 slug');
    }
    if (suggestion.primaryRegionalChannel !== 'eshop') {
      throw new Error('Nintendo 主区域渠道必须是 eshop');
    }
    assertCurrentEvidence(sourceEvidence.reviewedAt, current.valueOf(), evidenceTtlMs, 'Nintendo US 人工证据');
    for (const region of ['europe', 'japan']) {
      const evidence = suggestion.regionalEvidence?.[region];
      if (evidence) {
        assertCurrentEvidence(evidence.collectedAt, current.valueOf(), evidenceTtlMs, `${region} retained evidence`);
      }
    }
    for (const [index, evidence] of (suggestion.popularity?.evidence ?? []).entries()) {
      assertCurrentEvidence(evidence.observedAt, current.valueOf(), evidenceTtlMs, `popularity evidence ${index + 1}`);
    }
    for (const [label, evidence] of [
      ['exclusivity evidence', suggestion.exclusivityEvidence],
      ['Steam match evidence', suggestion.steamMatchEvidence],
    ]) {
      if (evidence) assertCurrentEvidence(evidence.observedAt, current.valueOf(), evidenceTtlMs, label);
    }

    nintendoCatalogIdentityCheck(suggestion, catalog);
    return {
      passed: true,
      reason: null,
      facts: {
        candidateId: suggestion.candidateId,
        nsuids: structuredClone(suggestion.nsuids),
        nintendoUsSlug: suggestion.nintendoUsSlug,
        generation: suggestion.generation,
        paid: americas.paid,
        primaryRegionalChannel: suggestion.primaryRegionalChannel,
      },
    };
  } catch (error) {
    return { passed: false, reason: `Nintendo 当前核验失败: ${error.message}` };
  }
}

/** Re-check the current official US appdetails response for one approved row. */
export function verifySteamCandidate(candidate, payload, catalog, { now = new Date() } = {}) {
  const numericAppId = appId(candidate?.steamAppId);
  if (numericAppId === null || candidate?.candidateId !== `steam:${numericAppId}`) {
    return { passed: false, reason: 'Steam candidateId/AppID 不一致' };
  }
  try {
    catalogIdentityCheck(candidate, catalog);
    const gate = gateSteamAppDetails(numericAppId, payload, {
      expectedTitles: [candidate.title],
      now,
    });
    if (!gate.accepted) return { passed: false, reason: `Steam 当前核验失败: ${gate.reason}`, gate };
    if (!titleMatches(gate.title, candidate.title)) {
      return { passed: false, reason: `Steam 当前标题不一致: ${gate.title}` };
    }
    return {
      passed: true,
      reason: null,
      facts: {
        title: gate.title,
        productType: gate.productType,
        isFree: gate.isFree,
        releaseDate: gate.releaseDate,
        usListPrice: gate.usListPrice,
        usCurrentPrice: gate.usCurrentPrice,
        currency: gate.currency,
      },
    };
  } catch (error) {
    return { passed: false, reason: error.message };
  }
}

function verifiedRecently(candidate, nowMs, ttlMs) {
  if (candidate.verifyStatus !== VERIFY_STATUS.PASSED || !candidate.machineStateValid) return false;
  const verifiedAt = Date.parse(candidate.verifiedAt ?? '');
  return Number.isFinite(verifiedAt) && nowMs - verifiedAt <= ttlMs;
}

/**
 * Verify approved candidates incrementally. `persist` is invoked after every
 * row so a killed 1,000-item run resumes without repeating finished checks.
 */
export async function verifyApprovedCandidates(candidates, state, {
  catalog,
  fetchSteamAppDetails,
  verifyNintendo = null,
  persist = () => {},
  now = new Date(),
  verificationTtlMs = 7 * 24 * 60 * 60 * 1000,
  limit = Number.MAX_SAFE_INTEGER,
  wait = async () => {},
} = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (typeof fetchSteamAppDetails !== 'function') throw new TypeError('fetchSteamAppDetails is required');
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.valueOf())) throw new Error('invalid verification time');
  if (!(Number.isFinite(verificationTtlMs) && verificationTtlMs >= 0)) throw new Error('bad verification TTL');
  if (!(Number.isSafeInteger(limit) && limit >= 1)) throw new Error('verification limit must be positive');
  if (verifyNintendo !== null && verifyNintendo !== undefined && typeof verifyNintendo !== 'function') {
    throw new TypeError('verifyNintendo must be a function');
  }
  const nintendoVerifier = verifyNintendo ?? verifyNintendoCandidate;

  const frozen = freezeCandidateSlugs(candidates, catalog);
  let nextState = state;
  const results = [];
  let processed = 0;
  for (const candidate of frozen) {
    if (candidate.humanDecision !== '批准' || candidate.approvalStale || candidate.workbookEvidenceStale) continue;
    if ([APPLY_STATUS.STAGED, APPLY_STATUS.APPLIED].includes(candidate.applyStatus)) continue;
    if (verifiedRecently(candidate, current.valueOf(), verificationTtlMs)) continue;
    if (processed >= limit) break;
    processed += 1;

    let result;
    try {
      if (candidate.candidateId?.startsWith('steam:')) {
        const numericAppId = appId(candidate.steamAppId);
        if (numericAppId === null) result = { passed: false, reason: 'Steam AppID 无效' };
        else {
          const payload = await fetchSteamAppDetails(numericAppId, candidate);
          result = verifySteamCandidate(candidate, payload, catalog, { now: current });
        }
      } else if (candidate.candidateId?.startsWith('ns:')) {
        result = await nintendoVerifier(candidate, catalog, { now: current });
      } else {
        result = { passed: false, reason: '候选 candidateId 平台前缀无效' };
      }
    } catch (error) {
      result = { passed: false, reason: `核验请求失败: ${error.message}` };
    }
    nextState = transitionVerify(
      nextState,
      candidate,
      result.passed ? VERIFY_STATUS.PASSED : VERIFY_STATUS.EXCEPTION,
      { reason: result.reason, at: current.toISOString() },
    );
    persist(nextState, { candidate, result });
    results.push({ candidateId: candidate.candidateId, slug: candidate.slug, ...result });
    if (processed < limit) await wait();
  }
  return { state: nextState, results, processed };
}
