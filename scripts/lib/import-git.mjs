import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertFileHashes, hashFiles, normalizeRepoPath, sha256 } from './import-run.mjs';

const BOT_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'gamepricemap-importer',
  GIT_AUTHOR_EMAIL: 'importer@gamepricemap.invalid',
  GIT_COMMITTER_NAME: 'gamepricemap-importer',
  GIT_COMMITTER_EMAIL: 'importer@gamepricemap.invalid',
});

export function git(cwd, args, { input = undefined, env = {}, trim = true } = {}) {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...BOT_ENV, ...env },
    });
    return trim ? output.trim() : output;
  } catch (error) {
    const stderr = String(error.stderr ?? '').trim();
    const stdout = String(error.stdout ?? '').trim();
    const detail = stderr || stdout || error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`, { cause: error });
  }
}

export function repositoryRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

export function headCommit(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

export function currentBranch(cwd) {
  return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

export function branchCommit(cwd, branch) {
  return git(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]);
}

export function isAncestor(cwd, ancestor, descendant) {
  try {
    git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export function worktreeChanges(cwd) {
  const output = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], { trim: false });
  if (!output) return [];
  const parts = output.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    paths.push(normalizeRepoPath(entry.slice(3)));
    if (code.includes('R') || code.includes('C')) {
      i += 1;
      if (parts[i]) paths.push(normalizeRepoPath(parts[i]));
    }
  }
  return [...new Set(paths)].sort();
}

function gitPathExists(cwd, name) {
  const gitPath = git(cwd, ['rev-parse', '--git-path', name]);
  return fs.existsSync(path.isAbsolute(gitPath) ? gitPath : path.join(cwd, gitPath));
}

export function assertRepositoryReady(cwd, { branch, baseCommit = null, allowDirty = false } = {}) {
  const root = repositoryRoot(cwd);
  if (fs.realpathSync(root) !== fs.realpathSync(cwd)) throw new Error(`run from repository root: ${root}`);
  const actualBranch = currentBranch(cwd);
  if (branch && actualBranch !== branch) throw new Error(`expected branch ${branch}, found ${actualBranch}`);
  const actualHead = headCommit(cwd);
  if (baseCommit && actualHead !== baseCommit) throw new Error(`stale base: expected ${baseCommit}, found ${actualHead}`);
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (gitPathExists(cwd, operation)) throw new Error(`git operation in progress: ${operation}`);
  }
  const changes = worktreeChanges(cwd);
  if (!allowDirty && changes.length > 0) throw new Error(`working tree is not clean: ${changes.join(', ')}`);
  return { root, branch: actualBranch, head: actualHead, changes };
}

export function addDetachedWorktree(root, worktreePath, commit) {
  if (fs.existsSync(worktreePath)) throw new Error(`worktree path already exists: ${worktreePath}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(root, ['worktree', 'add', '--detach', worktreePath, commit]);
  if (headCommit(worktreePath) !== commit) throw new Error('detached worktree started at the wrong commit');
  return worktreePath;
}

export function removeWorktree(root, worktreePath, { force = false } = {}) {
  if (!fs.existsSync(worktreePath)) {
    git(root, ['worktree', 'prune']);
    return false;
  }
  git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]);
  return true;
}

export function registeredWorktrees(root) {
  const output = git(root, ['worktree', 'list', '--porcelain'], { trim: false });
  return output.split(/\n\n+/).map((block) => {
    const fields = Object.fromEntries(block.split('\n').filter(Boolean).map((line) => {
      const space = line.indexOf(' ');
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    }));
    return fields.worktree ? fields : null;
  }).filter(Boolean);
}

export function isRegisteredWorktree(root, worktreePath) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    let cursor = resolved;
    const suffix = [];
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
    return path.join(fs.realpathSync(cursor), ...suffix);
  };
  const wanted = canonical(worktreePath);
  return registeredWorktrees(root).some((entry) => canonical(entry.worktree) === wanted);
}

export function recreateDetachedWorktree(root, worktreePath, checkpointCommit) {
  if (fs.existsSync(worktreePath)) removeWorktree(root, worktreePath, { force: true });
  return addDetachedWorktree(root, worktreePath, checkpointCommit);
}

export function pathAllowed(relativePath, allowlist) {
  const safe = normalizeRepoPath(relativePath);
  return allowlist.some((rule) => {
    const normalizedRule = normalizeRepoPath(rule.replace(/\/$/, ''));
    return rule.endsWith('/') ? safe.startsWith(`${normalizedRule}/`) : safe === normalizedRule;
  });
}

export function assertAllowedChanges(cwd, allowlist) {
  const changed = worktreeChanges(cwd);
  const forbidden = changed.filter((file) => !pathAllowed(file, allowlist));
  if (forbidden.length > 0) throw new Error(`unexpected staging changes: ${forbidden.join(', ')}`);
  return changed;
}

