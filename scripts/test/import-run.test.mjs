import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  atomicWriteJson,
  canonicalJson,
  createBatchPlan,
  createRunManifest,
  fileSha256,
  hashFiles,
  normalizeRepoPath,
  sha256,
  transitionRun,
  updateStep,
  validateBatchPlan,
  validateRunManifest,
} from '../lib/import-run.mjs';

function item(overrides = {}) {
  return {
    key: 'steam:123456',
    catalogAction: 'new_game',
    slug: 'example-game',
    title: 'Example Game',
    steamAppId: 123456,
    nsuids: null,
    platforms: ['pc'],
    evidenceDigest: sha256('evidence'),
    verifiedAt: '2026-07-17T00:00:00.000Z',
    humanDecisionDigest: sha256('approved'),
    ...overrides,
  };
}

function planInput(overrides = {}) {
  return {
    batchId: 'steam-0001',
    baseCommit: 'a'.repeat(40),
    branch: 'main',
    addedAt: '2026-07-17',
    items: [item()],
    ...overrides,
  };
}

test('canonical JSON and plan digests ignore object key insertion order but preserve arrays', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  const plan = createBatchPlan(planInput());
  assert.match(plan.batchDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateBatchPlan(plan), plan);
  assert.throws(() => validateBatchPlan({ ...plan, addedAt: '2026-07-18' }), /batchDigest/);
});

test('batch plan rejects unsafe IDs, duplicates, missing evidence and batches over 100', () => {
  assert.throws(() => createBatchPlan(planInput({ items: [item({ slug: '../escape' })] })), /bad slug/);
  assert.throws(() => createBatchPlan(planInput({ items: [item(), item()] })), /duplicate batch key/);
  assert.throws(() => createBatchPlan(planInput({ items: [item({ evidenceDigest: 'nope' })] })), /evidenceDigest/);
  assert.throws(() => createBatchPlan(planInput({ items: Array.from({ length: 101 }, (_, i) => item({ key: `steam:${i + 1}`, slug: `game-${i + 1}`, steamAppId: i + 1 })) })), /1\.\.100/);
  assert.throws(() => createBatchPlan(planInput({ items: [item({ key: 'steam:999' })] })), /key does not match steamAppId/);
  assert.throws(() => createBatchPlan(planInput({ items: [item({
    key: 'ns:70010000000001',
    steamAppId: null,
    nsuids: { americas: '70010000000001' },
    platforms: ['switch'],
  })] })), /requires nintendoUsSlug/);
});

test('run manifests are bound to the reviewed plan and reject unsafe journal data', () => {
  const plan = createBatchPlan(planInput());
  const manifest = createRunManifest(plan, { runId: 'steam-0001-run-safe' });
  assert.equal(validateRunManifest(manifest, plan), manifest);
  assert.throws(() => validateRunManifest({ ...manifest, batchDigest: sha256('forged') }, plan), /batchDigest mismatch/);
  assert.throws(() => validateRunManifest({
    ...manifest,
    files: { '..\\victim': sha256('forged') },
  }, plan), /unsafe repository path/);
});

test('run state advances one step, can pause/resume, and terminal states cannot move', () => {
  const manifest = createRunManifest(createBatchPlan(planInput()), { runId: 'steam-0001-run-1', createdAt: '2026-07-17T00:00:00Z' });
  const creating = transitionRun(manifest, 'worktree_creating', { worktreePath: '/tmp/import-run' }, '2026-07-17T00:00:30Z');
  const ready = transitionRun(creating, 'worktree_ready', {}, '2026-07-17T00:01:00Z');
  const paused = transitionRun(ready, 'paused', { error: { message: 'network' } }, '2026-07-17T00:02:00Z');
  assert.equal(paused.resumeState, 'worktree_ready');
  assert.equal(transitionRun(paused, 'worktree_ready').state, 'worktree_ready');
  assert.throws(() => transitionRun(ready, 'steam_done'), /illegal run transition/);
  const aborted = transitionRun(ready, 'aborted');
  assert.throws(() => transitionRun(aborted, 'worktree_ready'), /terminal/);
  const stepped = updateStep(ready, 'catalog', { status: 'running', attempts: 1 });
  assert.deepEqual(stepped.steps.catalog, { status: 'running', attempts: 1 });
});

test('atomic JSON writes canonical bytes and file hashing detects mutations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-run-'));
  const file = path.join(dir, 'state', 'manifest.json');
  atomicWriteJson(file, { z: 1, a: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2,"z":1}\n');
  const before = fileSha256(file);
  assert.deepEqual(hashFiles(dir, ['state/manifest.json']), { 'state/manifest.json': before });
  fs.appendFileSync(file, 'changed');
  assert.notEqual(fileSha256(file), before);
  assert.throws(() => normalizeRepoPath('../outside'), /unsafe/);
  assert.throws(() => normalizeRepoPath('/absolute'), /unsafe/);
  assert.throws(() => normalizeRepoPath('data\\catalog.json'), /unsafe/);
  fs.symlinkSync('manifest.json', path.join(dir, 'state', 'linked.json'));
  assert.throws(() => hashFiles(dir, ['state/linked.json']), /regular file/);
});
