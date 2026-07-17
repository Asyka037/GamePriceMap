import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STEAM_REGIONS } from '../lib/steam.mjs';
import { createBatchPlan, fileSha256, readJsonFile, sha256 } from '../lib/import-run.mjs';
import { git, headCommit, isRegisteredWorktree } from '../lib/import-git.mjs';
import {
  abortImportRun,
  expectedImportWorktreePath,
  importRunStatus,
  resumeImportRun,
  startImportRun,
  STEP_TIMEOUT_MS,
} from '../lib/import-orchestrator.mjs';

function writeJson(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-orchestrator-'));
  git(root, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'private/\nnode_modules/\ndist/\n.astro/\n');
  writeJson(root, 'data/catalog.json', { games: [] });
  writeJson(root, 'data/source-health.json', { updatedAt: null, sources: {} });
  writeJson(root, 'data/health.json', { updatedAt: null, games: 0, sources: {} });
  git(root, ['add', '--all']);
  git(root, ['commit', '--no-gpg-sign', '-m', 'base']);
  return root;
}

function batch(root, id = 'steam-test-0001') {
  return createBatchPlan({
    batchId: id,
    baseCommit: headCommit(root),
    branch: 'main',
    addedAt: '2026-07-17',
    items: [{
      key: 'steam:222',
      catalogAction: 'new_game',
      slug: 'new-game',
      title: 'New Game',
      steamAppId: 222,
      nsuids: null,
      platforms: ['pc'],
      evidenceDigest: sha256('evidence'),
      humanDecisionDigest: sha256('approved'),
      verifiedAt: '2026-07-17T00:00:00Z',
    }],
  });
}

function fakeRuntime({ failAt = null } = {}) {
  let failed = false;
  return {
    linkDependencies() {},
    executeStep(step, worktree, plan, logFile) {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, `${step}\n`);
      if (step === failAt && !failed) {
        failed = true;
        throw new Error(`injected ${step} failure`);
      }
      const slug = plan.items[0].slug;
      if (step === 'steam') writeJson(worktree, `data/snapshots/steam/${slug}.json`, {
        slug,
        regions: STEAM_REGIONS.map((cc) => ({ cc: cc.toUpperCase(), currency: 'USD', amount: 20, list: null, discountPct: null, saleEndsAt: null })),
      });
      if (step === 'meta') writeJson(worktree, `data/meta/${slug}.json`, {
        slug, name: 'New Game', headerImage: 'https://example.com/cover.jpg', genres: ['Action'], reviewCount: 10,
      });
      if (step === 'history') writeJson(worktree, `data/history/${slug}.json`, {
        slug, events: [{ d: '2026-07-17', ch: 'steam', cc: 'US', usd: 20, discountPct: null }], atl: { pc: { usd: 20, date: '2026-07-17', seed: 'self' } },
      });
      if (step === 'validate') writeJson(worktree, 'data/health.json', { updatedAt: '2026-07-17T00:00:00Z', games: 1, sources: {} });
    },
  };
}

test('orchestrator keeps main untouched until all gates pass and records an idempotent receipt', () => {
  const root = initRepo();
  const plan = batch(root);
  const base = headCommit(root);
  const stateRoot = path.join(root, 'private', 'game-library', 'import');
  const result = startImportRun(root, plan, {
    stateRoot,
    runId: 'steam-test-0001-run-1',
    worktreeParent: os.tmpdir(),
    runtime: fakeRuntime(),
  });
  assert.equal(result.state, 'applied');
  assert.notEqual(headCommit(root), base);
  const receipt = readJsonFile(path.join(root, 'data', 'imports', 'steam-test-0001.json'));
  assert.equal(receipt.batchDigest, plan.batchDigest);
  const head = headCommit(root);
  assert.deepEqual(startImportRun(root, plan, { stateRoot, runtime: fakeRuntime() }), { noOp: true, batchId: plan.batchId });
  assert.equal(headCommit(root), head, 'second apply must be a byte-level no-op');

  const catalog = readJsonFile(path.join(root, 'data', 'catalog.json'));
  catalog.games.push({ slug: 'later-game', title: 'Later Game' });
  writeJson(root, 'data/catalog.json', catalog);
  git(root, ['add', 'data/catalog.json']);
  git(root, ['commit', '--no-gpg-sign', '-m', 'later catalog batch']);
  assert.deepEqual(startImportRun(root, plan, { stateRoot, runtime: fakeRuntime() }), { noOp: true, batchId: plan.batchId });
});

