import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  executeImportCommand,
  parseImportArgs,
  runImportCli,
  validateCandidateSourceDocument,
} from '../import-library.mjs';
import { sealEvidenceDocument } from '../lib/candidate-evidence.mjs';
import {
  APPLY_STATUS,
  VERIFY_STATUS,
  createEmptyImportState,
  joinCandidatesWithState,
  transitionVerify,
} from '../lib/import-state.mjs';

const BASE_COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-07-17T12:00:00.000Z');

function source(appId, {
  humanDecision = '批准',
  evidenceVersion = 1,
  slug = `game-${appId}`,
} = {}) {
  return {
    candidateId: `steam:${appId}`,
    catalogAction: 'new_game',
    steamAppId: appId,
    slug,
    title: `Game ${appId}`,
    platforms: ['pc'],
    evidence: { appId, evidenceVersion, paid: true },
    humanDecision,
  };
}

function payload(appId) {
  return {
    [appId]: {
      success: true,
      data: {
        steam_appid: appId,
        name: `Game ${appId}`,
        type: 'game',
        is_free: false,
        release_date: { coming_soon: false, date: 'Jan 2, 2020' },
        price_overview: { currency: 'USD', initial: 1999, final: 999, discount_percent: 50 },
        recommendations: { total: 100 },
      },
    },
  };
}

function verifiedContext(candidateSource, verifiedAt = '2026-07-17T00:00:00.000Z') {
  const [joined] = joinCandidatesWithState([candidateSource], createEmptyImportState());
  const state = transitionVerify(createEmptyImportState(), joined, VERIFY_STATUS.PASSED, { at: verifiedAt });
  return { state, candidate: joinCandidatesWithState([candidateSource], state)[0] };
}

function finalSteamSource() {
  return {
    kind: 'steam-candidates',
    mode: 'final',
    provisional: false,
    distinctUtcDates: Array.from({ length: 14 }, (_value, index) => `2026-07-${String(index + 1).padStart(2, '0')}`),
  };
}

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-cli-'));
  const importDir = path.join(root, 'private', 'game-library', 'import');
  return {
    root,
    paths: {
      workbookPath: path.join(root, 'library.xlsx'),
      statePath: path.join(importDir, 'state.json'),
      outputDir: importDir,
      catalogPath: path.join(root, 'catalog.json'),
      stateRoot: importDir,
    },
  };
}

function capturedStdout() {
  let bytes = '';
  return {
    write: (chunk) => { bytes += chunk; },
    json: () => JSON.parse(bytes),
  };
}

test('strict parser rejects raw --plan bypass, unknown/missing options, and mixed modes', () => {
  assert.throws(
    () => parseImportArgs(['--apply', '--batch', '1', '--candidate-source', 'candidates.json', '--plan', 'raw.json']),
    /unknown import argument/u,
  );
  assert.throws(() => parseImportArgs(['--verify', '--candidate-source']), /requires a value/u);
  assert.throws(() => parseImportArgs(['--verify', '--resume', 'run-001']), /exactly one/u);
  assert.throws(() => parseImportArgs(['--apply', '--batch', '0', '--candidate-source', 'x']), /1..100/u);
  assert.throws(() => parseImportArgs(['--status', 'run-001', '--batch', '1']), /not valid/u);
  assert.throws(() => parseImportArgs(['--resume', 'run-001', '--run-id', 'run-002']), /not valid/u);
  assert.throws(() => validateCandidateSourceDocument(sealEvidenceDocument({
    schemaVersion: 1,
    kind: 'self-signed-batch-plan',
    candidates: [],
  })), /unsupported candidate source kind/u);
  const forged = sealEvidenceDocument({
    schemaVersion: 1,
    kind: 'steam-candidates',
    mode: 'pilot',
    provisional: true,
    distinctUtcDates: ['2026-07-17'],
    rankingSampleDigests: [`sha256:${'a'.repeat(64)}`],
    candidates: [{
      candidateId: 'steam:42', steamAppId: 42, title: 'Self-signed Paid Game', humanDecision: '待定',
    }],
  });
  assert.throws(() => validateCandidateSourceDocument(forged), /candidate|slugHint|catalog action/iu);
});

