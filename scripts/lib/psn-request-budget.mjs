/**
 * Persistent safety envelope for PlayStation Store US page requests, including
 * both official search result pages and exact product pages.
 *
 * Manual discovery writes one tracked reservation before each physical
 * request. Scheduled jobs instead reserve the full UTC-day allowance before
 * any storefront I/O, commit that tracked reservation, then consume a private
 * runner-local lease one physical attempt at a time. Both paths serialize
 * request starts at >= 1.5 seconds and count failed/crashed attempts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchTextViaCurl, sleep } from './http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PSN_US_PAGE_DAILY_LIMIT = 60;
export const PSN_US_PAGE_MIN_INTERVAL_MS = 1500;
export const PSN_US_BUDGET_SCHEMA_VERSION = 1;
export const PSN_US_RUN_LEASE_SCHEMA_VERSION = 1;
export const PSN_US_RUN_LEASE_ENV = 'PSN_US_RUN_LEASE_PATH';
export const PSN_US_RUN_LEASE_OWNER_ENV = 'PSN_US_RUN_LEASE_OWNER';
export const PSN_US_RUN_LEASE_PURPOSE_ENV = 'PSN_US_RUN_LEASE_PURPOSE';
export const PSN_US_BUDGET_PATH = path.join(ROOT, 'data', 'seeds', 'psn-us-request-budget.json');

/**
 * Resolve one private runtime ledger shared by the primary checkout and every
 * linked Git worktree. The tracked ledger above remains the auditable mirror;
 * it cannot provide a process lock because each worktree has its own copy.
 */
export function resolvePsnUsSharedBudgetPath(repoRoot = ROOT) {
  const dotGit = path.join(path.resolve(repoRoot), '.git');
  let gitDir;
  const stat = fs.lstatSync(dotGit);
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else if (stat.isFile()) {
    const match = fs.readFileSync(dotGit, 'utf8').trim().match(/^gitdir:\s*(.+)$/u);
    if (!match) throw new Error('PSN shared budget cannot resolve the worktree gitdir');
    gitDir = path.resolve(path.dirname(dotGit), match[1]);
  } else {
    throw new Error('PSN shared budget requires a Git checkout');
  }
  const commonDirFile = path.join(gitDir, 'commondir');
  const commonDir = fs.existsSync(commonDirFile)
    ? path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf8').trim())
    : gitDir;
  if (path.basename(commonDir) !== '.git' || !fs.statSync(commonDir).isDirectory()) {
    throw new Error('PSN shared budget resolved an unsafe Git common directory');
  }
  return path.join(path.dirname(commonDir), 'private', 'runtime', 'psn-us-request-budget.json');
}

export const PSN_US_SHARED_BUDGET_PATH = resolvePsnUsSharedBudgetPath();

const BUDGET_LOCK_STALE_MS = 5 * 60_000;
const RUN_LOCK_STALE_MS = 2 * 60 * 60_000;

export function createPsnUsBudgetLedger() {
  return { schemaVersion: PSN_US_BUDGET_SCHEMA_VERSION, days: {} };
}

function validatePsnUsBudgetLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error('PSN US budget ledger must be an object');
  }
  if (ledger.schemaVersion !== PSN_US_BUDGET_SCHEMA_VERSION) {
    throw new Error('PSN US budget ledger schema is unsupported');
  }
  if (!ledger.days || typeof ledger.days !== 'object' || Array.isArray(ledger.days)) {
    throw new Error('PSN US budget ledger days are invalid');
  }
  for (const [day, entry] of Object.entries(ledger.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)
      || !Number.isSafeInteger(entry?.pageRequests)
      || entry.pageRequests < 0
      || !Number.isFinite(Date.parse(entry?.lastRequestedAt ?? ''))) {
      throw new Error(`PSN US budget ledger entry is invalid: ${day}`);
    }
  }
  return ledger;
}

function exactIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function utcDay(value) {
  const current = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(current.valueOf())) throw new TypeError('PSN US budget time is invalid');
  return { current, day: current.toISOString().slice(0, 10) };
}