test('injected network failure pauses with main unchanged and resume starts from the checkpoint', () => {
  const root = initRepo();
  const plan = batch(root, 'steam-test-0002');
  const base = headCommit(root);
  const stateRoot = path.join(root, 'private', 'game-library', 'import');
  const runId = 'steam-test-0002-run-1';
  assert.throws(() => startImportRun(root, plan, {
    stateRoot,
    runId,
    worktreeParent: os.tmpdir(),
    runtime: fakeRuntime({ failAt: 'meta' }),
  }), /injected meta failure/);
  assert.equal(headCommit(root), base);
  assert.equal(readJsonFile(path.join(stateRoot, 'runs', runId, 'manifest.json')).state, 'paused');
  const resumed = resumeImportRun(root, runId, { stateRoot, runtime: fakeRuntime() });
  assert.equal(resumed.state, 'applied');
  assert.notEqual(headCommit(root), base);
});

test('forged working-tree and tracked receipts never authorize an idempotent no-op', () => {
  const untrackedRoot = initRepo();
  const untrackedPlan = batch(untrackedRoot, 'steam-test-forged-1');
  const untrackedState = path.join(untrackedRoot, 'private', 'game-library', 'import');
  writeJson(untrackedRoot, `data/imports/${untrackedPlan.batchId}.json`, {
    schemaVersion: 1,
    batchId: untrackedPlan.batchId,
    batchDigest: untrackedPlan.batchDigest,
  });
  assert.throws(() => startImportRun(untrackedRoot, untrackedPlan, {
    stateRoot: untrackedState,
    runId: 'steam-test-forged-1-run',
    runtime: fakeRuntime(),
  }), /working tree is not clean/);

  const trackedRoot = initRepo();
  const trackedPlan = batch(trackedRoot, 'steam-test-forged-2');
  const trackedState = path.join(trackedRoot, 'private', 'game-library', 'import');
  writeJson(trackedRoot, `data/imports/${trackedPlan.batchId}.json`, {
    schemaVersion: 1,
    batchId: trackedPlan.batchId,
    batchDigest: trackedPlan.batchDigest,
    baseCommit: trackedPlan.baseCommit,
    appliedAt: '2026-07-17T00:00:00Z',
    items: [],
    artifacts: {},
  });
  git(trackedRoot, ['add', `data/imports/${trackedPlan.batchId}.json`]);
  git(trackedRoot, ['commit', '--no-gpg-sign', '-m', 'forged receipt']);
  assert.throws(() => startImportRun(trackedRoot, trackedPlan, {
    stateRoot: trackedState,
    runId: 'steam-test-forged-2-run',
    runtime: fakeRuntime(),
  }), /receipt items do not match plan/);
});

test('worktree creation is journaled before linking and a link failure resumes cleanly', () => {
  const root = initRepo();
  const plan = batch(root, 'steam-test-setup');
  const stateRoot = path.join(root, 'private', 'game-library', 'import');
  const worktreeParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-parent-'));
  const runId = 'steam-test-setup-run-1';
  let failLink = true;
  const runtime = {
    ...fakeRuntime(),
    linkDependencies() {
      if (failLink) {
        failLink = false;
        throw new Error('injected dependency link failure');
      }
    },
  };
  assert.throws(() => startImportRun(root, plan, {
    stateRoot, worktreeParent, runId, runtime,
  }), /dependency link failure/);
  const expected = expectedImportWorktreePath(root, worktreeParent, runId);
  const paused = importRunStatus(root, runId, { stateRoot });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.resumeState, 'worktree_creating');
  assert.equal(paused.worktreePath, expected);
  assert.equal(isRegisteredWorktree(root, expected), false);
  assert.equal(fs.existsSync(expected), false);

  const resumed = resumeImportRun(root, runId, { stateRoot, worktreeParent, runtime });
  assert.equal(resumed.state, 'applied');
  assert.equal(isRegisteredWorktree(root, expected), false);
});

