import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyBatchToCatalog, importAllowlist } from './catalog.mjs';
import { validateImportArtifacts } from './import-artifacts.mjs';
import {
  atomicWriteJson,
  atomicWriteText,
  assertFileHashes,
  createRunManifest,
  fileSha256,
  normalizeRepoPath,
  readJsonFile,
  sha256,
  transitionRun,
  updateStep,
  validateBatchPlan,
  validateRunManifest,
} from './import-run.mjs';
import {
  addDetachedWorktree,
  assertCumulativeImportTree,
  assertRepositoryReady,
  branchCommit,
  checkpointWorktree,
  git,
  isAncestor,
  isRegisteredWorktree,
  promoteFastForward,
  removeWorktree,
  sealWorktree,
} from './import-git.mjs';

const STATE_DIR_REL = 'private/game-library/import';
const NETWORK_STEPS = new Set(['steam', 'eshop', 'meta']);
export const STEP_TIMEOUT_MS = Object.freeze({
  steam: 15 * 60_000,
  eshop: 15 * 60_000,
  meta: 20 * 60_000,
  history: 5 * 60_000,
  test: 5 * 60_000,
  validate: 5 * 60_000,
  build: 10 * 60_000,
});
const STEP_STATE = Object.freeze({
  catalog: 'catalog_staged',
  steam: 'steam_done',
  eshop: 'eshop_done',
  meta: 'meta_done',
  history: 'history_done',
});

function runDir(stateRoot, runId) {
  if (!/^[a-z0-9][a-z0-9-]{5,95}$/.test(runId ?? '')) throw new Error('bad runId');
  return path.join(stateRoot, 'runs', runId);
}

function manifestPath(stateRoot, runId) {
  return path.join(runDir(stateRoot, runId), 'manifest.json');
}

function planPath(stateRoot, runId) {
  return path.join(runDir(stateRoot, runId), 'plan.json');
}

function receiptPath(root, batchId) {
  return path.join(root, 'data', 'imports', `${batchId}.json`);
}

function writeManifest(stateRoot, manifest) {
  atomicWriteJson(manifestPath(stateRoot, manifest.runId), manifest);
}

function readManifest(stateRoot, runId, plan) {
  return validateRunManifest(readJsonFile(manifestPath(stateRoot, runId)), plan, { runId });
}

export function expectedImportWorktreePath(root, worktreeParent, runId) {
  const fingerprint = sha256(fs.realpathSync(root)).slice(-12);
  return path.resolve(worktreeParent, `gamepricemap-import-${fingerprint}-${runId}`);
}

function assertExpectedWorktreePath(root, worktreeParent, manifest) {
  const expected = expectedImportWorktreePath(root, worktreeParent, manifest.runId);
  if (manifest.worktreePath !== expected) throw new Error(`run manifest worktree path mismatch: expected ${expected}`);
  return expected;
}

function removeOwnedRunWorktree(root, worktreeParent, manifest) {
  if (!manifest.worktreePath) return false;
  const expected = assertExpectedWorktreePath(root, worktreeParent, manifest);
  if (isRegisteredWorktree(root, expected)) return removeWorktree(root, expected, { force: true });
  if (fs.existsSync(expected)) throw new Error(`refuses to remove unregistered import path: ${expected}`);
  return false;
}

function recreateOwnedRunWorktree(root, worktreeParent, manifest, commit) {
  const expected = assertExpectedWorktreePath(root, worktreeParent, manifest);
  if (isRegisteredWorktree(root, expected)) removeWorktree(root, expected, { force: true });
  else if (fs.existsSync(expected)) throw new Error(`refuses to replace unregistered import path: ${expected}`);
  return addDetachedWorktree(root, expected, commit);
}

function processAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireImportLock(stateRoot) {
  fs.mkdirSync(stateRoot, { recursive: true });
  const lock = path.join(stateRoot, '.lock');
  const claim = () => {
    fs.mkdirSync(lock);
    atomicWriteJson(path.join(lock, 'owner.json'), {
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    });
  };
  try {
    claim();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner = null;
    try { owner = readJsonFile(path.join(lock, 'owner.json')); } catch { /* malformed locks are stale */ }
    if (owner?.hostname === os.hostname() && processAlive(owner.pid)) {
      throw new Error(`another import process holds the lock (pid ${owner.pid})`);
    }
    fs.rmSync(lock, { recursive: true, force: true });
    claim();
  }
  return () => fs.rmSync(lock, { recursive: true, force: true });
}

function linkDependencies(root, worktree) {
  for (const relative of ['node_modules', 'site/node_modules']) {
    const source = path.join(root, relative);
    const target = path.join(worktree, relative);
    if (!fs.existsSync(source)) throw new Error(`missing ${relative}; install dependencies before starting an import`);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, 'dir');
  }
}

function commandFor(step, worktree, plan) {
  const allSlugs = plan.items.map((item) => item.slug);
  const steamSlugs = plan.items.filter((item) => Number.isInteger(item.steamAppId)).map((item) => item.slug);
  const eshopSlugs = plan.items.filter((item) => item.nsuids && Object.values(item.nsuids).some(Boolean)).map((item) => item.slug);
  if (step === 'steam') return steamSlugs.length ? [process.execPath, ['scripts/scrape-steam.mjs', ...steamSlugs]] : null;
  if (step === 'eshop') return eshopSlugs.length ? [process.execPath, ['scripts/scrape-eshop.mjs', ...eshopSlugs]] : null;
  if (step === 'meta') return [process.execPath, ['scripts/scrape-meta.mjs', ...allSlugs]];
  if (step === 'history') return [process.execPath, ['scripts/build-history.mjs', '--observations-only', ...allSlugs]];
  if (step === 'test') return ['npm', ['test']];
  if (step === 'validate') return ['npm', ['run', 'validate']];
  if (step === 'build') return ['npm', ['--prefix', 'site', 'run', 'build']];
  throw new Error(`no command for step ${step}`);
}

function stepAllowlist(step, plan) {
  const slugs = plan.items.map((item) => item.slug);
  if (step === 'catalog') return ['data/catalog.json'];
  if (step === 'steam') return [
    ...plan.items.filter((item) => Number.isInteger(item.steamAppId)).map((item) => `data/snapshots/steam/${item.slug}.json`),
    'data/rates/usd.json',
  ];
  if (step === 'eshop') return [
    ...plan.items.filter((item) => item.nsuids && Object.values(item.nsuids).some(Boolean)).map((item) => `data/snapshots/eshop/${item.slug}.json`),
    'data/rates/usd.json',
  ];
  if (step === 'meta') return slugs.map((slug) => `data/meta/${slug}.json`);
  if (step === 'history') return slugs.map((slug) => `data/history/${slug}.json`);
  if (step === 'validate') return ['data/health.json'];
  if (step === 'seal') return [`data/imports/${plan.batchId}.json`];
  return [];
}

