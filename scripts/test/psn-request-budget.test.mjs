import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  PSN_US_PAGE_DAILY_LIMIT,
  PSN_US_PAGE_MIN_INTERVAL_MS,
  acquirePsnUsRequestRun,
  consumePsnUsPageBudget,
  consumePsnUsRunLease,
  createPsnUsBudgetLedger,
  fetchPsnUsPage,
  fetchPsnUsPageWithRetry,
  psnUsBudgetStatus,
  psnUsRunLeaseConfig,
  resolvePsnUsSharedBudgetPath,
  reservePsnUsPage,
  reservePsnUsPageForCurrentRun,
  reservePsnUsRunBudget,
  reservePsnUsRunBudgetInLedger,
  reservePsnUsRunLeasePage,
} from '../lib/psn-request-budget.mjs';
import { parseReservePsnRunBudgetArgs } from '../reserve-psn-run-budget.mjs';

const LEASE_ID = '123e4567-e89b-42d3-a456-426614174000';
const LEASE_OWNER = '12345:1:psn-calendar-weekly';

test('PSN physical-page budget is UTC-persistent, paced and capped at 60', () => {
  assert.equal(PSN_US_PAGE_DAILY_LIMIT, 60);
  assert.equal(PSN_US_PAGE_MIN_INTERVAL_MS, 1500);
  let ledger = createPsnUsBudgetLedger();
  let previous = null;
  for (let index = 0; index < PSN_US_PAGE_DAILY_LIMIT; index += 1) {
    const reservation = consumePsnUsPageBudget(ledger, {
      now: new Date('2026-07-18T12:00:00.000Z'),
    });
    if (previous) {
      assert.equal(Date.parse(reservation.scheduledAt) - Date.parse(previous), 1500);
    }
    previous = reservation.scheduledAt;
    ledger = reservation.ledger;
  }
  assert.throws(() => consumePsnUsPageBudget(ledger, {
    now: new Date('2026-07-18T23:59:59.000Z'),
  }), { code: 'psn_us_daily_budget_exhausted' });

  const nextDay = consumePsnUsPageBudget(ledger, {
    now: new Date('2026-07-19T00:00:00.000Z'),
  });
  assert.equal(nextDay.day, '2026-07-19');
  assert.equal(nextDay.used, 1);
});

test('scheduled run reserves the full tracked day before a private lease spends paced slots', () => {
  const now = new Date('2026-07-22T13:00:00.000Z');
  const reservation = reservePsnUsRunBudgetInLedger(createPsnUsBudgetLedger(), {
    requests: PSN_US_PAGE_DAILY_LIMIT,
    now,
    leaseId: LEASE_ID,
    owner: LEASE_OWNER,
    purpose: 'calendar',
  });
  assert.equal(reservation.ledger.days['2026-07-22'].pageRequests, 60);
  assert.equal(reservation.remaining, 0);
  assert.deepEqual(reservation.lease, {
    schemaVersion: 1,
    leaseId: LEASE_ID,
    owner: LEASE_OWNER,
    purpose: 'calendar',
    day: '2026-07-22',
    createdAt: now.toISOString(),
    reserved: 60,
    consumed: 0,
    lastRequestedAt: null,
  });

  let lease = reservation.lease;
  let previous = null;
  for (let index = 0; index < PSN_US_PAGE_DAILY_LIMIT; index += 1) {
    const attempt = consumePsnUsRunLease(lease, { now, owner: LEASE_OWNER, purpose: 'calendar' });
    if (previous) assert.equal(Date.parse(attempt.scheduledAt) - Date.parse(previous), 1500);
    previous = attempt.scheduledAt;
    lease = attempt.lease;
  }
  assert.throws(() => consumePsnUsRunLease(lease, {
    now,
    owner: LEASE_OWNER,
    purpose: 'calendar',
  }), { code: 'psn_us_run_lease_exhausted' });
});