test('resume recovers a promotion crash when the branch descended from the sealed commit', () => {
  const root = initRepo();
  const plan = batch(root, 'steam-test-recover');
  const stateRoot = path.join(root, 'private', 'game-library', 'import');
  const runId = 'steam-test-recover-run-1';
  const applied = startImportRun(root, plan, { stateRoot, runId, runtime: fakeRuntime() });
  const file = path.join(stateRoot, 'runs', runId, 'manifest.json');
  writeJson(root, path.relative(root, file), { ...applied, state: 'promoting', resumeState: null });
  fs.writeFileSync(path.join(root, 'post-import.txt'), 'later clean commit\n');
  git(root, ['add', 'post-import.txt']);
  git(root, ['commit', '--no-gpg-sign', '-m', 'post import commit']);
  const descendant = headCommit(root);

  const recovered = resumeImportRun(root, runId, { stateRoot, runtime: fakeRuntime() });
  assert.equal(recovered.state, 'applied');
  assert.equal(recovered.steps.promote.recovered, true);
  assert.equal(headCommit(root), descendant);

  writeJson(root, path.relative(root, file), { ...recovered, state: 'promoting', resumeState: null });
  assert.throws(() => abortImportRun(root, runId, { stateRoot, runtime: fakeRuntime() }), /applied import cannot be aborted/);
  assert.equal(importRunStatus(root, runId, { stateRoot }).state, 'applied');
});

test('stale base and final artifact failures are persisted instead of disappearing on throw', () => {
  const staleRoot = initRepo();
  const stalePlan = batch(staleRoot, 'steam-test-stale');
  const staleState = path.join(staleRoot, 'private', 'game-library', 'import');
  const staleRun = 'steam-test-stale-run-1';
  assert.throws(() => startImportRun(staleRoot, stalePlan, {
    stateRoot: staleState,
    runId: staleRun,
    runtime: fakeRuntime({ failAt: 'meta' }),
  }), /injected meta failure/);
  fs.writeFileSync(path.join(staleRoot, 'concurrent.txt'), 'new head\n');
  git(staleRoot, ['add', 'concurrent.txt']);
  git(staleRoot, ['commit', '--no-gpg-sign', '-m', 'concurrent']);
  assert.throws(() => resumeImportRun(staleRoot, staleRun, {
    stateRoot: staleState,
    runtime: fakeRuntime(),
  }), /stale base/);
  assert.equal(importRunStatus(staleRoot, staleRun, { stateRoot: staleState }).state, 'stale_base');
  assert.equal(abortImportRun(staleRoot, staleRun, { stateRoot: staleState }).state, 'aborted');

  const failedRoot = initRepo();
  const failedPlan = batch(failedRoot, 'steam-test-artifact');
  const failedState = path.join(failedRoot, 'private', 'game-library', 'import');
  const failedRun = 'steam-test-artifact-run-1';
  assert.throws(() => startImportRun(failedRoot, failedPlan, {
    stateRoot: failedState,
    runId: failedRun,
    runtime: {
      ...fakeRuntime(),
      validateArtifacts() { throw new Error('injected semantic artifact failure'); },
    },
  }), /semantic artifact failure/);
  const failed = importRunStatus(failedRoot, failedRun, { stateRoot: failedState });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.steps.seal.status, 'failed');
  assert.equal(headCommit(failedRoot), failedPlan.baseCommit);
  assert.equal(abortImportRun(failedRoot, failedRun, { stateRoot: failedState }).state, 'aborted');
});

test('tampered manifest paths cannot redirect abort cleanup', () => {
  const root = initRepo();
  const plan = batch(root, 'steam-test-path');
  const stateRoot = path.join(root, 'private', 'game-library', 'import');
  const runId = 'steam-test-path-run-1';
  assert.throws(() => startImportRun(root, plan, {
    stateRoot,
    runId,
    runtime: { ...fakeRuntime(), linkDependencies() { throw new Error('stop after create'); } },
  }), /stop after create/);
  const manifestFile = path.join(stateRoot, 'runs', runId, 'manifest.json');
  const manifest = readJsonFile(manifestFile);
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-victim-'));
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'do not remove\n');
  writeJson(root, path.relative(root, manifestFile), { ...manifest, worktreePath: victim });
  assert.throws(() => abortImportRun(root, runId, { stateRoot }), /worktree path mismatch/);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'do not remove\n');
});

