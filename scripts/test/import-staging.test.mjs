import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addDetachedWorktree,
  assertAllowedChanges,
  assertRepositoryReady,
  checkpointWorktree,
  git,
  headCommit,
  pathAllowed,
  promoteFastForward,
  recreateDetachedWorktree,
  removeWorktree,
  sealWorktree,
} from '../lib/import-git.mjs';

function initRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-git-'));
  git(root, ['init', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'catalog.json'), '{"games":[]}\n');
  fs.writeFileSync(path.join(root, 'data', 'source-health.json'), '{"sources":{}}\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--no-gpg-sign', '-m', 'base']);
  return root;
}

test('staging checkpoints keep main unchanged, seal to one commit, then fast-forward exactly once', () => {
  const root = initRepo();
  const base = headCommit(root);
  const worktree = `${root}-worktree`;
  addDetachedWorktree(root, worktree, base);
  fs.mkdirSync(path.join(worktree, 'data', 'meta'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'data', 'meta', 'example.json'), '{"slug":"example"}\n');
  const checkpoint = checkpointWorktree(worktree, { step: 'meta', allowlist: ['data/meta/'] });
  assert.equal(headCommit(root), base, 'formal worktree must not move during staging');
  assert.equal(checkpoint.files['data/meta/example.json'].startsWith('sha256:'), true);

  const sealed = sealWorktree(worktree, {
    baseCommit: base,
    message: 'feat(data): import test batch',
    allowlist: ['data/meta/example.json'],
    recordedFiles: checkpoint.files,
  });
  assert.notEqual(sealed.sealedCommit, checkpoint.commit, 'checkpoint history is squashed');
  assert.equal(headCommit(root), base);
  const promoted = promoteFastForward(root, { branch: 'main', baseCommit: base, sealedCommit: sealed.sealedCommit });
  assert.equal(promoted.applied, true);
  assert.equal(fs.readFileSync(path.join(root, 'data', 'meta', 'example.json'), 'utf8'), '{"slug":"example"}\n');
  assert.deepEqual(promoteFastForward(root, { branch: 'main', baseCommit: base, sealedCommit: sealed.sealedCommit }), {
    applied: false,
    noOp: true,
    head: sealed.sealedCommit,
  });
  removeWorktree(root, worktree, { force: true });
});

test('resume recreates a clean detached worktree from the recorded checkpoint', () => {
  const root = initRepo();
  const base = headCommit(root);
  const worktree = `${root}-resume`;
  addDetachedWorktree(root, worktree, base);
  fs.writeFileSync(path.join(worktree, 'data', 'catalog.json'), '{"games":[{"slug":"one"}]}\n');
  const checkpoint = checkpointWorktree(worktree, { step: 'catalog', allowlist: ['data/catalog.json'] });
  fs.writeFileSync(path.join(worktree, 'README.md'), 'interrupted dirt\n');
  recreateDetachedWorktree(root, worktree, checkpoint.commit);
  assert.equal(headCommit(worktree), checkpoint.commit);
  assert.deepEqual(assertAllowedChanges(worktree, ['data/']), []);
  assert.match(fs.readFileSync(path.join(worktree, 'data', 'catalog.json'), 'utf8'), /"one"/);
  removeWorktree(root, worktree, { force: true });
});

test('unexpected files and a moved main branch block staging promotion', () => {
  const root = initRepo();
  const base = headCommit(root);
  const worktree = `${root}-stale`;
  addDetachedWorktree(root, worktree, base);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'not allowed\n');
  assert.throws(() => assertAllowedChanges(worktree, ['data/']), /unexpected staging changes/);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'base\n');
  fs.writeFileSync(path.join(worktree, 'data', 'catalog.json'), '{"games":[{"slug":"two"}]}\n');
  const checkpoint = checkpointWorktree(worktree, { step: 'catalog', allowlist: ['data/catalog.json'] });
  const sealed = sealWorktree(worktree, {
    baseCommit: base,
    message: 'batch',
    allowlist: ['data/catalog.json'],
    recordedFiles: checkpoint.files,
  });

  fs.writeFileSync(path.join(root, 'README.md'), 'concurrent commit\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--no-gpg-sign', '-m', 'concurrent']);
  assert.throws(
    () => promoteFastForward(root, { branch: 'main', baseCommit: base, sealedCommit: sealed.sealedCommit }),
    /stale base/,
  );
  assertRepositoryReady(root, { branch: 'main' });
  removeWorktree(root, worktree, { force: true });
});