function executeCommand(step, worktree, plan, logFile, { timeoutMs = STEP_TIMEOUT_MS[step] } = {}) {
  const command = commandFor(step, worktree, plan);
  if (!command) {
    atomicWriteText(logFile, `${step}: no applicable games\n`);
    return;
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error(`invalid timeout for ${step}`);
  const [program, args] = command;
  const result = spawnSync(program, args, {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  atomicWriteText(logFile, output || `${step}: no output\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${step} exited ${result.status}${result.signal ? ` (${result.signal})` : ''}; see ${logFile}`);
}

function checkpointStep({ root, stateRoot, manifest, plan, step, action }) {
  const file = manifestPath(stateRoot, manifest.runId);
  const logFile = path.join(runDir(stateRoot, manifest.runId), 'logs', `${step}.log`);
  let next = updateStep(manifest, step, {
    status: 'running',
    attempts: (manifest.steps[step]?.attempts ?? 0) + 1,
    startedAt: new Date().toISOString(),
    logFile,
  });
  atomicWriteJson(file, next);
  try {
    action(logFile);
    const checkpoint = checkpointWorktree(next.worktreePath, {
      step,
      allowlist: stepAllowlist(step, plan),
      message: `import ${plan.batchId}: ${step}`,
    });
    next = updateStep(next, step, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      checkpointCommit: checkpoint.commit,
      files: checkpoint.files,
    });
    next = {
      ...next,
      checkpointCommit: checkpoint.commit,
      files: { ...next.files, ...checkpoint.files },
    };
    if (STEP_STATE[step]) next = transitionRun(next, STEP_STATE[step]);
    writeManifest(stateRoot, next);
    return next;
  } catch (error) {
    const recoverable = NETWORK_STEPS.has(step);
    next = updateStep(next, step, { status: 'failed', completedAt: new Date().toISOString(), error: error.message });
    next = transitionRun(next, recoverable ? 'paused' : 'failed', {
      resumeState: manifest.state,
      error: { step, message: error.message },
    });
    writeManifest(stateRoot, next);
    throw error;
  }
}

function stageCatalog(worktree, plan) {
  const file = path.join(worktree, 'data', 'catalog.json');
  const catalog = readJsonFile(file);
  const next = applyBatchToCatalog(catalog, plan);
  atomicWriteText(file, `${JSON.stringify(next, null, 2)}\n`);
}

function writeReceipt(worktree, plan, manifest, artifactReport) {
  const receipt = {
    schemaVersion: 1,
    batchId: plan.batchId,
    batchDigest: plan.batchDigest,
    baseCommit: plan.baseCommit,
    appliedAt: new Date().toISOString(),
    items: plan.items.map((item) => ({
      key: item.key,
      slug: item.slug,
      catalogAction: item.catalogAction,
      evidenceDigest: item.evidenceDigest,
    })),
    artifacts: artifactReport.files,
  };
  atomicWriteText(receiptPath(worktree, plan.batchId), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function expectedReceiptArtifacts(plan) {
  const files = new Set(['data/catalog.json']);
  for (const item of plan.items) {
    if (Number.isInteger(item.steamAppId)) files.add(`data/snapshots/steam/${item.slug}.json`);
    if (item.nsuids && Object.values(item.nsuids).some(Boolean)) files.add(`data/snapshots/eshop/${item.slug}.json`);
    files.add(`data/meta/${item.slug}.json`);
    files.add(`data/history/${item.slug}.json`);
  }
  return [...files].sort();
}

function validateReceipt(receipt, plan) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('tracked import receipt must be an object');
  if (receipt.schemaVersion !== 1) throw new Error(`unsupported import receipt schema ${receipt.schemaVersion}`);
  for (const field of ['batchId', 'batchDigest', 'baseCommit']) {
    if (receipt[field] !== plan[field]) throw new Error(`tracked import receipt ${field} does not match plan`);
  }
  if (!(typeof receipt.appliedAt === 'string' && !Number.isNaN(Date.parse(receipt.appliedAt)))) throw new Error('tracked import receipt has invalid appliedAt');
  const expectedItems = plan.items.map((item) => ({
    key: item.key,
    slug: item.slug,
    catalogAction: item.catalogAction,
    evidenceDigest: item.evidenceDigest,
  }));
  if (JSON.stringify(receipt.items) !== JSON.stringify(expectedItems)) throw new Error('tracked import receipt items do not match plan');
  if (!receipt.artifacts || typeof receipt.artifacts !== 'object' || Array.isArray(receipt.artifacts)) {
    throw new Error('tracked import receipt artifacts must be an object');
  }
  const artifactPaths = Object.keys(receipt.artifacts).map(normalizeRepoPath).sort();
  if (JSON.stringify(artifactPaths) !== JSON.stringify(expectedReceiptArtifacts(plan))) {
    throw new Error('tracked import receipt artifact set does not match plan');
  }
  for (const [rel, digest] of Object.entries(receipt.artifacts)) {
    normalizeRepoPath(rel);
    if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
      throw new Error(`tracked import receipt has invalid artifact ${rel}`);
    }
  }
  return receipt;
}

function receiptFromBranch(root, branch, plan) {
  const ref = `refs/heads/${branch}`;
  const rel = `data/imports/${plan.batchId}.json`;
  const entry = git(root, ['ls-tree', '-z', ref, '--', rel], { trim: false });
  if (!entry) return null;
  const mode = entry.split(/\s+/, 1)[0];
  if (!['100644', '100755'].includes(mode)) throw new Error(`tracked import receipt is not a regular file: ${rel}`);
  let receipt;
  try {
    receipt = JSON.parse(git(root, ['show', `${ref}:${rel}`], { trim: false }));
  } catch (error) {
    throw new Error(`tracked import receipt is invalid JSON: ${rel}`, { cause: error });
  }
  return validateReceipt(receipt, plan);
}

function validateAppliedBranch(root, plan) {
  assertRepositoryReady(root, { branch: plan.branch });
  const receipt = receiptFromBranch(root, plan.branch, plan);
  if (!receipt) throw new Error(`tracked import receipt is missing for ${plan.batchId}`);
  validateImportArtifacts(root, plan);
  return receipt;
}

function finishPromotion(root, stateRoot, manifest, plan, { worktreeParent = os.tmpdir(), runtime = {} } = {}) {
  let next = manifest;
  if (next.state === 'sealed') {
    next = transitionRun(next, 'promoting');
    writeManifest(stateRoot, next);
  }
  if (next.state !== 'promoting') throw new Error(`cannot promote run in state ${next.state}`);
  try {
    assertCumulativeImportTree(root, {
      baseCommit: plan.baseCommit,
      checkpointCommit: next.sealedCommit,
      allowlist: importAllowlist(plan),
      recordedFiles: next.files,
    });
  } catch (error) {
    next = transitionRun(next, 'failed', {
      resumeState: 'promoting',
      error: { step: 'promote', message: error.message },
    });
    writeManifest(stateRoot, next);
    throw error;
  }
  let promoted;
  try {
    promoted = promoteFastForward(root, {
      branch: plan.branch,
      baseCommit: plan.baseCommit,
      sealedCommit: next.sealedCommit,
    });
  } catch (error) {
    const current = branchCommit(root, plan.branch);
    const state = current !== plan.baseCommit ? 'stale_base' : 'failed';
    next = transitionRun(next, state, {
      resumeState: 'promoting',
      error: { step: 'promote', message: error.message },
    });
    writeManifest(stateRoot, next);
    throw error;
  }
  try {
    (runtime.validateAppliedBranch ?? validateAppliedBranch)(root, plan);
  } catch (error) {
    next = updateStep(next, 'promote', {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
      ...promoted,
    });
    next = transitionRun(next, 'failed', {
      resumeState: 'promoting',
      error: { step: 'promote', message: error.message },
    });
    writeManifest(stateRoot, next);
    throw error;
  }
  next = updateStep(next, 'promote', { status: 'completed', completedAt: new Date().toISOString(), ...promoted });
  next = transitionRun(next, 'applied', { error: null });
  writeManifest(stateRoot, next);
  try { removeOwnedRunWorktree(root, worktreeParent, next); } catch { /* resumable cleanup on the next status/resume */ }
  return next;
}

function continueRun(root, stateRoot, manifest, plan, runtime = {}, worktreeParent = os.tmpdir()) {
  let next = manifest;
  if (next.state === 'sealed' || next.state === 'promoting') return finishPromotion(root, stateRoot, next, plan, { worktreeParent, runtime });
  const failFinal = (step, error) => {
    next = updateStep(next, step, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: error.message,
    });
    next = transitionRun(next, 'failed', {
      resumeState: next.state,
      error: { step, message: error.message },
    });
    writeManifest(stateRoot, next);
  };

  let sourceHealthBefore;
  try {
    sourceHealthBefore = next.sourceHealthBefore ?? fileSha256(path.join(next.worktreePath, 'data', 'source-health.json'));
  } catch (error) {
    failFinal('seal', error);
    throw error;
  }
  if (!next.sourceHealthBefore) {
    next = { ...next, sourceHealthBefore, updatedAt: new Date().toISOString() };
    writeManifest(stateRoot, next);
  }

  const steps = ['catalog', 'steam', 'eshop', 'meta', 'history', 'test', 'validate', 'build'];
  for (const step of steps) {
    if (next.steps[step].status === 'completed') continue;
    const action = step === 'catalog'
      ? () => stageCatalog(next.worktreePath, plan)
      : (logFile) => {
        if (runtime.executeStep) return runtime.executeStep(step, next.worktreePath, plan, logFile);
        return executeCommand(step, next.worktreePath, plan, logFile, {
          timeoutMs: runtime.stepTimeouts?.[step] ?? STEP_TIMEOUT_MS[step],
        });
      };
    next = checkpointStep({ root, stateRoot, manifest: next, plan, step, action });
  }

  if (next.state === 'history_done') {
    next = transitionRun(next, 'gates_passed');
    writeManifest(stateRoot, next);
  }
  try {
    const afterHealth = fileSha256(path.join(next.worktreePath, 'data', 'source-health.json'));
    if (afterHealth !== sourceHealthBefore) throw new Error('targeted import modified data/source-health.json');
  } catch (error) {
    failFinal('seal', error);
    throw error;
  }

  if (next.steps.seal.status !== 'completed') {
    next = checkpointStep({
      root,
      stateRoot,
      manifest: next,
      plan,
      step: 'seal',
      action: () => {
        const artifactReport = (runtime.validateArtifacts ?? validateImportArtifacts)(next.worktreePath, plan);
        writeReceipt(next.worktreePath, plan, next, artifactReport);
      },
    });
  }
  if (next.state === 'gates_passed' && !next.sealedCommit) {
    try {
      assertFileHashes(next.worktreePath, next.files);
      const sealed = sealWorktree(next.worktreePath, {
        baseCommit: plan.baseCommit,
        message: `feat(data): import ${plan.batchId} (${plan.items.length} games)`,
        allowlist: importAllowlist(plan),
        recordedFiles: next.files,
      });
      next = transitionRun(next, 'sealed', { sealedCommit: sealed.sealedCommit, sealedTree: sealed.tree });
      writeManifest(stateRoot, next);
    } catch (error) {
      failFinal('seal', error);
      throw error;
    }
  }
  return finishPromotion(root, stateRoot, next, plan, { worktreeParent, runtime });
}

export function startImportRun(root, plan, {
  stateRoot = path.join(root, STATE_DIR_REL),
  worktreeParent = os.tmpdir(),
  runId = `${plan.batchId}-${Date.now().toString(36)}`,
  runtime = {},
} = {}) {
  validateBatchPlan(plan);
  const release = acquireImportLock(stateRoot);
  try {
    assertRepositoryReady(root, { branch: plan.branch });
    const receipt = receiptFromBranch(root, plan.branch, plan);
    if (receipt) {
      validateImportArtifacts(root, plan);
      return { noOp: true, batchId: plan.batchId };
    }
    assertRepositoryReady(root, { branch: plan.branch, baseCommit: plan.baseCommit });
    const directory = runDir(stateRoot, runId);
    if (fs.existsSync(directory)) throw new Error(`run already exists: ${runId}`);
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteJson(planPath(stateRoot, runId), plan);
    let manifest = createRunManifest(plan, { runId });
    writeManifest(stateRoot, manifest);
    const worktreePath = expectedImportWorktreePath(root, worktreeParent, runId);
    manifest = transitionRun(manifest, 'worktree_creating', { worktreePath });
    writeManifest(stateRoot, manifest);
    try {
      addDetachedWorktree(root, worktreePath, plan.baseCommit);
      (runtime.linkDependencies ?? linkDependencies)(root, worktreePath);
      manifest = transitionRun(manifest, 'worktree_ready');
      writeManifest(stateRoot, manifest);
    } catch (error) {
      try { removeOwnedRunWorktree(root, worktreeParent, manifest); } catch { /* preserve the setup error */ }
      manifest = transitionRun(manifest, 'paused', {
        resumeState: 'worktree_creating',
        error: { step: 'setup', message: error.message },
      });
      writeManifest(stateRoot, manifest);
      throw error;
    }
    return continueRun(root, stateRoot, manifest, plan, runtime, worktreeParent);
  } finally {
    release();
  }
}

function recoverAppliedRun(root, stateRoot, manifest, plan, worktreeParent, runtime = {}) {
  assertCumulativeImportTree(root, {
    baseCommit: plan.baseCommit,
    checkpointCommit: manifest.sealedCommit,
    allowlist: importAllowlist(plan),
    recordedFiles: manifest.files,
  });
  (runtime.validateAppliedBranch ?? validateAppliedBranch)(root, plan);
  let next = { ...manifest, state: 'promoting', resumeState: null };
  next = updateStep(next, 'promote', {
    status: 'completed',
    completedAt: new Date().toISOString(),
    recovered: true,
    head: branchCommit(root, plan.branch),
  });
  next = transitionRun(next, 'applied', { error: null });
  writeManifest(stateRoot, next);
  try { removeOwnedRunWorktree(root, worktreeParent, next); } catch { /* cleanup can be retried */ }
  return next;
}

function pauseSetupFailure(root, stateRoot, manifest, worktreeParent, resumeState, error) {
  try { removeOwnedRunWorktree(root, worktreeParent, manifest); } catch { /* preserve the setup error */ }
  const next = transitionRun(manifest, 'paused', {
    resumeState,
    error: { step: 'setup', message: error.message },
  });
  writeManifest(stateRoot, next);
  return next;
}

export function resumeImportRun(root, runId, {
  stateRoot = path.join(root, STATE_DIR_REL),
  worktreeParent = os.tmpdir(),
  runtime = {},
} = {}) {
  const release = acquireImportLock(stateRoot);
  try {
    const plan = readJsonFile(planPath(stateRoot, runId));
    validateBatchPlan(plan);
    let manifest = readManifest(stateRoot, runId, plan);
    if (manifest.worktreePath) assertExpectedWorktreePath(root, worktreeParent, manifest);
    assertRepositoryReady(root, { branch: plan.branch });
    const current = branchCommit(root, plan.branch);

    if (manifest.state === 'applied') {
      (runtime.validateAppliedBranch ?? validateAppliedBranch)(root, plan);
      try { removeOwnedRunWorktree(root, worktreeParent, manifest); } catch { /* cleanup can be retried */ }
      return { ...manifest, noOp: true };
    }
    if (manifest.sealedCommit && isAncestor(root, manifest.sealedCommit, current)) {
      return recoverAppliedRun(root, stateRoot, manifest, plan, worktreeParent, runtime);
    }
    if (!['planned', 'worktree_creating', 'paused', 'sealed', 'promoting', 'worktree_ready', 'catalog_staged', 'steam_done', 'eshop_done', 'meta_done', 'history_done', 'gates_passed'].includes(manifest.state)) {
      throw new Error(`run state ${manifest.state} is not resumable; abort and create a corrected batch`);
    }
    if (current !== plan.baseCommit) {
      manifest = transitionRun(manifest, 'stale_base', {
        resumeState: manifest.state === 'paused' ? manifest.resumeState : manifest.state,
        error: { step: 'promote', message: `stale base: expected ${plan.baseCommit}, found ${current}` },
      });
      writeManifest(stateRoot, manifest);
      throw new Error(`stale base: expected ${plan.baseCommit}, found ${current}`);
    }

    if (manifest.state === 'planned') {
      manifest = transitionRun(manifest, 'worktree_creating', {
        worktreePath: expectedImportWorktreePath(root, worktreeParent, runId),
      });
      writeManifest(stateRoot, manifest);
    }
    if (!['sealed', 'promoting'].includes(manifest.state)) {
      const resumeCommit = manifest.checkpointCommit ?? plan.baseCommit;
      assertCumulativeImportTree(root, {
        baseCommit: plan.baseCommit,
        checkpointCommit: resumeCommit,
        allowlist: importAllowlist(plan),
        recordedFiles: manifest.files,
      });
      const resumeState = manifest.state === 'paused' ? manifest.resumeState : manifest.state;
      try {
        recreateOwnedRunWorktree(root, worktreeParent, manifest, resumeCommit);
        (runtime.linkDependencies ?? linkDependencies)(root, manifest.worktreePath);
        assertFileHashes(manifest.worktreePath, manifest.files);
        if (manifest.sourceHealthBefore) {
          const health = fileSha256(path.join(manifest.worktreePath, 'data', 'source-health.json'));
          if (health !== manifest.sourceHealthBefore) throw new Error('recorded source-health checksum mismatch');
        }
      } catch (error) {
        pauseSetupFailure(root, stateRoot, manifest, worktreeParent, resumeState, error);
        throw error;
      }
      for (const [step, status] of Object.entries(manifest.steps)) {
        if (status.status === 'running' || status.status === 'failed') {
          manifest = updateStep(manifest, step, { status: 'pending', error: null });
        }
      }
      if (manifest.state === 'paused') manifest = transitionRun(manifest, manifest.resumeState);
      if (manifest.state === 'worktree_creating') manifest = transitionRun(manifest, 'worktree_ready');
      writeManifest(stateRoot, manifest);
    }
    return continueRun(root, stateRoot, manifest, plan, runtime, worktreeParent);
  } finally {
    release();
  }
}

export function abortImportRun(root, runId, {
  stateRoot = path.join(root, STATE_DIR_REL),
  worktreeParent = os.tmpdir(),
  runtime = {},
} = {}) {
  const release = acquireImportLock(stateRoot);
  try {
    const plan = readJsonFile(planPath(stateRoot, runId));
    validateBatchPlan(plan);
    let manifest = readManifest(stateRoot, runId, plan);
    if (manifest.worktreePath) assertExpectedWorktreePath(root, worktreeParent, manifest);
    assertRepositoryReady(root, { branch: plan.branch });
    const current = branchCommit(root, plan.branch);
    if (manifest.state === 'applied' || (manifest.sealedCommit && isAncestor(root, manifest.sealedCommit, current))) {
      if (manifest.state !== 'applied') manifest = recoverAppliedRun(root, stateRoot, manifest, plan, worktreeParent, runtime);
      else (runtime.validateAppliedBranch ?? validateAppliedBranch)(root, plan);
      try { removeOwnedRunWorktree(root, worktreeParent, manifest); } catch { /* cleanup can be retried */ }
      throw new Error('an applied import cannot be aborted');
    }
    if (manifest.state === 'aborted') {
      removeOwnedRunWorktree(root, worktreeParent, manifest);
      return { ...manifest, noOp: true };
    }
    removeOwnedRunWorktree(root, worktreeParent, manifest);
    manifest = transitionRun(manifest, 'aborted', { error: null });
    writeManifest(stateRoot, manifest);
    return manifest;
  } finally {
    release();
  }
}

export function importRunStatus(root, runId, { stateRoot = path.join(root, STATE_DIR_REL) } = {}) {
  const plan = readJsonFile(planPath(stateRoot, runId));
  validateBatchPlan(plan);
  return readManifest(stateRoot, runId, plan);
}

export function planFingerprint(plan) {
  validateBatchPlan(plan);
  return sha256(JSON.stringify({ batchId: plan.batchId, batchDigest: plan.batchDigest }));
}