function budgetError(message, code = 'psn_us_daily_budget_exhausted') {
  const error = new Error(message);
  error.code = code;
  error.budget = true;
  return error;
}

function latestLedgerReservationMs(ledger) {
  return Math.max(
    Number.NEGATIVE_INFINITY,
    ...Object.values(ledger.days).map((entry) => Date.parse(entry.lastRequestedAt)),
  );
}

function prunedLedgerDays(ledger, nowMs) {
  const cutoff = nowMs - 31 * 86_400_000;
  return Object.fromEntries(Object.entries(ledger.days)
    .filter(([key]) => Date.parse(`${key}T00:00:00.000Z`) >= cutoff));
}

function validatePsnUsRunLease(lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    throw new Error('PSN US run lease must be an object');
  }
  const expectedKeys = ['consumed', 'createdAt', 'day', 'lastRequestedAt', 'leaseId', 'owner', 'purpose', 'reserved', 'schemaVersion'];
  if (Object.keys(lease).toSorted().join('\0') !== expectedKeys.join('\0')) {
    throw new Error('PSN US run lease fields are invalid');
  }
  if (lease.schemaVersion !== PSN_US_RUN_LEASE_SCHEMA_VERSION
    || typeof lease.leaseId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(lease.leaseId)
    || typeof lease.owner !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(lease.owner)
    || !['calendar', 'price'].includes(lease.purpose)
    || !/^\d{4}-\d{2}-\d{2}$/u.test(lease.day)
    || !exactIsoTimestamp(lease.createdAt)
    || lease.createdAt.slice(0, 10) !== lease.day
    || !(Number.isSafeInteger(lease.reserved) && lease.reserved > 0 && lease.reserved <= PSN_US_PAGE_DAILY_LIMIT)
    || !(Number.isSafeInteger(lease.consumed) && lease.consumed >= 0 && lease.consumed <= lease.reserved)
    || !(lease.lastRequestedAt === null || (exactIsoTimestamp(lease.lastRequestedAt)
      && lease.lastRequestedAt.slice(0, 10) === lease.day))) {
    throw new Error('PSN US run lease is invalid');
  }
  return lease;
}

/** Purely reserve the next physical PSN US page request in UTC. */
export function consumePsnUsPageBudget(ledger, {
  now = new Date(),
  dailyLimit = PSN_US_PAGE_DAILY_LIMIT,
} = {}) {
  validatePsnUsBudgetLedger(ledger);
  if (!(Number.isSafeInteger(dailyLimit) && dailyLimit > 0 && dailyLimit <= PSN_US_PAGE_DAILY_LIMIT)) {
    throw new TypeError(`PSN US daily limit must be 1-${PSN_US_PAGE_DAILY_LIMIT}`);
  }
  const { current } = utcDay(now);
  const latestReservationMs = latestLedgerReservationMs(ledger);
  const scheduledMs = Math.max(
    current.valueOf(),
    Number.isFinite(latestReservationMs)
      ? latestReservationMs + PSN_US_PAGE_MIN_INTERVAL_MS
      : current.valueOf(),
  );
  const scheduledAt = new Date(scheduledMs).toISOString();
  const day = scheduledAt.slice(0, 10);
  const count = ledger.days[day]?.pageRequests ?? 0;
  if (count >= dailyLimit) {
    throw budgetError(`PSN US page-request daily budget exhausted (${dailyLimit}) for ${day}`);
  }

  const days = prunedLedgerDays(ledger, current.valueOf());
  days[day] = {
    pageRequests: count + 1,
    lastRequestedAt: scheduledAt,
  };
  return {
    ledger: { schemaVersion: PSN_US_BUDGET_SCHEMA_VERSION, days },
    day,
    used: count + 1,
    remaining: dailyLimit - count - 1,
    scheduledAt,
    waitMs: scheduledMs - current.valueOf(),
  };
}

/**
 * Pure bulk reservation used only by scheduled jobs. Capacity is charged to
 * the tracked daily ledger immediately; the returned private lease spends that
 * already-charged capacity without touching the tracked count again.
 */
