import { titleMatches } from './match.mjs';
import {
  APPLY_STATUS,
  joinCandidatesWithState,
  projectEligibleBatch,
  transitionApply,
} from './import-state.mjs';
import { canonicalJson, createBatchPlan, sha256 } from './import-run.mjs';

export const DEFAULT_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function validSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

function candidateSuffix(candidate) {
  const candidateId = String(candidate?.candidateId ?? '');
  const suffix = candidateId.split(':').at(-1);
  return /^\d+$/u.test(suffix ?? '') ? suffix : 'candidate';
}

export function slugBase(title, fallback = 'game') {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/&/gu, ' and ')
    .replace(/['’]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 72)
    .replace(/-+$/gu, '');
  return slug || `game-${String(fallback).replace(/[^a-z0-9]+/giu, '').toLowerCase() || 'candidate'}`;
}

function releaseYear(candidate) {
  const text = String(candidate?.paidGate?.releaseDate ?? candidate?.releaseDate ?? '');
  const match = text.match(/\b(?:19|20)\d{2}\b/u);
  return match?.[0] ?? null;
}

/**
 * Freeze the catalog slug before verification. Existing state-provided slugs
 * are retained by joinCandidatesWithState; new collisions prefer release year
 * and finally the immutable store ID.
 */
export function freezeCandidateSlug(candidate, catalog, reserved = new Set()) {
  const games = Array.isArray(catalog) ? catalog : catalog?.games;
  if (!Array.isArray(games)) throw new Error('catalog must contain games');
  const bySlug = new Map(games.map((game) => [game.slug, game]));
  const action = candidate?.catalogAction ?? 'new_game';

  if (action === 'add_platform_mapping') {
    if (!validSlug(candidate?.slug)) throw new Error(`${candidate?.candidateId}: platform mapping requires an existing slug`);
    const target = bySlug.get(candidate.slug);
    if (!target) throw new Error(`${candidate.candidateId}: mapping target ${candidate.slug} is absent`);
    if (!titleMatches(candidate.title, target.title)) throw new Error(`${candidate.candidateId}: mapping title does not match ${target.title}`);
    reserved.add(candidate.slug);
    return candidate.slug;
  }
  if (action !== 'new_game') throw new Error(`${candidate?.candidateId}: unsupported catalogAction ${action}`);

  const base = validSlug(candidate?.slug)
    ? candidate.slug
    : slugBase(candidate?.title, candidateSuffix(candidate));
  const unavailable = (slug) => bySlug.has(slug) || reserved.has(slug);
  let slug = base;
  if (unavailable(slug)) {
    const year = releaseYear(candidate);
    if (year && !unavailable(`${base}-${year}`)) slug = `${base}-${year}`;
    else slug = `${base}-${candidateSuffix(candidate)}`;
  }
  let counter = 2;
  const stable = slug;
  while (unavailable(slug)) slug = `${stable}-${counter++}`;
  reserved.add(slug);
  return slug;
}

export function freezeCandidateSlugs(candidates, catalog) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const reserved = new Set();
  return candidates.map((candidate) => ({
    ...candidate,
    slug: freezeCandidateSlug(candidate, catalog, reserved),
  }));
}

export function buildFrozenBatchPlan(candidates, {
  limit = 25,
  branch,
  baseCommit,
  addedAt,
  batchId = null,
  now = Date.now(),
  maxVerifiedAgeMs = DEFAULT_VERIFICATION_TTL_MS,
} = {}) {
  const items = projectEligibleBatch(candidates, { limit, now, maxVerifiedAgeMs });
  if (items.length === 0) throw new Error('没有当前批准且核验有效的待导入候选');
  const families = new Set(items.map((item) => item.key.split(':', 1)[0]));
  const prefix = families.size === 1 ? [...families][0] : 'mixed';
  const digestSuffix = sha256(canonicalJson({ baseCommit, items })).slice('sha256:'.length, 'sha256:'.length + 12);
  const frozenBatchId = batchId ?? `${prefix}-${String(addedAt).replaceAll('-', '')}-${digestSuffix}`;
  return createBatchPlan({
    batchId: frozenBatchId,
    baseCommit,
    branch,
    addedAt,
    items,
  });
}

export function candidateFromBatchItem(item) {
  return {
    candidateId: item.key,
    catalogAction: item.catalogAction,
    slug: item.slug,
    title: item.title,
    platforms: item.platforms,
    steamAppId: item.steamAppId,
    nsuids: item.nsuids,
    nintendoUsSlug: item.nintendoUsSlug,
    primaryRegionalChannel: item.primaryRegionalChannel,
    evidenceDigest: item.evidenceDigest,
    humanDecision: '批准',
    humanDecisionDigest: item.humanDecisionDigest,
    verifiedAt: item.verifiedAt,
  };
}

/** Keep private machine state synchronized with an immutable S5 plan. */
export function transitionBatchApplyState(state, plan, applyStatus, options = {}) {
  if (![APPLY_STATUS.STAGED, APPLY_STATUS.APPLIED, APPLY_STATUS.FAILED].includes(applyStatus)) {
    throw new Error(`unsupported batch apply status: ${applyStatus}`);
  }
  let next = state;
  for (const item of plan.items) {
    const source = candidateFromBatchItem(item);
    const [joined] = joinCandidatesWithState([source], next);
    next = transitionApply(next, joined, applyStatus, options);
  }
  return next;
}
