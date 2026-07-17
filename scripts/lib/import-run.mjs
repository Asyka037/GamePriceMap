import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const IMPORT_SCHEMA_VERSION = 1;
export const IMPORT_STEPS = Object.freeze([
  'catalog',
  'steam',
  'eshop',
  'meta',
  'history',
  'test',
  'validate',
  'build',
  'seal',
  'promote',
]);

const MAIN_STATES = Object.freeze([
  'planned',
  'worktree_creating',
  'worktree_ready',
  'catalog_staged',
  'steam_done',
  'eshop_done',
  'meta_done',
  'history_done',
  'gates_passed',
  'sealed',
  'promoting',
  'applied',
]);

const TERMINAL_STATES = new Set(['applied', 'aborted']);
const SIDE_STATES = new Set(['paused', 'failed', 'stale_base', 'aborted']);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

export function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

export function normalizeRepoPath(value) {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\\')) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  const normalized = value;
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`unsafe repository path: ${value}`);
  }
  return normalized;
}

export function hashFiles(root, relativePaths) {
  const out = {};
  const realRoot = fs.realpathSync(root);
  for (const rel of [...new Set(relativePaths)].sort()) {
    const safe = normalizeRepoPath(rel);
    const absolute = path.join(root, safe);
    if (!fs.existsSync(absolute)) {
      out[safe] = null;
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error(`repository artifact must be a regular file: ${safe}`);
    const real = fs.realpathSync(absolute);
    if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`repository artifact escapes worktree: ${safe}`);
    }
    out[safe] = fileSha256(absolute);
  }
  return out;
}

export function assertFileHashes(root, expected) {
  const actual = hashFiles(root, Object.keys(expected));
  const mismatches = Object.keys(expected).filter((rel) => actual[rel] !== expected[rel]);
  if (mismatches.length > 0) {
    throw new Error(`file checksum mismatch: ${mismatches.join(', ')}`);
  }
  return actual;
}

function validIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? '')
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function validIsoInstant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validDigest(value) {
  return /^sha256:[a-f0-9]{64}$/.test(value ?? '');
}

function validateItem(item, index) {
  const label = `batch item ${index + 1}`;
  if (!plainObject(item)) throw new Error(`${label}: must be an object`);
  if (!/^(?:steam:[1-9]\d*|ns:7001\d{10})$/.test(item.key ?? '')) throw new Error(`${label}: bad key`);
  if (!['new_game', 'add_platform_mapping'].includes(item.catalogAction)) throw new Error(`${label}: bad catalogAction`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug ?? '')) throw new Error(`${label}: bad slug`);
  if (!(typeof item.title === 'string' && item.title.trim())) throw new Error(`${label}: missing title`);
  if (!Array.isArray(item.platforms) || item.platforms.length === 0 || item.platforms.some((p) => !(typeof p === 'string' && p))) {
    throw new Error(`${label}: bad platforms`);
  }
  if (item.steamAppId != null && !(Number.isInteger(item.steamAppId) && item.steamAppId > 0)) {
    throw new Error(`${label}: bad steamAppId`);
  }
  if (item.nsuids != null) {
    if (!plainObject(item.nsuids)) throw new Error(`${label}: bad nsuids`);
    for (const [group, id] of Object.entries(item.nsuids)) {
      if (!['americas', 'europe', 'japan'].includes(group)) throw new Error(`${label}: unknown NSUID group ${group}`);
      if (id != null && !/^7001\d{10}$/.test(String(id))) throw new Error(`${label}: bad ${group} NSUID`);
    }
  }
  if (item.nintendoUsSlug != null && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.nintendoUsSlug)) {
    throw new Error(`${label}: bad nintendoUsSlug`);
  }
  const hasNsuid = item.nsuids && Object.values(item.nsuids).some(Boolean);
  if (!Number.isInteger(item.steamAppId) && !hasNsuid) throw new Error(`${label}: no platform product ID`);
  const [keyType, keyValue] = item.key.split(':', 2);
  if (keyType === 'steam' && String(item.steamAppId ?? '') !== keyValue) {
    throw new Error(`${label}: key does not match steamAppId`);
  }
  if (keyType === 'ns' && !Object.values(item.nsuids ?? {}).filter(Boolean).map(String).includes(keyValue)) {
    throw new Error(`${label}: key does not match any NSUID`);
  }
  if (hasNsuid) {
    const generations = item.platforms.filter((platform) => platform === 'switch' || platform === 'switch-2');
    if (generations.length !== 1) throw new Error(`${label}: Nintendo mapping requires exactly one platform generation`);
  }
  if (item.nsuids?.americas && !item.nintendoUsSlug) throw new Error(`${label}: Americas NSUID requires nintendoUsSlug`);
  if (!validDigest(item.evidenceDigest)) throw new Error(`${label}: bad evidenceDigest`);
  if (!validDigest(item.humanDecisionDigest)) throw new Error(`${label}: bad humanDecisionDigest`);
  if (!validIsoInstant(item.verifiedAt)) throw new Error(`${label}: bad verifiedAt`);
}