test('final seal audits the full base-to-checkpoint tree, not only the last step', () => {
  const root = initRepo();
  const base = headCommit(root);
  const worktree = `${root}-cumulative-attack`;
  addDetachedWorktree(root, worktree, base);

  fs.writeFileSync(path.join(worktree, 'README.md'), 'smuggled committed change\n');
  const smuggled = checkpointWorktree(worktree, { step: 'bad-step', allowlist: ['README.md'] });
  fs.writeFileSync(path.join(worktree, 'data', 'catalog.json'), '{"games":[{"slug":"safe"}]}\n');
  const expected = checkpointWorktree(worktree, { step: 'catalog', allowlist: ['data/catalog.json'] });
  assert.throws(() => sealWorktree(worktree, {
    baseCommit: base,
    message: 'must not seal',
    allowlist: ['data/catalog.json'],
    recordedFiles: { ...smuggled.files, ...expected.files },
  }), /unexpected cumulative import changes: README\.md/);
  removeWorktree(root, worktree, { force: true });
});

test('final seal verifies recorded hashes, source-health immutability, and regular file modes', () => {
  const root = initRepo();
  const base = headCommit(root);

  const healthWorktree = `${root}-health-attack`;
  addDetachedWorktree(root, healthWorktree, base);
  fs.writeFileSync(path.join(healthWorktree, 'data', 'source-health.json'), '{"sources":{"forged":true}}\n');
  const healthCheckpoint = checkpointWorktree(healthWorktree, { step: 'bad-health', allowlist: ['data/source-health.json'] });
  assert.throws(() => sealWorktree(healthWorktree, {
    baseCommit: base,
    message: 'must not seal health',
    allowlist: ['data/source-health.json'],
    recordedFiles: healthCheckpoint.files,
  }), /source-health\.json differs/);
  removeWorktree(root, healthWorktree, { force: true });

  const hashWorktree = `${root}-hash-attack`;
  addDetachedWorktree(root, hashWorktree, base);
  fs.writeFileSync(path.join(hashWorktree, 'data', 'catalog.json'), '{"games":[{"slug":"changed"}]}\n');
  const hashCheckpoint = checkpointWorktree(hashWorktree, { step: 'catalog', allowlist: ['data/catalog.json'] });
  assert.throws(() => sealWorktree(hashWorktree, {
    baseCommit: base,
    message: 'must not seal hash mismatch',
    allowlist: ['data/catalog.json'],
    recordedFiles: { 'data/catalog.json': `sha256:${'0'.repeat(64)}` },
  }), /file checksum mismatch/);
  removeWorktree(root, hashWorktree, { force: true });

  const symlinkWorktree = `${root}-symlink-attack`;
  addDetachedWorktree(root, symlinkWorktree, base);
  fs.mkdirSync(path.join(symlinkWorktree, 'data', 'meta'), { recursive: true });
  fs.symlinkSync('../../README.md', path.join(symlinkWorktree, 'data', 'meta', 'link.json'));
  assert.throws(() => checkpointWorktree(symlinkWorktree, {
    step: 'meta',
    allowlist: ['data/meta/link.json'],
  }), /regular file/);
  removeWorktree(root, symlinkWorktree, { force: true });

  assert.throws(() => pathAllowed('data\\catalog.json', ['data/catalog.json']), /unsafe repository path/);
});
