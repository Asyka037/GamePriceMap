import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidateSourceDocument } from '../lib/candidate-source.mjs';
import {
  verifyApprovedCandidates,
  verifyPsnCandidate,
} from '../lib/candidate-verifier.mjs';
import { applyBatchToCatalog, expectedImportArtifacts } from '../lib/catalog.mjs';
import { buildFrozenBatchPlan } from '../lib/import-selection.mjs';
import {
  VERIFY_STATUS,
  createEmptyImportState,
  joinCandidatesWithState,
  transitionVerify,
} from '../lib/import-state.mjs';
import {
  buildPsnMappingCandidate,
  createPsnSuggestionDocument,
} from '../lib/psn-manual-mappings.mjs';
import { runImportCli } from '../import-library.mjs';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const PRODUCT_ID = 'UP0700-PPSA04610_00-ELDENRING0000000';
const PRODUCT_URL = `https://store.playstation.com/en-us/product/${PRODUCT_ID}`;
const BASE_COMMIT = 'a'.repeat(40);

function catalog(overrides = {}) {
  return {
    games: [{
      slug: 'elden-ring',
      title: 'Elden Ring',
      steamAppId: 1245620,
      nsuids: null,
      platforms: ['pc', 'ps5'],
      tier: 'core',
      addedAt: '2026-07-08',
      ...overrides,
    }],
  };
}

function mappingCandidate() {
  return buildPsnMappingCandidate({
    status: 'ready',
    slug: 'elden-ring',
    title: 'Elden Ring',
    productId: PRODUCT_ID,
    canonicalUrl: PRODUCT_URL,
  }, {
    productId: PRODUCT_ID,
    conceptId: '10000333',
    matchedTitle: 'ELDEN RING PS4 & PS5',
    edition: 'standard',
    platforms: ['ps4', 'ps5'],
    skuId: `${PRODUCT_ID}-U001`,
    row: {
      cc: 'US', currency: 'USD', amount: 59.99, list: null,
      discountPct: null, saleEndsAt: null,
    },
    annotations: { psPlus: null, excludedTrials: 0 },
  }, {
    observedAt: NOW,
    finalUrl: PRODUCT_URL,
  });
}

function suggestionDocument(candidate = mappingCandidate()) {
  return createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [candidate],
    pending: [],
    failures: [],
  });
}

function verifiedContext() {
  const source = { ...mappingCandidate(), humanDecision: '批准' };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, {
    at: '2026-07-18T13:00:00.000Z',
  });
  return { source, state, candidate: joinCandidatesWithState([source], state)[0] };
}

test('sealed PSN suggestions enter the generic source gate but tampering cannot', () => {
  const document = suggestionDocument();
  assert.equal(validateCandidateSourceDocument(document, { now: NOW.valueOf() }), document);
  const tampered = structuredClone(document);
  tampered.candidates[0].psnEdition = 'deluxe';
  assert.throws(() => validateCandidateSourceDocument(tampered, { now: NOW.valueOf() }), /documentDigest mismatch/u);
});

test('PSN verification is pure, TTL-bound, existing-slug-only, and never calls Steam', async () => {
  const candidate = mappingCandidate();
  const verified = verifyPsnCandidate(candidate, catalog(), {
    now: new Date('2026-07-18T13:00:00.000Z'),
  });
  assert.equal(verified.passed, true);
  assert.equal(verified.facts.psnProductId, PRODUCT_ID);
  assert.match(verifyPsnCandidate(candidate, catalog({
    psnProductId: PRODUCT_ID,
    psnConceptId: '10000333',
    psnEdition: 'standard',
  }), { now: NOW }).reason, /拒绝覆盖或重复/u);
  assert.match(verifyPsnCandidate(candidate, catalog(), {
    now: new Date('2026-07-26T00:00:00.000Z'),
  }).reason, /expired/u);

  const source = { ...candidate, humanDecision: '批准' };
  const [joined] = joinCandidatesWithState([source], createEmptyImportState());
  let steamCalls = 0;
  const result = await verifyApprovedCandidates([joined], createEmptyImportState(), {
    catalog: catalog(),
    fetchSteamAppDetails: async () => { steamCalls += 1; throw new Error('must remain offline'); },
    now: new Date('2026-07-18T13:00:00.000Z'),
  });
  assert.equal(result.results[0].passed, true);
  assert.equal(steamCalls, 0);
});

