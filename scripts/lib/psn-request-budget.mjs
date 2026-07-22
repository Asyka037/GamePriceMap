/**
 * Persistent safety envelope for PlayStation Store US page requests, including
 * both official search result pages and exact product pages.
 *
 * A reservation is written before each physical request, so crashes and
 * failed responses still consume upstream capacity. The pure ledger advance
 * function serializes request starts at >= 1.5 seconds even across processes;
 * filesystem locks protect the reservation and the full scraper run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchText, sleep } from './http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PSN_US_PAGE_DAILY_LIMIT = 60;
export const PSN_US_PAGE_MIN_INTERVAL_MS = 1500;
export const PSN_US_BUDGET_SCHEMA_VERSION = 1;
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

/** Purely reserve the next physical PSN US page request in UTC. */
export function consumePsnUsPageBudget(ledger, {
  now = new Date(),
  dailyLimit = PSN_US_PAGE_DAILY_LIMIT,
} = {}) {
  validatePsnUsBudgetLedger(ledger);
  if (!(Number.isSafeInteger(dailyLimit) && dailyLimit > 0 && dailyLimit <= PSN_US_PAGE_DAILY_LIMIT)) {
    throw new TypeError(`PSN US daily limit must be 1-${PSN_US_PAGE_DAILY_LIMIT}`);
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.valueOf())) throw new TypeError('PSN US budget time is invalid');

  const latestReservationMs = Math.max(
    Number.NEGATIVE_INFINITY,
    ...Object.values(ledger.days).map((entry) => Date.parse(entry.lastRequestedAt)),
  );
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
    const error = new Error(`PSN US page-request daily budget exhausted (${dailyLimit}) for ${day}`);
    error.code = 'psn_us_daily_budget_exhausted';
    error.budget = true;
    throw error;
  }

  const cutoff = current.valueOf() - 31 * 86_400_000;
  const days = Object.fromEntries(Object.entries(ledger.days)
    .filter(([key]) => Date.parse(`${key}T00:00:00.000Z`) >= cutoff));
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

/** One persistent reservation always maps to exactly one fetch attempt. */
export async function fetchPsnUsPage(url, {
  label,
  reserve = () => reservePsnUsPage(),
  wait = sleep,
  fetchPage = fetchText,
} = {}) {
  const reservation = reserve();
  if (reservation.waitMs > 0) await wait(reservation.waitMs);
  return fetchPage(url, { label, attempts: 1 });
}