export function reservePsnUsRunBudgetInLedger(ledger, {
  requests = PSN_US_PAGE_DAILY_LIMIT,
  now = new Date(),
  leaseId = randomUUID(),
  owner,
  purpose,
} = {}) {
  validatePsnUsBudgetLedger(ledger);
  if (!(Number.isSafeInteger(requests) && requests > 0 && requests <= PSN_US_PAGE_DAILY_LIMIT)) {
    throw new TypeError(`PSN US run lease requests must be 1-${PSN_US_PAGE_DAILY_LIMIT}`);
  }
  if (typeof leaseId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(leaseId)) {
    throw new TypeError('PSN US run lease id must be a UUID v4');
  }
  if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(owner)) {
    throw new TypeError('PSN US run lease owner is invalid');
  }
  if (!['calendar', 'price'].includes(purpose)) {
    throw new TypeError('PSN US run lease purpose must be calendar or price');
  }
  const { current, day } = utcDay(now);
  const used = ledger.days[day]?.pageRequests ?? 0;
  if (used + requests > PSN_US_PAGE_DAILY_LIMIT) {
    throw budgetError(
      `PSN US run lease needs ${requests} requests but only ${PSN_US_PAGE_DAILY_LIMIT - used} remain for ${day}`,
      'psn_us_run_lease_budget_exhausted',
    );
  }

  const latestReservationMs = latestLedgerReservationMs(ledger);
  const pacingAnchor = Number.isFinite(latestReservationMs)
    ? new Date(latestReservationMs).toISOString()
    : null;
  const earliestFirstRequestMs = Math.max(
    current.valueOf(),
    Number.isFinite(latestReservationMs)
      ? latestReservationMs + PSN_US_PAGE_MIN_INTERVAL_MS
      : current.valueOf(),
  );
  const earliestLastRequestMs = earliestFirstRequestMs
    + (requests - 1) * PSN_US_PAGE_MIN_INTERVAL_MS;
  if (new Date(earliestLastRequestMs).toISOString().slice(0, 10) !== day) {
    throw budgetError(
      `PSN US run lease cannot fit ${requests} paced requests inside UTC day ${day}`,
      'psn_us_run_lease_crosses_utc_day',
    );
  }

  const days = prunedLedgerDays(ledger, current.valueOf());
  const priorDayBarrier = Date.parse(days[day]?.lastRequestedAt ?? '');
  days[day] = {
    pageRequests: used + requests,
    // This is the durable reservation barrier, not a claim that every leased
    // request already happened. Actual pacing state lives in the private lease.
    lastRequestedAt: new Date(Math.max(
      current.valueOf(),
      Number.isFinite(priorDayBarrier) ? priorDayBarrier : Number.NEGATIVE_INFINITY,
    )).toISOString(),
  };
  const lease = {
    schemaVersion: PSN_US_RUN_LEASE_SCHEMA_VERSION,
    leaseId,
    owner,
    purpose,
    day,
    createdAt: current.toISOString(),
    reserved: requests,
    consumed: 0,
    lastRequestedAt: pacingAnchor?.slice(0, 10) === day ? pacingAnchor : null,
  };
  validatePsnUsRunLease(lease);
  return {
    ledger: { schemaVersion: PSN_US_BUDGET_SCHEMA_VERSION, days },
    lease,
    day,
    reserved: requests,
    remaining: PSN_US_PAGE_DAILY_LIMIT - used - requests,
  };
}

