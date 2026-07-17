import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sha256Digest } from '../lib/candidate-evidence.mjs';
import {
  createEmptyImportState,
  joinCandidatesWithState,
} from '../lib/import-state.mjs';
import {
  buildNintendoSuggestion,
  sealDatedEvidence,
  sealManualUsEvidence,
  sealRegionalDiscoveryEvidence,
} from '../lib/ns-candidates.mjs';
import {
  verifyApprovedCandidates,
  verifyNintendoCandidate,
  verifySteamCandidate,
} from '../lib/candidate-verifier.mjs';

const rawNintendoSeed = JSON.parse(readFileSync(
  new URL('./fixtures/ns-candidate-seed.json', import.meta.url),
  'utf8',
));

function payload(appId, overrides = {}) {
  return {
    [appId]: {
      success: true,
      data: {
        steam_appid: appId,
        name: 'Example Game',
        type: 'game',
        is_free: false,
        release_date: { coming_soon: false, date: 'Jan 2, 2020' },
        price_overview: { currency: 'USD', initial: 1999, final: 0, discount_percent: 100 },
        ...overrides,
      },
    },
  };
}

function approved(appId = 42) {
  return {
    candidateId: `steam:${appId}`,
    catalogAction: 'new_game',
    steamAppId: appId,
    title: 'Example Game',
    platforms: ['pc'],
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    humanDecision: '批准',
  };
}

function nintendoRegional(region, nsuid) {
  return sealRegionalDiscoveryEvidence({
    status: 'matched',
    region,
    nsuid,
    matchedTitle: rawNintendoSeed.title,
    generation: 'HAC',
    paid: true,
    released: true,
    sourceUrl: region === 'europe'
      ? 'https://searching.nintendo-europe.com/en/select'
      : 'https://search.nintendo.jp/nintendo_soft/search.json',
    collectedAt: '2026-07-17T00:00:00.000Z',
    sourceDigest: sha256Digest({ region, nsuid }),
  });
}

function nintendoSuggestion(overrides = {}) {
  const seed = structuredClone(rawNintendoSeed);
  seed.manualUsEvidence = sealManualUsEvidence(seed.manualUsEvidence);
  Object.assign(seed, overrides);
  return buildNintendoSuggestion(seed, {
    europe: nintendoRegional('europe', '70010000000012'),
    japan: nintendoRegional('japan', '70010000000013'),
  });
}

function resealSuggestion(candidate, overrides) {
  const { evidenceDigest: _digest, ...payload } = { ...candidate, ...overrides };
  return { ...payload, evidenceDigest: sha256Digest(payload) };
}

test('Steam 当前核验允许临时 100% 折扣，但拒绝类型/ID/catalog 冲突', () => {
  const candidate = { ...approved(), slug: 'example-game' };
  assert.equal(verifySteamCandidate(candidate, payload(42), { games: [] }).passed, true);
  assert.match(verifySteamCandidate(candidate, payload(42, { type: 'dlc' }), { games: [] }).reason, /not_base_game/u);
  assert.match(verifySteamCandidate(candidate, payload(42), {
    games: [{ slug: 'other', title: 'Other', steamAppId: 42, nsuids: null }],
  }).reason, /已属于 other/u);
});

test('批准行逐项持久化，网络异常记 exception 且可在下轮重试', async () => {
  const source = approved();
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  const writes = [];
  const first = await verifyApprovedCandidates([joined], createEmptyImportState(), {
    catalog: { games: [] },
    fetchSteamAppDetails: async () => { throw new Error('offline'); },
    persist: (state) => writes.push(structuredClone(state)),
    now: new Date('2026-07-17T00:00:00Z'),
  });
  assert.equal(first.state.candidates['steam:42'].verifyStatus, 'exception');
  assert.equal(writes.length, 1);

  const [retry] = joinCandidatesWithState([source], first.state);
  const second = await verifyApprovedCandidates([retry], first.state, {
    catalog: { games: [] },
    fetchSteamAppDetails: async () => payload(42),
    now: new Date('2026-07-17T01:00:00Z'),
  });
  assert.equal(second.state.candidates['steam:42'].verifyStatus, 'passed');
  assert.equal(second.state.candidates['steam:42'].slug, 'example-game');
});