test('run leases fail closed on prior use, identity drift and UTC rollover', () => {
  const ledger = consumePsnUsPageBudget(createPsnUsBudgetLedger(), {
    now: new Date('2026-07-22T12:00:00.000Z'),
  }).ledger;
  assert.throws(() => reservePsnUsRunBudgetInLedger(ledger, {
    requests: PSN_US_PAGE_DAILY_LIMIT,
    now: new Date('2026-07-22T13:00:00.000Z'),
    leaseId: LEASE_ID,
    owner: LEASE_OWNER,
    purpose: 'calendar',
  }), { code: 'psn_us_run_lease_budget_exhausted' });
  assert.throws(() => reservePsnUsRunBudgetInLedger(createPsnUsBudgetLedger(), {
    requests: 2,
    now: new Date('2026-07-22T23:59:59.000Z'),
    leaseId: LEASE_ID,
    owner: LEASE_OWNER,
    purpose: 'calendar',
  }), { code: 'psn_us_run_lease_crosses_utc_day' });

  const { lease } = reservePsnUsRunBudgetInLedger(createPsnUsBudgetLedger(), {
    requests: 2,
    now: new Date('2026-07-22T13:00:00.000Z'),
    leaseId: LEASE_ID,
    owner: LEASE_OWNER,
    purpose: 'calendar',
  });
  assert.throws(() => consumePsnUsRunLease(lease, {
    now: new Date('2026-07-22T13:00:00.000Z'),
    owner: 'other-run:1:psn-calendar-weekly',
    purpose: 'calendar',
  }), { code: 'psn_us_run_lease_identity_mismatch' });
  assert.throws(() => consumePsnUsRunLease(lease, {
    now: new Date('2026-07-23T00:00:00.000Z'),
    owner: LEASE_OWNER,
    purpose: 'calendar',
  }), { code: 'psn_us_run_lease_expired' });
});

