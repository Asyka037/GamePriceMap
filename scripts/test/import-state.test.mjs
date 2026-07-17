import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLY_STATUS,
  VERIFY_STATUS,
  createEmptyImportState,
  eligibleForBatch,
  joinCandidatesWithState,
  projectBatchItem,
  projectEligibleBatch,
  transitionApply,
  transitionVerify,
  validateImportState,
} from '../lib/import-state.mjs';

const APPROVED = {
  candidateId: 'steam:42',
  steamAppId: '42',
  title: 'Example',
  evidence: { type: 'game', paid: true },
  humanDecision: '批准',
};

test('join 将人工决定与机器状态分离，并为 S5 输出 digest/verifiedAt', () => {
  const [joined] = joinCandidatesWithState([APPROVED], createEmptyImportState());
  assert.equal(joined.humanDecision, '批准');
  assert.match(joined.evidenceDigest, /^sha256:/u);
  assert.match(joined.humanDecisionDigest, /^sha256:/u);
  assert.equal(joined.verifyStatus, VERIFY_STATUS.PENDING);
  assert.equal(joined.applyStatus, APPLY_STATUS.NOT_APPLIED);
  assert.equal(joined.verifiedAt, null);
});

test('核验与应用状态只允许安全转移', () => {
  const at = '2026-07-17T00:00:00.000Z';
  const [joined] = joinCandidatesWithState([APPROVED], createEmptyImportState());
  const verified = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, { at });
  const [afterVerify] = joinCandidatesWithState([APPROVED], verified);
  assert.equal(afterVerify.verifyStatus, VERIFY_STATUS.PASSED);
  assert.equal(afterVerify.verifiedAt, at);

  const staged = transitionApply(verified, afterVerify, APPLY_STATUS.STAGED, { at });
  const applied = transitionApply(staged, afterVerify, APPLY_STATUS.APPLIED, { at });
  const [afterApply] = joinCandidatesWithState([APPROVED], applied);
  assert.equal(afterApply.applyStatus, APPLY_STATUS.APPLIED);
  assert.equal(afterApply.appliedAt, at);
  assert.equal(transitionApply(applied, afterApply, APPLY_STATUS.APPLIED, { at: '2026-07-18T00:00:00.000Z' }), applied);
  assert.throws(() => transitionApply(verified, afterVerify, APPLY_STATUS.APPLIED, { at }), /非法 apply 状态转移/u);
});

test('核验后 state 中冻结的 slug 优先于后续候选源改名', () => {
  const source = { ...APPROVED, slug: 'stable-example' };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  const verified = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
    at: '2026-07-17T00:00:00.000Z',
  });
  const [regenerated] = joinCandidatesWithState([{ ...source, slug: 'renamed-source-value' }], verified);
  assert.equal(regenerated.slug, 'stable-example');
});

test('未批准候选不得核验或应用', () => {
  const [pending] = joinCandidatesWithState([{ ...APPROVED, humanDecision: '待定' }], createEmptyImportState());
  assert.throws(() => transitionVerify(createEmptyImportState(), pending, VERIFY_STATUS.PASSED), /未经人工批准/u);
});

test('evidenceDigest 变化会让旧批准与旧核验同时失效', () => {
  const [joined] = joinCandidatesWithState([APPROVED], createEmptyImportState());
  const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
    at: '2026-07-17T00:00:00.000Z',
  });
  const changed = { ...APPROVED, evidence: { type: 'dlc', paid: true } };
  const [stale] = joinCandidatesWithState([changed], state);
  assert.equal(stale.sourceHumanDecision, '批准');
  assert.equal(stale.humanDecision, '待定');
  assert.equal(stale.approvalStale, true);
  assert.equal(stale.verifyStatus, VERIFY_STATUS.PENDING);
  assert.equal(stale.verifiedAt, null);
});

test('证据变化不会抹掉已发生的 applied 事实，但旧核验仍失效', () => {
  const at = '2026-07-17T00:00:00.000Z';
  const [joined] = joinCandidatesWithState([APPROVED], createEmptyImportState());
  const verified = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, { at });
  const [verifiedCandidate] = joinCandidatesWithState([APPROVED], verified);
  const staged = transitionApply(verified, verifiedCandidate, APPLY_STATUS.STAGED, { at });
  const applied = transitionApply(staged, verifiedCandidate, APPLY_STATUS.APPLIED, { at });
  const [stale] = joinCandidatesWithState([{ ...APPROVED, evidence: { type: 'dlc' } }], applied);
  assert.equal(stale.humanDecision, '待定');
  assert.equal(stale.verifyStatus, VERIFY_STATUS.PENDING);
  assert.equal(stale.applyStatus, APPLY_STATUS.APPLIED);
  assert.equal(stale.appliedAt, at);
  assert.equal(stale.machineStateValid, false);
});

test('机器 state schema 拒绝持久化 humanDecision', () => {
  const state = createEmptyImportState();
  state.candidates['steam:42'] = {
    candidateId: 'steam:42',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    humanDecisionDigest: `sha256:${'b'.repeat(64)}`,
    humanDecision: '批准',
    verifyStatus: VERIFY_STATUS.PENDING,
    applyStatus: APPLY_STATUS.NOT_APPLIED,
  };
  assert.throws(() => validateImportState(state), /禁止存储 humanDecision/u);
});

test('eligibleForBatch 只放行当前证据下已批准、已核验、未应用候选', () => {
  const source = {
    ...APPROVED,
    slug: 'example',
    platforms: ['pc'],
    catalogAction: 'new_game',
  };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
    at: '2026-07-17T00:00:00.000Z',
  });
  const [eligible] = joinCandidatesWithState([source], state);
  assert.equal(eligibleForBatch(eligible), true);
  assert.equal(eligibleForBatch({ ...eligible, approvalStale: true }), false);
  assert.equal(eligibleForBatch({ ...eligible, applyStatus: APPLY_STATUS.STAGED }), false);
  assert.equal(eligibleForBatch({ ...eligible, applyStatus: APPLY_STATUS.FAILED }), true);
  assert.equal(eligibleForBatch({ ...eligible, applyStatus: APPLY_STATUS.APPLIED }), false);
  assert.equal(eligibleForBatch(eligible, {
    now: new Date('2026-07-20T00:00:00.000Z'),
    maxVerifiedAgeMs: 24 * 60 * 60 * 1000,
  }), false);
});

test('plan projection 生成 S5 的冻结项并按输入顺序/限额筛选', () => {
  function verifiedCandidate(appId, slug) {
    const source = {
      ...APPROVED,
      candidateId: `steam:${appId}`,
      steamAppId: String(appId),
      slug,
      title: `Game ${appId}`,
      platforms: ['pc'],
      catalogAction: 'new_game',
    };
    const [joined] = joinCandidatesWithState([source], createEmptyImportState());
    const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
      at: '2026-07-17T00:00:00.000Z',
    });
    return joinCandidatesWithState([source], state)[0];
  }
  const first = verifiedCandidate(42, 'game-42');
  const second = verifiedCandidate(43, 'game-43');
  assert.deepEqual(projectBatchItem(first), {
    key: 'steam:42',
    catalogAction: 'new_game',
    slug: 'game-42',
    title: 'Game 42',
    platforms: ['pc'],
    steamAppId: 42,
    nsuids: null,
    evidenceDigest: first.evidenceDigest,
    humanDecisionDigest: first.humanDecisionDigest,
    verifiedAt: '2026-07-17T00:00:00.000Z',
  });
  assert.deepEqual(projectEligibleBatch([first, second], { limit: 1 }).map((item) => item.key), ['steam:42']);
});