test('tampered checkpoint and sealed commits are audited before execution or promotion', () => {
  const checkpointRoot = initRepo();
  const checkpointPlan = batch(checkpointRoot, 'steam-test-checkpoint-attack');
  const checkpointState = path.join(checkpointRoot, 'private', 'game-library', 'import');
  const checkpointRun = 'steam-test-checkpoint-attack-run';
  assert.throws(() => startImportRun(checkpointRoot, checkpointPlan, {
    stateRoot: checkpointState,
    runId: checkpointRun,
    runtime: fakeRuntime({ failAt: 'meta' }),
  }), /injected meta failure/);
  const checkpointManifestFile = path.join(checkpointState, 'runs', checkpointRun, 'manifest.json');
  const checkpointManifest = readJsonFile(checkpointManifestFile);
  const evilFile = path.join(checkpointManifest.worktreePath, 'scripts', 'evil.mjs');
  fs.mkdirSync(path.dirname(evilFile), { recursive: true });
  fs.writeFileSync(evilFile, 'throw new Error("executed untrusted checkpoint")\n');
  git(checkpointManifest.worktreePath, ['add', 'scripts/evil.mjs']);
  git(checkpointManifest.worktreePath, ['commit', '--no-gpg-sign', '-m', 'untrusted checkpoint']);
  const untrustedCheckpoint = headCommit(checkpointManifest.worktreePath);
  writeJson(checkpointRoot, path.relative(checkpointRoot, checkpointManifestFile), {
    ...checkpointManifest,
    checkpointCommit: untrustedCheckpoint,
    files: { ...checkpointManifest.files, 'scripts/evil.mjs': fileSha256(evilFile) },
  });
  let executed = false;
  assert.throws(() => resumeImportRun(checkpointRoot, checkpointRun, {
    stateRoot: checkpointState,
    runtime: {
      ...fakeRuntime(),
      executeStep(...args) {
        executed = true;
        return fakeRuntime().executeStep(...args);
      },
    },
  }), /unexpected cumulative import changes: scripts\/evil\.mjs/);
  assert.equal(executed, false);
  assert.equal(headCommit(checkpointRoot), checkpointPlan.baseCommit);

  const sealRoot = initRepo();
  const sealPlan = batch(sealRoot, 'steam-test-seal-attack');
  const sealState = path.join(sealRoot, 'private', 'game-library', 'import');
  const sealRun = 'steam-test-seal-attack-run';
  assert.throws(() => startImportRun(sealRoot, sealPlan, {
    stateRoot: sealState,
    runId: sealRun,
    runtime: fakeRuntime({ failAt: 'meta' }),
  }), /injected meta failure/);
  const sealManifestFile = path.join(sealState, 'runs', sealRun, 'manifest.json');
  const sealManifest = readJsonFile(sealManifestFile);
  const sealEvil = path.join(sealManifest.worktreePath, 'scripts', 'evil.mjs');
  fs.mkdirSync(path.dirname(sealEvil), { recursive: true });
  fs.writeFileSync(sealEvil, 'throw new Error("promoted untrusted tree")\n');
  git(sealManifest.worktreePath, ['add', 'scripts/evil.mjs']);
  git(sealManifest.worktreePath, ['commit', '--no-gpg-sign', '-m', 'untrusted tree']);
  const tree = git(sealManifest.worktreePath, ['rev-parse', 'HEAD^{tree}']);
  const forgedSeal = git(sealRoot, ['commit-tree', tree, '-p', sealPlan.baseCommit, '-m', 'forged seal']);
  writeJson(sealRoot, path.relative(sealRoot, sealManifestFile), {
    ...sealManifest,
    state: 'sealed',
    resumeState: null,
    sealedCommit: forgedSeal,
    sealedTree: tree,
    files: { ...sealManifest.files, 'scripts/evil.mjs': fileSha256(sealEvil) },
  });
  assert.throws(() => resumeImportRun(sealRoot, sealRun, {
    stateRoot: sealState,
    runtime: fakeRuntime(),
  }), /unexpected cumulative import changes: scripts\/evil\.mjs/);
  assert.equal(importRunStatus(sealRoot, sealRun, { stateRoot: sealState }).state, 'failed');
  assert.equal(headCommit(sealRoot), sealPlan.baseCommit);
});

test('every built-in subprocess step has a finite explicit timeout', () => {
  assert.deepEqual(Object.keys(STEP_TIMEOUT_MS).sort(), ['build', 'eshop', 'history', 'meta', 'steam', 'test', 'validate']);
  assert.equal(Object.values(STEP_TIMEOUT_MS).every((value) => Number.isFinite(value) && value > 0), true);
});
