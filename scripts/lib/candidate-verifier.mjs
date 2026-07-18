import { normTitle, titleMatches } from './match.mjs';
import { gateSteamAppDetails } from './steam-candidates.mjs';
import {
  createNintendoSuggestionDocument,
  validateManualUsEvidence,
  validateNintendoAmericasEvidence,
  validateNintendoSuggestionDocument,
} from './ns-candidates.mjs';
import { validatePsnMappingCandidate } from './psn-manual-mappings.mjs';
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

    const automaticAmericas = suggestion.regionalEvidence?.americas
      ? validateNintendoAmericasEvidence(suggestion.regionalEvidence.americas, suggestion)
      : null;
    const manualSourceEvidence = suggestion.manualUsEvidence?.sourceEvidence ?? null;
    const manualAmericas = manualSourceEvidence
      ? validateManualUsEvidence(manualSourceEvidence, suggestion)
      : null;
    const americas = automaticAmericas ?? manualAmericas;
    if (suggestion.nsuids?.americas) {
      if (!americas || suggestion.nsuids.americas !== americas.nsuid) {
        throw new Error('Americas NSUID 与 retained 证据不一致');
      }
      const productSlug = automaticAmericas?.productSlug ?? manualSourceEvidence?.productSlug;
      if (suggestion.nintendoUsSlug !== productSlug) {
        throw new Error('nintendoUsSlug 不是 retained Americas 证据中的产品 slug');
      }
    } else if (suggestion.nintendoUsSlug || americas) {
      throw new Error('缺失 Americas NSUID 时不得保留 US 产品身份');
    }
    const expectedPrimaryRegionalChannel = suggestion.catalogAction === 'new_game' ? 'eshop' : null;
    if (suggestion.primaryRegionalChannel !== expectedPrimaryRegionalChannel) {
      throw new Error(
        `Nintendo 主区域渠道必须是 ${expectedPrimaryRegionalChannel ?? 'null'}（${suggestion.catalogAction}）`,
      );
    }
    if (automaticAmericas) {
      assertCurrentEvidence(automaticAmericas.collectedAt, current.valueOf(), evidenceTtlMs, 'Nintendo US 自动证据');
    }
    if (manualSourceEvidence) {
      assertCurrentEvidence(manualSourceEvidence.reviewedAt, current.valueOf(), evidenceTtlMs, 'Nintendo US 人工证据');
    }
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
        paid: americas?.paid ?? Object.values(suggestion.regionalEvidence ?? {}).some((evidence) => evidence?.paid === true),
        primaryRegionalChannel: suggestion.primaryRegionalChannel,
      },
    };
  } catch (error) {
    return { passed: false, reason: `Nintendo 当前核验失败: ${error.message}` };
  }
}

/**
 * Re-check one sealed PSN mapping suggestion without fetching PlayStation.
 * Page collection and the later snapshot scrape remain separately gated; this
 * verifier trusts only an unexpired, digest-bound official-product evidence
 * record and an unchanged catalog target.
 */
export function verifyPsnCandidate(candidate, catalog, { now = new Date() } = {}) {
  try {
    const current = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(current.valueOf())) throw new Error('当前核验时间无效');
    validatePsnMappingCandidate(candidate, { now: current.valueOf() });
    if (candidate.catalogAction !== 'add_platform_mapping') {
      throw new Error('PSN POC 仅允许 add_platform_mapping');
    }
    catalogIdentityCheck(candidate, catalog);
    const games = catalogGames(catalog);
    const target = games.find((game) => game.slug === candidate.slug);
    if (!target || normTitle(candidate.title) !== normTitle(target.title)) {
      throw new Error('PSN 标题与 catalog 映射目标不精确一致');
    }
    if (target.psnProductId != null || target.psnConceptId != null || target.psnEdition != null) {
      throw new Error('catalog 映射目标已存在 PSN 身份，拒绝覆盖或重复');
    }
    const productOwner = games.find((game) => game.psnProductId === candidate.psnProductId);
    if (productOwner) throw new Error(`PSN Product ID 已属于 ${productOwner.slug}`);
    const conceptOwner = candidate.psnConceptId == null
      ? null
      : games.find((game) => game.psnConceptId === candidate.psnConceptId);
    if (conceptOwner) throw new Error(`PSN Concept ID 已属于 ${conceptOwner.slug}`);
    return {
      passed: true,
      reason: null,
      facts: {
        candidateId: candidate.candidateId,
        psnProductId: candidate.psnProductId,
        psnConceptId: candidate.psnConceptId ?? null,
        psnEdition: candidate.psnEdition,
        platforms: [...candidate.platforms],
        publicUsOffer: structuredClone(candidate.evidence.publicUsOffer),
      },
    };
  } catch (error) {
    return { passed: false, reason: `PSN retained evidence verification failed: ${error.message}` };
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
      } else if (candidate.candidateId?.startsWith('psn:')) {
        result = verifyPsnCandidate(candidate, catalog, { now: current });
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