export function checkpointWorktree(cwd, { step, allowlist, message = `import checkpoint: ${step}` }) {
  const changed = assertAllowedChanges(cwd, allowlist);
  git(cwd, ['add', '--all']);
  const staged = git(cwd, ['diff', '--cached', '--name-only', '-z'], { trim: false }).split('\0').filter(Boolean).map(normalizeRepoPath).sort();
  const forbidden = staged.filter((file) => !pathAllowed(file, allowlist));
  if (forbidden.length > 0) throw new Error(`unexpected staged changes: ${forbidden.join(', ')}`);
  git(cwd, ['commit', '--allow-empty', '--no-gpg-sign', '-m', message]);
  const commit = headCommit(cwd);
  const tree = git(cwd, ['rev-parse', `${commit}^{tree}`]);
  return { commit, tree, changed, files: hashFiles(cwd, staged) };
}

function commitBlob(cwd, commit, relativePath) {
  try {
    return git(cwd, ['rev-parse', `${commit}:${normalizeRepoPath(relativePath)}`]);
  } catch {
    return null;
  }
}

function treeMode(cwd, commit, relativePath) {
  const output = git(cwd, ['ls-tree', '-z', commit, '--', normalizeRepoPath(relativePath)], { trim: false });
  if (!output) return null;
  const header = output.slice(0, output.indexOf('\t'));
  return header.split(/\s+/)[0] ?? null;
}

export function assertCumulativeImportTree(cwd, {
  baseCommit,
  checkpointCommit = headCommit(cwd),
  allowlist,
  recordedFiles,
  sourceHealthPath = 'data/source-health.json',
}) {
  if (!isAncestor(cwd, baseCommit, checkpointCommit)) {
    throw new Error('checkpoint is not descended from the recorded base');
  }
  const changed = git(cwd, ['diff', '--name-only', '-z', baseCommit, checkpointCommit], { trim: false })
    .split('\0').filter(Boolean).map(normalizeRepoPath).sort();
  const forbidden = changed.filter((file) => !pathAllowed(file, allowlist));
  if (forbidden.length > 0) throw new Error(`unexpected cumulative import changes: ${forbidden.join(', ')}`);
  const unrecorded = changed.filter((file) => !Object.hasOwn(recordedFiles ?? {}, file));
  if (unrecorded.length > 0) throw new Error(`cumulative import changes lack recorded checksums: ${unrecorded.join(', ')}`);
  for (const file of changed) {
    const mode = treeMode(cwd, checkpointCommit, file);
    if (!mode) throw new Error(`cumulative import deleted an allowed file: ${file}`);
    if (!['100644', '100755'].includes(mode)) throw new Error(`cumulative import contains non-regular mode ${mode}: ${file}`);
    const digest = sha256(git(cwd, ['show', `${checkpointCommit}:${file}`], { trim: false }));
    if (recordedFiles[file] !== digest) throw new Error(`cumulative import checksum mismatch: ${file}`);
  }
  const beforeHealth = commitBlob(cwd, baseCommit, sourceHealthPath);
  const afterHealth = commitBlob(cwd, checkpointCommit, sourceHealthPath);
  if (!beforeHealth || beforeHealth !== afterHealth) {
    throw new Error(`${sourceHealthPath} differs between base and final import tree`);
  }
  return { checkpointCommit, changed };
}

export function sealWorktree(cwd, { baseCommit, message, allowlist, recordedFiles }) {
  const changes = worktreeChanges(cwd);
  if (changes.length > 0) throw new Error(`cannot seal dirty worktree: ${changes.join(', ')}`);
  assertFileHashes(cwd, recordedFiles ?? {});
  const checkpointCommit = headCommit(cwd);
  const audit = assertCumulativeImportTree(cwd, { baseCommit, checkpointCommit, allowlist, recordedFiles });
  const tree = git(cwd, ['rev-parse', `${checkpointCommit}^{tree}`]);
  const sealedCommit = git(cwd, ['commit-tree', tree, '-p', baseCommit, '-m', message]);
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sealedCommit]).split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== baseCommit) throw new Error('sealed commit has an unexpected parent');
  return { sealedCommit, checkpointCommit, tree, changed: audit.changed };
}

export function promoteFastForward(root, { branch, baseCommit, sealedCommit }) {
  assertRepositoryReady(root, { branch });
  const currentHead = headCommit(root);
  if (currentHead === sealedCommit) return { applied: false, noOp: true, head: currentHead };
  if (isAncestor(root, sealedCommit, currentHead)) {
    return { applied: false, noOp: true, head: currentHead };
  }
  if (currentHead !== baseCommit) throw new Error(`stale base: expected ${baseCommit}, found ${currentHead}`);
  const parents = git(root, ['rev-list', '--parents', '-n', '1', sealedCommit]).split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== baseCommit) throw new Error('sealed commit is not a one-commit fast-forward from the recorded base');
  git(root, ['merge', '--ff-only', sealedCommit]);
  const head = headCommit(root);
  if (head !== sealedCommit) throw new Error('fast-forward promotion did not land the sealed commit');
  return { applied: true, noOp: false, head };
}