/** Purely consume one already-reserved physical request from a run lease. */
export function consumePsnUsRunLease(lease, {
  now = new Date(),
  owner = lease?.owner,
  purpose = lease?.purpose,
} = {}) {
  validatePsnUsRunLease(lease);
  if (owner !== lease.owner || purpose !== lease.purpose) {
    throw budgetError('PSN US run lease identity does not match this job', 'psn_us_run_lease_identity_mismatch');
  }
  const { current, day } = utcDay(now);
  if (day !== lease.day) {
    throw budgetError(
      `PSN US run lease for ${lease.day} cannot be used on ${day}`,
      'psn_us_run_lease_expired',
    );
  }
  if (lease.consumed >= lease.reserved) {
    throw budgetError(
      `PSN US run lease exhausted (${lease.reserved}) for ${lease.day}`,
      'psn_us_run_lease_exhausted',
    );
  }
  const previousMs = Date.parse(lease.lastRequestedAt ?? '');
  const scheduledMs = Math.max(
    current.valueOf(),
    Number.isFinite(previousMs)
      ? previousMs + PSN_US_PAGE_MIN_INTERVAL_MS
      : current.valueOf(),
  );
  const scheduledAt = new Date(scheduledMs).toISOString();
  if (scheduledAt.slice(0, 10) !== lease.day) {
    throw budgetError(
      `PSN US run lease pacing crossed UTC day ${lease.day}`,
      'psn_us_run_lease_expired',
    );
  }
  return {
    lease: {
      ...lease,
      consumed: lease.consumed + 1,
      lastRequestedAt: scheduledAt,
    },
    day: lease.day,
    used: lease.consumed + 1,
    remaining: lease.reserved - lease.consumed - 1,
    scheduledAt,
    waitMs: scheduledMs - current.valueOf(),
  };
}