test('production entrypoint reports parser errors as JSON on stderr with non-zero exit', () => {
  const result = spawnSync(process.execPath, ['scripts/import-library.mjs', '--apply', '--plan', 'raw.json'], {
    cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..'),
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.equal(error.ok, false);
  assert.match(error.error.message, /unknown import argument/u);
});

test('candidate source must be sealed before workbook or state can influence verification', async () => {
  const fixture = tempPaths();
  const candidateSource = path.join(fixture.root, 'unsealed.json');
  fs.writeFileSync(candidateSource, `${JSON.stringify({ schemaVersion: 1, candidates: [] })}\n`);
  const parsed = parseImportArgs(['--verify', '--candidate-source', candidateSource]);
  await assert.rejects(
    () => executeImportCommand(parsed, { root: fixture.root, paths: fixture.paths }),
    /documentDigest/u,
  );
});

test('unapproved and stale approvals perform zero outbound verification calls', async () => {
  const fixture = tempPaths();
  const pendingSource = source(41, { humanDecision: '待定' });
  const [pending] = joinCandidatesWithState([pendingSource], createEmptyImportState());
  const original = source(42, { evidenceVersion: 1 });
  const verified = verifiedContext(original);
  const [stale] = joinCandidatesWithState([source(42, { evidenceVersion: 2 })], verified.state);
  let calls = 0;
  const stdout = capturedStdout();
  const result = await runImportCli([
    '--verify', '--candidate-source', 'sealed.json', '--max-requests', '10', '--sleep-ms', '0',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ candidates: [pending, stale], state: verified.state }),
    readCatalog: () => ({ games: [] }),
    fetchSteamAppDetails: async () => { calls += 1; return payload(42); },
    configureRequestBudget: () => {},
    wait: async () => {},
    exportReports: () => ({ outputPaths: { verifyReport: 'verify.csv', review: 'review.csv' } }),
    stdout: stdout.write,
  });
  assert.equal(calls, 0);
  assert.equal(result.processed, 0);
  assert.equal(stdout.json().ok, true);
});

test('expired passed verification is refreshed and atomically persisted per row', async () => {
  const fixture = tempPaths();
  const candidateSource = source(42);
  const old = verifiedContext(candidateSource, '2026-07-01T00:00:00.000Z');
  let calls = 0;
  const writes = [];
  const result = await runImportCli([
    '--verify', '--candidate-source', 'sealed.json', '--max-requests', '1', '--sleep-ms', '0',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ candidates: [old.candidate], state: old.state }),
    readCatalog: () => ({ games: [] }),
    fetchSteamAppDetails: async (appId) => { calls += 1; return payload(appId); },
    configureRequestBudget: () => {},
    wait: async () => {},
    writeState: (_file, state) => writes.push(structuredClone(state)),
    exportReports: () => ({ outputPaths: { verifyReport: 'verify.csv', review: 'review.csv' } }),
    stdout: () => {},
  });
  assert.equal(calls, 1);
  assert.equal(result.passed, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].candidates['steam:42'].verifiedAt, NOW.toISOString());
});

test('apply generates its own plan, selects only fresh passed rows, then persists staged → applied', async () => {
  const fixture = tempPaths();
  const passedSource = source(42);
  const verified = verifiedContext(passedSource);
  const pendingSource = source(43);
  const candidates = joinCandidatesWithState([passedSource, pendingSource], verified.state);
  const writes = [];
  let receivedPlan;
  const stdout = capturedStdout();
  const result = await runImportCli([
    '--apply', '--batch', '25', '--candidate-source', 'sealed.json',
    '--batch-id', 'steam-cli-test', '--run-id', 'steam-cli-test-run-1',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ source: finalSteamSource(), candidates, state: verified.state }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    writeState: (_file, state) => writes.push(structuredClone(state)),
    startRun: (_root, plan) => { receivedPlan = plan; return { state: 'applied', runId: 'steam-cli-test-run-1' }; },
    stdout: stdout.write,
  });
  assert.deepEqual(receivedPlan.items.map((item) => item.key), ['steam:42']);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].candidates['steam:42'].applyStatus, APPLY_STATUS.STAGED);
  assert.equal(writes[1].candidates['steam:42'].applyStatus, APPLY_STATUS.APPLIED);
  assert.equal(writes[1].candidates['steam:43'], undefined);
  assert.equal(result.state, 'applied');
  assert.equal(stdout.json().batchId, 'steam-cli-test');
});

test('pilot/provisional Steam source may be reviewed but cannot generate a Phase B plan', async () => {
  const fixture = tempPaths();
  const verified = verifiedContext(source(42));
  let starts = 0;
  let writes = 0;
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'pilot.json',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({
      source: {
        kind: 'steam-candidates',
        mode: 'pilot',
        provisional: true,
        distinctUtcDates: ['2026-07-17'],
      },
      candidates: [verified.candidate],
      state: verified.state,
    }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    startRun: () => { starts += 1; },
    writeState: () => { writes += 1; },
    stdout: () => {},
  }), /provisional Steam candidates cannot be applied/u);
  assert.equal(starts, 0);
  assert.equal(writes, 0);
});