export function validateBatchPlan(plan, { requireDigest = true } = {}) {
  if (!plainObject(plan)) throw new Error('batch plan must be an object');
  if (plan.schemaVersion !== IMPORT_SCHEMA_VERSION) throw new Error(`unsupported batch schema ${plan.schemaVersion}`);
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(plan.batchId ?? '')) throw new Error('bad batchId');
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(plan.baseCommit ?? '')) throw new Error('bad baseCommit');
  if (!(typeof plan.branch === 'string' && plan.branch.trim())) throw new Error('missing branch');
  if (!validIsoDate(plan.addedAt)) throw new Error('bad addedAt');
  if (!Array.isArray(plan.items) || plan.items.length === 0 || plan.items.length > 100) {
    throw new Error('batch items must contain 1..100 entries');
  }
  plan.items.forEach(validateItem);

  for (const [label, values] of [
    ['key', plan.items.map((item) => item.key)],
    ['slug', plan.items.map((item) => item.slug)],
    ['steamAppId', plan.items.map((item) => item.steamAppId).filter(Number.isInteger)],
    ['NSUID', plan.items.flatMap((item) => Object.values(item.nsuids ?? {}).filter(Boolean).map(String))],
  ]) {
    if (new Set(values).size !== values.length) throw new Error(`duplicate batch ${label}`);
  }

  if (requireDigest) {
    if (!validDigest(plan.batchDigest)) throw new Error('bad batchDigest');
    const { batchDigest: _ignored, ...unsigned } = plan;
    if (sha256(canonicalJson(unsigned)) !== plan.batchDigest) throw new Error('batchDigest does not match plan');
  }
  return plan;
}

export function createBatchPlan(input) {
  const unsigned = canonicalize({ schemaVersion: IMPORT_SCHEMA_VERSION, ...input });
  validateBatchPlan(unsigned, { requireDigest: false });
  const plan = { ...unsigned, batchDigest: sha256(canonicalJson(unsigned)) };
  validateBatchPlan(plan);
  return plan;
}

export function createRunManifest(plan, { runId, createdAt = new Date().toISOString() } = {}) {
  validateBatchPlan(plan);
  if (!/^[a-z0-9][a-z0-9-]{5,95}$/.test(runId ?? '')) throw new Error('bad runId');
  if (!validIsoInstant(createdAt)) throw new Error('bad createdAt');
  return {
    schemaVersion: IMPORT_SCHEMA_VERSION,
    runId,
    batchId: plan.batchId,
    batchDigest: plan.batchDigest,
    baseCommit: plan.baseCommit,
    branch: plan.branch,
    state: 'planned',
    resumeState: null,
    createdAt,
    updatedAt: createdAt,
    worktreePath: null,
    checkpointCommit: null,
    sealedCommit: null,
    files: {},
    steps: Object.fromEntries(IMPORT_STEPS.map((step) => [step, { status: 'pending', attempts: 0 }])),
    error: null,
  };
}

const RUN_STATES = new Set([...MAIN_STATES, ...SIDE_STATES]);
const STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed']);