test('尚未批准、已应用与 TTL 内已核验行不重复外呼', async () => {
  let calls = 0;
  const pendingSource = { ...approved(), humanDecision: '待定' };
  const [pending] = joinCandidatesWithState([pendingSource], createEmptyImportState());
  const result = await verifyApprovedCandidates([pending], createEmptyImportState(), {
    catalog: { games: [] },
    fetchSteamAppDetails: async () => { calls += 1; return payload(42); },
  });
  assert.equal(result.processed, 0);
  assert.equal(calls, 0);
});

test('Nintendo retained suggestion evidence passes without any US request', () => {
  const candidate = nintendoSuggestion();
  const result = verifyNintendoCandidate(candidate, { games: [] }, {
    now: new Date('2026-07-17T01:00:00.000Z'),
  });
  assert.equal(result.passed, true);
  assert.equal(result.facts.candidateId, 'ns:70010000000011');
  assert.equal(result.facts.nintendoUsSlug, 'example-game-switch');
  assert.equal(result.facts.paid, true);
});

test('Nintendo verifier rejects digest/status, identity, retained evidence and catalog conflicts', () => {
  const candidate = nintendoSuggestion();
  assert.match(
    verifyNintendoCandidate({ ...candidate, title: 'Tampered' }, { games: [] }).reason,
    /evidenceDigest mismatch/u,
  );

  const wrongId = resealSuggestion(candidate, { candidateId: 'ns:70010000000999' });
  assert.match(
    verifyNintendoCandidate(wrongId, { games: [] }).reason,
    /candidateId 与 retained NSUID/u,
  );

  const changedEurope = structuredClone(candidate);
  changedEurope.regionalEvidence.europe.nsuid = '70010000000444';
  const retainedTamper = resealSuggestion(changedEurope, {});
  assert.match(
    verifyNintendoCandidate(retainedTamper, { games: [] }).reason,
    /evidence_digest_mismatch|evidenceDigest mismatch/u,
  );

  assert.match(verifyNintendoCandidate(candidate, {
    games: [{
      slug: 'other-game',
      title: 'Other Game',
      steamAppId: null,
      nsuids: { americas: '70010000000011' },
    }],
  }).reason, /Nintendo NSUID 已属于 other-game/u);

  const exception = resealSuggestion(candidate, {
    verifyStatus: 'exception',
    exceptionReasons: ['manual_review_required'],
  });
  assert.match(
    verifyNintendoCandidate(exception, { games: [] }).reason,
    /evidenceDigest mismatch|未通过 A2/u,
  );

  assert.match(
    verifyNintendoCandidate(candidate, { games: [] }, {
      now: new Date('2026-08-17T00:00:00.000Z'),
    }).reason,
    /超过 30 天有效期/u,
  );
});

test('verifyApprovedCandidates defaults to Nintendo verifier and never follows nested Steam evidence', async () => {
  const steamMatchEvidence = sealDatedEvidence({
    kind: 'steam_match',
    status: 'exact_title',
    steamAppId: 42,
    title: 'Example Game',
    publisher: 'Example Studio',
    sourceUrl: 'https://store.steampowered.com/app/42/',
    observedAt: '2026-07-17T00:00:00.000Z',
  });
  const source = {
    ...nintendoSuggestion({ steamMatchEvidence }),
    humanDecision: '批准',
  };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  let steamCalls = 0;
  const result = await verifyApprovedCandidates([joined], createEmptyImportState(), {
    catalog: { games: [] },
    fetchSteamAppDetails: async () => {
      steamCalls += 1;
      return payload(42);
    },
    now: new Date('2026-07-17T01:00:00.000Z'),
  });
  assert.equal(result.results[0].passed, true);
  assert.equal(result.state.candidates['ns:70010000000011'].verifyStatus, 'passed');
  assert.equal(steamCalls, 0);
});

test('verifyApprovedCandidates still accepts an injected Nintendo verifier override', async () => {
  const source = { ...nintendoSuggestion(), humanDecision: '批准' };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  let calls = 0;
  const result = await verifyApprovedCandidates([joined], createEmptyImportState(), {
    catalog: { games: [] },
    fetchSteamAppDetails: async () => { throw new Error('must not call Steam'); },
    verifyNintendo: async () => {
      calls += 1;
      return { passed: false, reason: 'injected rejection' };
    },
    now: new Date('2026-07-17T01:00:00.000Z'),
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.results[0].reason, 'injected rejection');
});

test('Nintendo verifier has no HTTP or Nintendo US page dependency', () => {
  const source = readFileSync(new URL('../lib/candidate-verifier.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|fetchJson|fetchText/u);
  assert.doesNotMatch(source, /nintendo\.com\/us\/store|extractUsProductNsuid/u);
});