function loadLedger(filePath) {
  if (!fs.existsSync(filePath)) return createPsnUsBudgetLedger();
  return validatePsnUsBudgetLedger(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function mergeBudgetLedgers(...ledgers) {
  const days = {};
  for (const ledger of ledgers) {
    validatePsnUsBudgetLedger(ledger);
    for (const [day, entry] of Object.entries(ledger.days)) {
      const prior = days[day];
      days[day] = {
        pageRequests: Math.max(prior?.pageRequests ?? 0, entry.pageRequests),
        lastRequestedAt: new Date(Math.max(
          prior ? Date.parse(prior.lastRequestedAt) : Number.NEGATIVE_INFINITY,
          Date.parse(entry.lastRequestedAt),
        )).toISOString(),
      };
    }
  }
  return { schemaVersion: PSN_US_BUDGET_SCHEMA_VERSION, days };
}

function atomicWriteJson(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function atomicCreateJson(filePath, document) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (error?.code === 'EEXIST') {
      throw budgetError(`PSN US run lease already exists: ${filePath}`, 'psn_us_run_lease_exists');
    }
    throw error;
  }
  fs.closeSync(descriptor);
}

/** Resolve and validate the scheduled-job lease binding from explicit env. */
export function psnUsRunLeaseConfig(env = process.env, { required = false } = {}) {
  const leasePath = env?.[PSN_US_RUN_LEASE_ENV];
  const owner = env?.[PSN_US_RUN_LEASE_OWNER_ENV];
  const purpose = env?.[PSN_US_RUN_LEASE_PURPOSE_ENV];
  const anyConfigured = leasePath !== undefined || owner !== undefined || purpose !== undefined;
  if (!anyConfigured && !required) return null;
  if (typeof leasePath !== 'string' || !leasePath || !path.isAbsolute(leasePath)) {
    throw budgetError(`PSN US scheduled run requires an absolute ${PSN_US_RUN_LEASE_ENV}`, 'psn_us_run_lease_config_invalid');
  }
  const resolvedPath = path.resolve(leasePath);
  if ([PSN_US_BUDGET_PATH, PSN_US_SHARED_BUDGET_PATH].some((candidate) => path.resolve(candidate) === resolvedPath)) {
    throw budgetError('PSN US run lease path cannot replace a budget ledger', 'psn_us_run_lease_config_invalid');
  }
  if (typeof owner !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(owner)) {
    throw budgetError(`PSN US scheduled run requires a valid ${PSN_US_RUN_LEASE_OWNER_ENV}`, 'psn_us_run_lease_config_invalid');
  }
  if (!['calendar', 'price'].includes(purpose)) {
    throw budgetError(`PSN US scheduled run requires ${PSN_US_RUN_LEASE_PURPOSE_ENV}=calendar|price`, 'psn_us_run_lease_config_invalid');
  }
  return { leasePath: resolvedPath, owner, purpose };
}

function processIsAlive(pid) {
  if (!(Number.isSafeInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function staleLock(lockPath, nowMs, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (owner?.schemaVersion === 1
      && Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && typeof owner.token === 'string'
      && Number.isFinite(Date.parse(owner.createdAt ?? ''))) {
      return !processIsAlive(owner.pid)
        || nowMs - Math.max(Date.parse(owner.createdAt), stat.mtimeMs) >= staleMs;
    }
  } catch {}
  return nowMs - stat.mtimeMs >= staleMs;
}

function acquireFileLock(lockPath, {
  now = new Date(),
  staleMs,
  errorCode,
  description,
} = {}) {
  const nowMs = new Date(now).valueOf();
  if (!Number.isFinite(nowMs)) throw new TypeError('PSN US lock time is invalid');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner = {
      schemaVersion: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date(nowMs).toISOString(),
    };
    let descriptor;
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        return { descriptor, owner };
      } catch (error) {
        fs.closeSync(descriptor);
        try { fs.unlinkSync(lockPath); } catch {}
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (!staleLock(lockPath, nowMs, staleMs)) {
        const locked = new Error(`${description} is locked by another PSN run`);
        locked.code = errorCode;
        throw locked;
      }
      try { fs.unlinkSync(lockPath); } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
    }
  }
  const locked = new Error(`${description} lock could not be recovered`);
  locked.code = errorCode;
  throw locked;
}

function releaseFileLock(lockPath, lock) {
  fs.closeSync(lock.descriptor);
  try {
    const current = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (current?.token === lock.owner.token) fs.unlinkSync(lockPath);
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

/** Serialize discovery, scraping and mapping verification across the ledger. */
export function acquirePsnUsRequestRun({
  budgetPath = PSN_US_SHARED_BUDGET_PATH,
  now = new Date(),
} = {}) {
  const lockPath = `${budgetPath}.run.lock`;
  const lock = acquireFileLock(lockPath, {
    now,
    staleMs: RUN_LOCK_STALE_MS,
    errorCode: 'psn_us_run_locked',
    description: 'PSN US page-request run',
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseFileLock(lockPath, lock);
  };
}

/**
 * Reserve a scheduled job's entire allowance before storefront I/O. The
 * tracked audit ledger is written first, then the shared local mirror, and the
 * private consumer lease last. A partial failure can waste capacity but can
 * never create an uncharged lease.
 */
export function reservePsnUsRunBudget({
  leasePath,
  owner,
  purpose,
  requests = PSN_US_PAGE_DAILY_LIMIT,
  budgetPath = PSN_US_SHARED_BUDGET_PATH,
  auditPath,
  now = new Date(),
  leaseId = randomUUID(),
} = {}) {
  const resolvedLeasePath = typeof leasePath === 'string' && path.isAbsolute(leasePath)
    ? path.resolve(leasePath)
    : null;
  if (!resolvedLeasePath) throw new TypeError('PSN US run lease path must be absolute');
  const mirrorPath = auditPath === undefined
    ? (path.resolve(budgetPath) === path.resolve(PSN_US_SHARED_BUDGET_PATH) ? PSN_US_BUDGET_PATH : null)
    : auditPath;
  if ([budgetPath, mirrorPath].filter(Boolean)
    .some((candidate) => path.resolve(candidate) === resolvedLeasePath)) {
    throw new TypeError('PSN US run lease path cannot replace a budget ledger');
  }

  const releaseRun = acquirePsnUsRequestRun({ budgetPath, now });
  const lockPath = `${budgetPath}.lock`;
  let lock;
  try {
    lock = acquireFileLock(lockPath, {
      now,
      staleMs: BUDGET_LOCK_STALE_MS,
      errorCode: 'psn_us_budget_locked',
      description: 'PSN US page-request budget ledger',
    });
    if (fs.existsSync(resolvedLeasePath)) {
      throw budgetError(`PSN US run lease already exists: ${resolvedLeasePath}`, 'psn_us_run_lease_exists');
    }
    const ledger = mergeBudgetLedgers(
      loadLedger(budgetPath),
      ...(mirrorPath && path.resolve(mirrorPath) !== path.resolve(budgetPath)
        ? [loadLedger(mirrorPath)]
        : []),
    );
    const reservation = reservePsnUsRunBudgetInLedger(ledger, {
      requests,
      now,
      leaseId,
      owner,
      purpose,
    });
    // The tracked mirror is the durable cross-runner safety boundary and must
    // be ready for commit before a usable private lease exists.
    if (mirrorPath && path.resolve(mirrorPath) !== path.resolve(budgetPath)) {
      atomicWriteJson(mirrorPath, reservation.ledger);
    }
    atomicWriteJson(budgetPath, reservation.ledger);
    atomicCreateJson(resolvedLeasePath, reservation.lease);
    return { ...reservation, leasePath: resolvedLeasePath };
  } finally {
    if (lock) releaseFileLock(lockPath, lock);
    releaseRun();
  }
}

/** Atomically consume one private lease slot before its physical request. */
export function reservePsnUsRunLeasePage({
  leasePath,
  owner,
  purpose,
  now = new Date(),
} = {}) {
  const resolvedLeasePath = typeof leasePath === 'string' && path.isAbsolute(leasePath)
    ? path.resolve(leasePath)
    : null;
  if (!resolvedLeasePath) {
    throw budgetError('PSN US run lease path must be absolute', 'psn_us_run_lease_config_invalid');
  }
  const lockPath = `${resolvedLeasePath}.lock`;
  let lock;
  try {
    lock = acquireFileLock(lockPath, {
      now,
      staleMs: BUDGET_LOCK_STALE_MS,
      errorCode: 'psn_us_run_lease_locked',
      description: 'PSN US private run lease',
    });
  } catch (error) {
    error.budget = true;
    throw error;
  }
  try {
    let lease;
    try {
      lease = validatePsnUsRunLease(JSON.parse(fs.readFileSync(resolvedLeasePath, 'utf8')));
    } catch (error) {
      if (error?.budget) throw error;
      throw budgetError(`PSN US run lease cannot be loaded: ${error.message}`, 'psn_us_run_lease_invalid');
    }
    const reservation = consumePsnUsRunLease(lease, { now, owner, purpose });
    // Persist before waiting/requesting: failed attempts and process crashes
    // consume their pre-reserved slots without touching the tracked ledger.
    atomicWriteJson(resolvedLeasePath, reservation.lease);
    return reservation;
  } finally {
    if (lock) releaseFileLock(lockPath, lock);
  }
}

/** Scheduled workflows use their private lease; manual tools keep per-page accounting. */
export function reservePsnUsPageForCurrentRun({
  env = process.env,
  now = new Date(),
  reserveManual = reservePsnUsPage,
  reserveLease = reservePsnUsRunLeasePage,
} = {}) {
  const config = psnUsRunLeaseConfig(env);
  return config
    ? reserveLease({ ...config, now })
    : reserveManual({ now });
}

export function reservePsnUsPage({
  budgetPath = PSN_US_SHARED_BUDGET_PATH,
  auditPath,
  now = new Date(),
} = {}) {
  const mirrorPath = auditPath === undefined
    ? (path.resolve(budgetPath) === path.resolve(PSN_US_SHARED_BUDGET_PATH) ? PSN_US_BUDGET_PATH : null)
    : auditPath;
  const lockPath = `${budgetPath}.lock`;
  const lock = acquireFileLock(lockPath, {
    now,
    staleMs: BUDGET_LOCK_STALE_MS,
    errorCode: 'psn_us_budget_locked',
    description: 'PSN US page-request budget ledger',
  });
  try {
    const ledger = mergeBudgetLedgers(
      loadLedger(budgetPath),
      ...(mirrorPath && path.resolve(mirrorPath) !== path.resolve(budgetPath)
        ? [loadLedger(mirrorPath)]
        : []),
    );
    const reservation = consumePsnUsPageBudget(ledger, { now });
    // Persist before the physical request: failures and crashes still count.
    atomicWriteJson(budgetPath, reservation.ledger);
    if (mirrorPath && path.resolve(mirrorPath) !== path.resolve(budgetPath)) {
      atomicWriteJson(mirrorPath, reservation.ledger);
    }
    return reservation;
  } finally {
    releaseFileLock(lockPath, lock);
  }
}

/** Read-only preflight for a planned bounded run across all worktrees. */
export function psnUsBudgetStatus({
  budgetPath = PSN_US_SHARED_BUDGET_PATH,
  auditPath,
  leasePath,
  owner,
  purpose,
  now = new Date(),
} = {}) {
  const configuredLease = leasePath === undefined
    ? psnUsRunLeaseConfig(process.env)
    : (leasePath === null ? null : { leasePath, owner, purpose });
  if (configuredLease) {
    const resolvedLeasePath = typeof configuredLease.leasePath === 'string'
      && path.isAbsolute(configuredLease.leasePath)
      ? path.resolve(configuredLease.leasePath)
      : null;
    if (!resolvedLeasePath) {
      throw budgetError('PSN US run lease path must be absolute', 'psn_us_run_lease_config_invalid');
    }
    let lease;
    try {
      lease = validatePsnUsRunLease(JSON.parse(fs.readFileSync(resolvedLeasePath, 'utf8')));
    } catch (error) {
      throw budgetError(`PSN US run lease cannot be loaded: ${error.message}`, 'psn_us_run_lease_invalid');
    }
    const identityOwner = configuredLease.owner ?? lease.owner;
    const identityPurpose = configuredLease.purpose ?? lease.purpose;
    if (identityOwner !== lease.owner || identityPurpose !== lease.purpose) {
      throw budgetError('PSN US run lease identity does not match this job', 'psn_us_run_lease_identity_mismatch');
    }
    const { day } = utcDay(now);
    if (day !== lease.day) {
      throw budgetError(`PSN US run lease for ${lease.day} cannot be used on ${day}`, 'psn_us_run_lease_expired');
    }
    return { day, used: lease.consumed, remaining: lease.reserved - lease.consumed };
  }
  const mirrorPath = auditPath === undefined
    ? (path.resolve(budgetPath) === path.resolve(PSN_US_SHARED_BUDGET_PATH) ? PSN_US_BUDGET_PATH : null)
    : auditPath;
  const ledger = mergeBudgetLedgers(
    loadLedger(budgetPath),
    ...(mirrorPath && path.resolve(mirrorPath) !== path.resolve(budgetPath)
      ? [loadLedger(mirrorPath)]
      : []),
  );
  const { day } = utcDay(now);
  const used = ledger.days[day]?.pageRequests ?? 0;
  return { day, used, remaining: PSN_US_PAGE_DAILY_LIMIT - used };
}

/** One persistent reservation always maps to exactly one fetch attempt. */
export async function fetchPsnUsPage(url, {
  label,
  reserve = () => reservePsnUsPageForCurrentRun(),
  wait = sleep,
  // The PlayStation edge intermittently stalls Node's built-in HTTP client;
  // the reviewed curl transport preserves exact URLs and the same HTTP guards.
  fetchPage = fetchTextViaCurl,
} = {}) {
  const reservation = reserve();
  if (reservation.waitMs > 0) await wait(reservation.waitMs);
  return fetchPage(url, { label, attempts: 1 });
}

/**
 * Bounded logical retry where every physical attempt goes back through the
 * persistent reservation and 1.5s pacing gate. Permanent HTTP errors, budget
 * exhaustion and lock failures are never retried.
 */
export async function fetchPsnUsPageWithRetry(url, {
  maxPhysicalAttempts = 2,
  ...options
} = {}) {
  if (!(Number.isInteger(maxPhysicalAttempts) && maxPhysicalAttempts >= 1 && maxPhysicalAttempts <= 3)) {
    throw new TypeError('PSN maxPhysicalAttempts must be 1-3');
  }
  let lastError;
  for (let attempt = 1; attempt <= maxPhysicalAttempts; attempt += 1) {
    try {
      return await fetchPsnUsPage(url, options);
    } catch (error) {
      lastError = error;
      if (error?.permanent || error?.budget || error?.code === 'psn_us_daily_budget_exhausted'
        || attempt === maxPhysicalAttempts) throw error;
    }
  }
  throw lastError;
}