/** Validate the ignored mutable journal before it can influence Git or paths. */
export function validateRunManifest(manifest, plan, { runId = manifest?.runId } = {}) {
  validateBatchPlan(plan);
  if (!plainObject(manifest)) throw new Error('run manifest must be an object');
  if (manifest.schemaVersion !== IMPORT_SCHEMA_VERSION) throw new Error(`unsupported run schema ${manifest.schemaVersion}`);
  if (!/^[a-z0-9][a-z0-9-]{5,95}$/.test(runId ?? '') || manifest.runId !== runId) throw new Error('run manifest runId mismatch');
  for (const field of ['batchId', 'batchDigest', 'baseCommit', 'branch']) {
    if (manifest[field] !== plan[field]) throw new Error(`run manifest/plan ${field} mismatch`);
  }
  if (!RUN_STATES.has(manifest.state)) throw new Error(`unknown run state ${manifest.state}`);
  if (manifest.resumeState !== null && !RUN_STATES.has(manifest.resumeState)) throw new Error(`unknown resume state ${manifest.resumeState}`);
  const resumeSideState = ['paused', 'failed', 'stale_base'].includes(manifest.state);
  if (resumeSideState !== (manifest.resumeState !== null)) throw new Error(`run manifest has invalid resumeState for ${manifest.state}`);
  if (!validIsoInstant(manifest.createdAt) || !validIsoInstant(manifest.updatedAt)) throw new Error('run manifest has invalid timestamps');
  if (manifest.worktreePath !== null && !(typeof manifest.worktreePath === 'string' && path.isAbsolute(manifest.worktreePath))) {
    throw new Error('run manifest has invalid worktreePath');
  }
  for (const field of ['checkpointCommit', 'sealedCommit']) {
    if (manifest[field] !== null && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(manifest[field] ?? '')) {
      throw new Error(`run manifest has invalid ${field}`);
    }
  }
  if (manifest.sealedTree != null && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(manifest.sealedTree)) {
    throw new Error('run manifest has invalid sealedTree');
  }
  const mainIndex = MAIN_STATES.indexOf(manifest.state);
  if (mainIndex >= MAIN_STATES.indexOf('worktree_creating') && manifest.worktreePath === null) {
    throw new Error(`run manifest state ${manifest.state} requires a worktreePath`);
  }
  if (mainIndex >= MAIN_STATES.indexOf('catalog_staged') && manifest.checkpointCommit === null) {
    throw new Error(`run manifest state ${manifest.state} requires a checkpointCommit`);
  }
  if (['sealed', 'promoting', 'applied'].includes(manifest.state) && (!manifest.sealedCommit || !manifest.sealedTree)) {
    throw new Error(`run manifest state ${manifest.state} requires a sealed commit and tree`);
  }
  if (!plainObject(manifest.steps) || Object.keys(manifest.steps).sort().join() !== [...IMPORT_STEPS].sort().join()) {
    throw new Error('run manifest has an invalid step set');
  }
  for (const [step, entry] of Object.entries(manifest.steps)) {
    if (!plainObject(entry) || !STEP_STATUSES.has(entry.status) || !(Number.isInteger(entry.attempts) && entry.attempts >= 0)) {
      throw new Error(`run manifest has an invalid ${step} step`);
    }
    if (entry.checkpointCommit != null && !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(entry.checkpointCommit)) {
      throw new Error(`run manifest has an invalid ${step} checkpoint`);
    }
    if (entry.files != null) {
      if (!plainObject(entry.files)) throw new Error(`run manifest has invalid ${step} files`);
      for (const [rel, digest] of Object.entries(entry.files)) {
        normalizeRepoPath(rel);
        if (digest !== null && !validDigest(digest)) throw new Error(`run manifest has invalid ${step} checksum for ${rel}`);
      }
    }
  }
  if (!plainObject(manifest.files)) throw new Error('run manifest files must be an object');
  for (const [rel, digest] of Object.entries(manifest.files)) {
    normalizeRepoPath(rel);
    if (digest !== null && !validDigest(digest)) throw new Error(`run manifest has invalid checksum for ${rel}`);
  }
  if (manifest.sourceHealthBefore != null && !validDigest(manifest.sourceHealthBefore)) {
    throw new Error('run manifest has invalid sourceHealthBefore');
  }
  return manifest;
}

export function transitionRun(manifest, nextState, patch = {}, now = new Date().toISOString()) {
  if (!MAIN_STATES.includes(manifest.state) && !SIDE_STATES.has(manifest.state)) throw new Error(`unknown run state ${manifest.state}`);
  if (!MAIN_STATES.includes(nextState) && !SIDE_STATES.has(nextState)) throw new Error(`unknown next state ${nextState}`);
  if (TERMINAL_STATES.has(manifest.state) && manifest.state !== nextState) throw new Error(`run is terminal: ${manifest.state}`);

  const currentIndex = MAIN_STATES.indexOf(manifest.state);
  const nextIndex = MAIN_STATES.indexOf(nextState);
  const isForwardOne = currentIndex >= 0 && nextIndex === currentIndex + 1;
  const isRecovery = ['paused', 'failed', 'stale_base'].includes(manifest.state)
    && nextState === manifest.resumeState;
  const isSideTransition = SIDE_STATES.has(nextState) && !TERMINAL_STATES.has(manifest.state);
  const isSame = manifest.state === nextState;
  if (!isForwardOne && !isRecovery && !isSideTransition && !isSame) {
    throw new Error(`illegal run transition ${manifest.state} -> ${nextState}`);
  }

  const resumeState = SIDE_STATES.has(nextState) && !TERMINAL_STATES.has(nextState)
    ? (patch.resumeState ?? manifest.state)
    : null;
  return { ...manifest, ...patch, state: nextState, resumeState, updatedAt: now };
}

export function updateStep(manifest, step, patch, now = new Date().toISOString()) {
  if (!IMPORT_STEPS.includes(step)) throw new Error(`unknown import step ${step}`);
  const previous = manifest.steps[step];
  return {
    ...manifest,
    updatedAt: now,
    steps: {
      ...manifest.steps,
      [step]: { ...previous, ...patch },
    },
  };
}

export function atomicWriteJson(file, value) {
  atomicWriteText(file, canonicalJson(value));
}

export function atomicWriteText(file, bytes, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const handle = fs.openSync(temp, 'wx', mode);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}

export function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