test('private lease consumption never increments the already-reserved tracked ledger', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-run-lease-'));
  const budgetPath = path.join(directory, 'private-budget.json');
  const auditPath = path.join(directory, 'tracked-budget.json');
  const leasePath = path.join(directory, 'run-lease.json');
  const now = new Date('2026-07-22T13:00:00.000Z');
  try {
    reservePsnUsRunBudget({
      budgetPath,
      auditPath,
      leasePath,
      requests: 3,
      now,
      leaseId: LEASE_ID,
      owner: LEASE_OWNER,
      purpose: 'calendar',
    });
    const trackedBefore = readFileSync(auditPath, 'utf8');
    assert.equal(JSON.parse(trackedBefore).days['2026-07-22'].pageRequests, 3);
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8')).days['2026-07-22'].pageRequests, 3);

    const first = reservePsnUsRunLeasePage({ leasePath, owner: LEASE_OWNER, purpose: 'calendar', now });
    const second = reservePsnUsRunLeasePage({ leasePath, owner: LEASE_OWNER, purpose: 'calendar', now });
    assert.equal(first.waitMs, 0);
    assert.equal(second.waitMs, 1500);
    assert.equal(readFileSync(auditPath, 'utf8'), trackedBefore);
    assert.deepEqual(psnUsBudgetStatus({
      leasePath,
      owner: LEASE_OWNER,
      purpose: 'calendar',
      now,
    }), { day: '2026-07-22', used: 2, remaining: 1 });
    assert.throws(() => reservePsnUsRunBudget({
      budgetPath,
      auditPath,
      leasePath,
      requests: 1,
      now,
      owner: LEASE_OWNER,
      purpose: 'calendar',
    }), { code: 'psn_us_run_lease_exists' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict scheduled-run CLI binds authorization, purpose, owner and private path', () => {
  const valid = {
    PSN_AUTOMATION_AUTHORIZED: 'true',
    PSN_US_RUN_LEASE_PATH: path.join(tmpdir(), 'psn-us-cli-lease.json'),
    PSN_US_RUN_LEASE_OWNER: LEASE_OWNER,
    PSN_US_RUN_LEASE_PURPOSE: 'calendar',
  };
  assert.deepEqual(parseReservePsnRunBudgetArgs(['--purpose=calendar'], valid), {
    leasePath: path.resolve(valid.PSN_US_RUN_LEASE_PATH),
    owner: LEASE_OWNER,
    purpose: 'calendar',
  });
  assert.deepEqual(psnUsRunLeaseConfig({}, { required: false }), null);
  for (const argv of [[], ['calendar'], ['--purpose=calendar', '--purpose=calendar'], ['--purpose=discover'], ['--unknown=x']]) {
    assert.throws(() => parseReservePsnRunBudgetArgs(argv, valid), /Usage/u);
  }
  assert.throws(() => parseReservePsnRunBudgetArgs(['--purpose=price'], valid), /purpose mismatch/u);
  assert.throws(() => parseReservePsnRunBudgetArgs(['--purpose=calendar'], {
    ...valid,
    PSN_AUTOMATION_AUTHORIZED: 'false',
  }), /AUTHORIZED/u);
  assert.throws(() => parseReservePsnRunBudgetArgs(['--purpose=calendar'], {
    ...valid,
    PSN_US_RUN_LEASE_PATH: 'relative.json',
  }), { code: 'psn_us_run_lease_config_invalid' });
});

test('manual PSN tools keep the legacy per-request ledger when no lease env is present', () => {
  const calls = [];
  const reservation = reservePsnUsPageForCurrentRun({
    env: {},
    now: new Date('2026-07-22T13:00:00.000Z'),
    reserveManual: (options) => {
      calls.push(options);
      return { waitMs: 0, used: 1 };
    },
    reserveLease: () => { throw new Error('unexpected lease path'); },
  });
  assert.equal(reservation.used, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].now.toISOString(), '2026-07-22T13:00:00.000Z');
});

test('PSN reservations persist before requests and recover an exited lock owner', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-budget-'));
  const budgetPath = path.join(directory, 'budget.json');
  try {
    reservePsnUsPage({ budgetPath, now: new Date('2026-07-18T00:00:00.000Z') });
    reservePsnUsPage({ budgetPath, now: new Date('2026-07-18T01:00:00.000Z') });
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8'))
      .days['2026-07-18'].pageRequests, 2);
    assert.deepEqual(psnUsBudgetStatus({
      budgetPath,
      auditPath: null,
      now: new Date('2026-07-18T01:30:00.000Z'),
    }), { day: '2026-07-18', used: 2, remaining: 58 });

    const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    writeFileSync(`${budgetPath}.lock`, `${JSON.stringify({
      schemaVersion: 1,
      pid: exited.pid,
      token: 'exited-owner',
      createdAt: '2026-07-18T02:00:00.000Z',
    })}\n`);
    assert.equal(reservePsnUsPage({
      budgetPath,
      now: new Date('2026-07-18T02:00:00.000Z'),
    }).used, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('primary checkout and linked worktrees resolve one authoritative runtime budget', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-worktrees-'));
  const primary = path.join(directory, 'primary');
  const linked = path.join(directory, 'linked');
  const worktreeGitDir = path.join(primary, '.git', 'worktrees', 'linked');
  try {
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    writeFileSync(path.join(linked, '.git'), `gitdir: ${worktreeGitDir}\n`);

    const primaryBudget = resolvePsnUsSharedBudgetPath(primary);
    const linkedBudget = resolvePsnUsSharedBudgetPath(linked);
    assert.equal(primaryBudget, linkedBudget);

    const primaryAudit = path.join(primary, 'data', 'seeds', 'psn-us-request-budget.json');
    const linkedAudit = path.join(linked, 'data', 'seeds', 'psn-us-request-budget.json');
    reservePsnUsPage({
      budgetPath: primaryBudget,
      auditPath: primaryAudit,
      now: new Date('2026-07-18T00:00:00.000Z'),
    });
    reservePsnUsPage({
      budgetPath: linkedBudget,
      auditPath: linkedAudit,
      now: new Date('2026-07-18T00:00:02.000Z'),
    });
    assert.equal(JSON.parse(readFileSync(primaryBudget, 'utf8'))
      .days['2026-07-18'].pageRequests, 2);
    assert.equal(JSON.parse(readFileSync(linkedAudit, 'utf8'))
      .days['2026-07-18'].pageRequests, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('price workflow pushes a fixed private lease reservation before any PSN scrape', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/psn-weekly.yml', import.meta.url), 'utf8');
  const pull = workflow.indexOf('Pull latest PSN budget head');
  const reserve = workflow.indexOf('Reserve full PSN price run budget');
  const push = workflow.indexOf('Commit and push PSN price run budget');
  const scrape = workflow.indexOf('Scrape PlayStation Store US POC');
  const history = workflow.indexOf('Evolve price history');
  assert.ok(pull >= 0 && reserve > pull && push > reserve && scrape > push && history > scrape);
  assert.match(workflow, /PSN_US_RUN_LEASE_PATH:/u);
  assert.match(workflow, /timeout-minutes: 65/u);
  assert.match(workflow, /PSN_US_RUN_LEASE_OWNER:/u);
  assert.match(workflow, /PSN_US_RUN_LEASE_PURPOSE: price/u);
  assert.match(workflow, /reserve-psn-run-budget\.mjs --purpose=price/u);
  assert.match(workflow, /git add data\/seeds\/psn-us-request-budget\.json/u);
  assert.match(workflow.slice(push, scrape), /git push origin HEAD:main/u);
  assert.doesNotMatch(workflow, /Checkpoint PSN request budget|--autostash/u);
});

test('calendar workflow pushes a fixed private lease reservation before any PSN scrape', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/psn-calendar-weekly.yml', import.meta.url), 'utf8');
  const pull = workflow.indexOf('Pull latest PSN budget head');
  const reserve = workflow.indexOf('Reserve full PSN calendar run budget');
  const push = workflow.indexOf('Commit and push PSN calendar run budget');
  const scrape = workflow.indexOf('Scrape PlayStation Store US release calendar');
  const validate = workflow.indexOf('Validate data gate');
  assert.ok(pull >= 0 && reserve > pull && push > reserve && scrape > push && validate > scrape);
  assert.match(workflow, /cron: '0 13 \* \* 2'/u);
  assert.match(workflow, /timeout-minutes: 65/u);
  assert.match(workflow, /PSN_US_RUN_LEASE_PATH:/u);
  assert.match(workflow, /PSN_US_RUN_LEASE_OWNER:/u);
  assert.match(workflow, /PSN_US_RUN_LEASE_PURPOSE: calendar/u);
  assert.match(workflow, /reserve-psn-run-budget\.mjs --purpose=calendar/u);
  assert.match(workflow, /npm run scrape:psn-calendar/u);
  assert.match(workflow, /git add data\/seeds\/psn-us-request-budget\.json/u);
  assert.match(workflow.slice(push, scrape), /git push origin HEAD:main/u);
  assert.match(workflow, /if \[ -f data\/feeds\/releases-psn\.json \]; then/u);
  assert.doesNotMatch(workflow, /Checkpoint PSN calendar request budget|--autostash/u);
  assert.doesNotMatch(workflow, /scrape-psn\.mjs|npm run scrape:psn(?:\s|$)/u);
});

test('one reservation invokes exactly one PSN page attempt after its reserved wait', async () => {
  const calls = [];
  const expected = { text: '<html></html>', finalUrl: 'https://store.playstation.com/en-us/product/example' };
  const actual = await fetchPsnUsPage(expected.finalUrl, {
    reserve: () => {
      calls.push('reserve');
      return { waitMs: 1500 };
    },
    wait: async (waitMs) => calls.push(`wait:${waitMs}`),
    fetchPage: async (url, options) => {
      calls.push({ url, options });
      return expected;
    },
    label: 'PSN test page',
  });
  assert.equal(actual, expected);
  assert.deepEqual(calls, [
    'reserve',
    'wait:1500',
    { url: expected.finalUrl, options: { label: 'PSN test page', attempts: 1 } },
  ]);
});

test('logical PSN retry makes a fresh persistent reservation for every physical attempt', async () => {
  const calls = [];
  let attempt = 0;
  const result = await fetchPsnUsPageWithRetry('https://store.playstation.com/en-us/example', {
    reserve: () => {
      calls.push('reserve');
      return { waitMs: 1500 };
    },
    wait: async () => calls.push('wait'),
    fetchPage: async () => {
      calls.push('fetch');
      attempt += 1;
      if (attempt === 1) throw new Error('transient TLS reset');
      return { text: 'ok', finalUrl: 'https://store.playstation.com/en-us/example' };
    },
  });
  assert.equal(result.text, 'ok');
  assert.deepEqual(calls, ['reserve', 'wait', 'fetch', 'reserve', 'wait', 'fetch']);
});

test('scheduled retry consumes two private lease slots while tracked capacity stays fixed', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-run-retry-'));
  const budgetPath = path.join(directory, 'private-budget.json');
  const auditPath = path.join(directory, 'tracked-budget.json');
  const leasePath = path.join(directory, 'run-lease.json');
  const now = new Date('2026-07-22T13:00:00.000Z');
  const env = {
    PSN_US_RUN_LEASE_PATH: leasePath,
    PSN_US_RUN_LEASE_OWNER: LEASE_OWNER,
    PSN_US_RUN_LEASE_PURPOSE: 'calendar',
  };
  try {
    reservePsnUsRunBudget({
      budgetPath,
      auditPath,
      leasePath,
      requests: 2,
      now,
      leaseId: LEASE_ID,
      owner: LEASE_OWNER,
      purpose: 'calendar',
    });
    const trackedBefore = readFileSync(auditPath, 'utf8');
    const waits = [];
    let calls = 0;
    const response = await fetchPsnUsPageWithRetry('https://store.playstation.com/en-us/example', {
      reserve: () => reservePsnUsPageForCurrentRun({ env, now }),
      wait: async (milliseconds) => waits.push(milliseconds),
      fetchPage: async () => {
        calls++;
        if (calls === 1) throw new Error('transient edge reset');
        return { text: 'ok', finalUrl: 'https://store.playstation.com/en-us/example' };
      },
    });
    assert.equal(response.text, 'ok');
    assert.deepEqual(waits, [1500]);
    assert.equal(JSON.parse(readFileSync(leasePath, 'utf8')).consumed, 2);
    assert.equal(readFileSync(auditPath, 'utf8'), trackedBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('PSN full-run lock prevents scrape and verifier processes from overlapping', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-run-lock-'));
  const budgetPath = path.join(directory, 'budget.json');
  const moduleUrl = new URL('../lib/psn-request-budget.mjs', import.meta.url).href;
  const holderSource = `
    const { acquirePsnUsRequestRun } = await import(${JSON.stringify(moduleUrl)});
    const release = acquirePsnUsRequestRun({ budgetPath: ${JSON.stringify(budgetPath)} });
    process.send('locked');
    process.on('message', (message) => {
      if (message === 'release') { release(); process.exit(0); }
    });
  `;
  const holder = spawn(process.execPath, ['--input-type=module', '-e', holderSource], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  try {
    const ready = await Promise.race([
      once(holder, 'message').then(([message]) => message),
      once(holder, 'exit').then(([code]) => { throw new Error(`PSN lock holder exited early (${code})`); }),
    ]);
    assert.equal(ready, 'locked');
    assert.throws(() => acquirePsnUsRequestRun({ budgetPath }), { code: 'psn_us_run_locked' });

    const contenderSource = `
      const { acquirePsnUsRequestRun } = await import(${JSON.stringify(moduleUrl)});
      try {
        const release = acquirePsnUsRequestRun({ budgetPath: ${JSON.stringify(budgetPath)} });
        release();
        console.log('unexpected-acquire');
      } catch (error) {
        console.log(error.code);
      }
    `;
    const contender = spawnSync(process.execPath, ['--input-type=module', '-e', contenderSource], {
      encoding: 'utf8',
    });
    assert.equal(contender.status, 0, contender.stderr);
    assert.equal(contender.stdout.trim(), 'psn_us_run_locked');

    const exited = once(holder, 'exit');
    holder.send('release');
    assert.equal((await exited)[0], 0);
    const release = acquirePsnUsRequestRun({ budgetPath });
    release();
  } finally {
    if (holder.exitCode == null) holder.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});