test('network-paused apply remains staged; resume uses the trusted run plan and marks applied', async () => {
  const fixture = tempPaths();
  const verified = verifiedContext(source(42));
  const candidates = [verified.candidate];
  let currentState = verified.state;
  let trustedPlan;
  const runId = 'steam-paused-run-1';
  const common = {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ source: finalSteamSource(), candidates, state: currentState }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    writeState: (_file, state) => { currentState = structuredClone(state); },
    readState: () => currentState,
    loadRunPlan: () => trustedPlan,
    runStatus: () => ({ state: 'paused' }),
    stdout: () => {},
  };
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'sealed.json',
    '--batch-id', 'steam-paused', '--run-id', runId,
  ], {
    ...common,
    startRun: (_root, plan) => {
      trustedPlan = plan;
      throw new Error('injected network pause');
    },
  }), /injected network pause/u);
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.STAGED);

  const resumed = await runImportCli(['--resume', runId], {
    ...common,
    resumeRun: () => ({ state: 'applied', runId }),
  });
  assert.equal(resumed.state, 'applied');
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.APPLIED);
});

test('apply startup failure without a trusted run manifest marks staged rows failed', async () => {
  const fixture = tempPaths();
  const verified = verifiedContext(source(42));
  const writes = [];
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'sealed.json',
    '--batch-id', 'steam-start-fail', '--run-id', 'steam-start-fail-run-1',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ source: finalSteamSource(), candidates: [verified.candidate], state: verified.state }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    startRun: () => { throw new Error('repository not ready'); },
    runStatus: () => { throw new Error('run was not created'); },
    writeState: (_file, state) => writes.push(structuredClone(state)),
    stdout: () => {},
  }), /repository not ready/u);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].candidates['steam:42'].applyStatus, APPLY_STATUS.STAGED);
  assert.equal(writes[1].candidates['steam:42'].applyStatus, APPLY_STATUS.FAILED);
  assert.match(writes[1].candidates['steam:42'].applyReason, /start failed/u);
});

test('abort asks S5 first, then converts staged state to failed with aborted reason', async () => {
  const fixture = tempPaths();
  const verified = verifiedContext(source(42));
  let trustedPlan;
  let currentState = verified.state;
  const writes = [];
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'sealed.json',
    '--batch-id', 'steam-abort', '--run-id', 'steam-abort-run-1',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ source: finalSteamSource(), candidates: [verified.candidate], state: currentState }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    writeState: (_file, state) => { currentState = structuredClone(state); },
    startRun: (_root, plan) => { trustedPlan = plan; return { state: 'paused' }; },
    stdout: () => {},
  }), /run state is paused/u);
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.STAGED);

  let s5Confirmed = false;
  const aborted = await runImportCli(['--abort', 'steam-abort-run-1'], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadRunPlan: () => trustedPlan,
    readState: () => currentState,
    abortRun: () => { s5Confirmed = true; return { state: 'aborted' }; },
    writeState: (_file, state) => {
      assert.equal(s5Confirmed, true, 'machine state must change only after S5 confirms no promotion');
      currentState = structuredClone(state);
      writes.push(state);
    },
    stdout: () => {},
  });
  assert.equal(aborted.state, 'aborted');
  assert.equal(writes.length, 1);
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.FAILED);
  assert.equal(currentState.candidates['steam:42'].applyReason, 'aborted');
});

test('abort discovering an already-promoted run synchronizes S6 state to applied and still fails', async () => {
  const fixture = tempPaths();
  const verified = verifiedContext(source(42));
  let trustedPlan;
  let currentState = verified.state;
  await assert.rejects(() => runImportCli([
    '--apply', '--batch', '1', '--candidate-source', 'sealed.json',
    '--batch-id', 'steam-promoted', '--run-id', 'steam-promoted-run-1',
  ], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadContext: () => ({ source: finalSteamSource(), candidates: [verified.candidate], state: currentState }),
    readCatalog: () => ({ games: [] }),
    repositoryIdentity: () => ({ branch: 'main', baseCommit: BASE_COMMIT }),
    writeState: (_file, state) => { currentState = structuredClone(state); },
    startRun: (_root, plan) => { trustedPlan = plan; return { state: 'paused' }; },
    stdout: () => {},
  }), /run state is paused/u);
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.STAGED);

  await assert.rejects(() => runImportCli(['--abort', 'steam-promoted-run-1'], {
    root: fixture.root,
    paths: fixture.paths,
    clock: () => NOW,
    loadRunPlan: () => trustedPlan,
    readState: () => currentState,
    abortRun: () => { throw new Error('an applied import cannot be aborted'); },
    runStatus: () => ({ state: 'applied' }),
    writeState: (_file, state) => { currentState = structuredClone(state); },
    stdout: () => {},
  }), /applied import cannot be aborted/u);
  assert.equal(currentState.candidates['steam:42'].applyStatus, APPLY_STATUS.APPLIED);
});

test('status is JSON-only and read-only', async () => {
  const fixture = tempPaths();
  const stdout = capturedStdout();
  const result = await runImportCli(['--status', 'steam-status-run-1'], {
    root: fixture.root,
    paths: fixture.paths,
    runStatus: () => ({ state: 'paused', runId: 'steam-status-run-1' }),
    writeState: () => { throw new Error('status must not write state'); },
    stdout: stdout.write,
  });
  assert.equal(result.manifest.state, 'paused');
  assert.equal(stdout.json().mode, 'status');
});
