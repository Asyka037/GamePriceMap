import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_STATUS,
  VERIFY_STATUS,
  createEmptyImportState,
  joinCandidatesWithState,
  transitionVerify,
} from '../lib/import-state.mjs';
import {
  buildFrozenBatchPlan,
  freezeCandidateSlug,
  slugBase,
  transitionBatchApplyState,
} from '../lib/import-selection.mjs';

const BASE_COMMIT = 'a'.repeat(40);

function verifiedCandidate(appId, title, slug = null) {
  const source = {
    candidateId: `steam:${appId}`,
    catalogAction: 'new_game',
    steamAppId: String(appId),
    title,
    slug: slug ?? slugBase(title, appId),
    platforms: ['pc'],
    evidence: { paid: true, appId },
    humanDecision: '批准',
  };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
    at: '2026-07-17T00:00:00.000Z',
  });
  return { candidate: joinCandidatesWithState([source], state)[0], state };
}

test('slug 冻结处理重音、年份冲突与稳定商品 ID 回退', () => {
  assert.equal(slugBase('Pokémon: Let’s Go, Eevee!'), 'pokemon-lets-go-eevee');
  const catalog = { games: [{ slug: 'doom', title: 'DOOM' }, { slug: 'doom-2016', title: 'Other' }] };
  assert.equal(freezeCandidateSlug({
    candidateId: 'steam:379720', title: 'DOOM', paidGate: { releaseDate: 'May 12, 2016' }, catalogAction: 'new_game',
  }, catalog), 'doom-379720');
});

test('平台映射要求现有 slug 与精确标题一致', () => {
  const catalog = { games: [{ slug: 'example', title: 'Example Game' }] };
  assert.equal(freezeCandidateSlug({
    candidateId: 'ns:70010000000001', title: 'Example Game', slug: 'example', catalogAction: 'add_platform_mapping',
  }, catalog), 'example');
  assert.throws(() => freezeCandidateSlug({
    candidateId: 'ns:70010000000001', title: 'Different Game', slug: 'example', catalogAction: 'add_platform_mapping',
  }, catalog), /title does not match/u);
});

test('当前批准/核验生成确定性 plan，并同步 staged → applied', () => {
  const { candidate, state } = verifiedCandidate(42, 'Example Game');
  const input = {
    limit: 25,
    branch: 'main',
    baseCommit: BASE_COMMIT,
    addedAt: '2026-07-17',
    now: new Date('2026-07-18T00:00:00.000Z'),
  };
  const first = buildFrozenBatchPlan([candidate], input);
  const second = buildFrozenBatchPlan([candidate], input);
  assert.equal(first.batchDigest, second.batchDigest);
  assert.equal(first.items[0].key, 'steam:42');

  const staged = transitionBatchApplyState(state, first, APPLY_STATUS.STAGED, { at: '2026-07-18T00:01:00Z' });
  const applied = transitionBatchApplyState(staged, first, APPLY_STATUS.APPLIED, { at: '2026-07-18T00:02:00Z' });
  assert.equal(applied.candidates['steam:42'].applyStatus, APPLY_STATUS.APPLIED);
});

test('过期核验和空批次不会生成 plan', () => {
  const { candidate } = verifiedCandidate(42, 'Example Game');
  assert.throws(() => buildFrozenBatchPlan([candidate], {
    limit: 25,
    branch: 'main',
    baseCommit: BASE_COMMIT,
    addedAt: '2026-07-30',
    now: new Date('2026-07-30T00:00:00Z'),
  }), /没有当前批准/u);
});