test('PSN projection and catalog merge preserve identity and reject duplicate/overwrite', () => {
  const verified = verifiedContext();
  const plan = buildFrozenBatchPlan([verified.candidate], {
    limit: 1,
    branch: 'main',
    baseCommit: BASE_COMMIT,
    addedAt: '2026-07-18',
    batchId: 'psn-poc-0001',
    now: new Date('2026-07-18T14:00:00.000Z'),
    approvalPolicy: 'v2-auto-approve',
  });
  assert.deepEqual(plan.items[0], {
    catalogAction: 'add_platform_mapping',
    evidenceDigest: verified.candidate.evidenceDigest,
    humanDecisionDigest: verified.candidate.humanDecisionDigest,
    key: `psn:${PRODUCT_ID}`,
    nsuids: null,
    platforms: ['ps4', 'ps5'],
    psnConceptId: '10000333',
    psnEdition: 'standard',
    psnProductId: PRODUCT_ID,
    slug: 'elden-ring',
    steamAppId: null,
    title: 'Elden Ring',
    verifiedAt: '2026-07-18T13:00:00.000Z',
  });
  const next = applyBatchToCatalog(catalog(), plan);
  assert.equal(next.games[0].psnProductId, PRODUCT_ID);
  assert.equal(next.games[0].psnConceptId, '10000333');
  assert.equal(next.games[0].psnEdition, 'standard');
  assert.deepEqual(next.games[0].platforms, ['pc', 'ps5', 'ps4']);
  assert.ok(expectedImportArtifacts(plan).includes('data/snapshots/psn/elden-ring.json'));
  assert.throws(() => applyBatchToCatalog(next, plan), /already belongs|replace or duplicate/u);
});

test('unauthorized PSN apply refuses before repository/state/network; authorized test staging binds the PSN plan', async () => {
  const verified = verifiedContext();
  const pending = { ...mappingCandidate(), humanDecision: '待定' };
  const [pendingJoined] = joinCandidatesWithState([pending], verified.state);
  let repositories = 0;
  let stateReads = 0;
  let writes = 0;
  let starts = 0;
  const common = {
    root: '/tmp/psn-import-offline-test',
    paths: {
      workbookPath: '/tmp/library.xlsx',
      statePath: '/tmp/state.json',
      outputDir: '/tmp/out',
      catalogPath: '/tmp/catalog.json',
      stateRoot: '/tmp/import-state',
    },
    clock: () => new Date('2026-07-18T14:00:00.000Z'),
    readCandidateSource: () => suggestionDocument(),
    loadContext: () => {
      stateReads += 1;
      return { source: suggestionDocument(), candidates: [pendingJoined], state: verified.state };
    },
    readCatalog: () => catalog(),
    repositoryIdentity: () => { repositories += 1; return { branch: 'main', baseCommit: BASE_COMMIT }; },
    writeState: () => { writes += 1; },
    startRun: () => { starts += 1; return { state: 'applied' }; },
    stdout: () => {},
  };
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'psn.json',
    '--policy=v2-auto-approve', '--batch-id', 'psn-poc-0001', '--run-id', 'psn-poc-0001-run',
  ], {
    ...common,
    psnAutomationAuthorized: false,
  }), (error) => error.code === 'PSN_AUTOMATION_DISABLED');
  assert.equal(repositories, 0);
  assert.equal(stateReads, 0);
  assert.equal(writes, 0);
  assert.equal(starts, 0);

  let receivedPlan;
  const result = await runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'psn.json',
    '--policy=v2-auto-approve', '--batch-id', 'psn-poc-0001', '--run-id', 'psn-poc-0001-run',
  ], {
    ...common,
    psnAutomationAuthorized: true,
    startRun: (_root, plan) => { receivedPlan = plan; return { state: 'applied' }; },
  });
  assert.equal(result.state, 'applied');
  assert.equal(stateReads, 1);
  assert.equal(receivedPlan.items[0].psnProductId, PRODUCT_ID);
  assert.equal(receivedPlan.approvalPolicy, 'v2-auto-approve');
});
