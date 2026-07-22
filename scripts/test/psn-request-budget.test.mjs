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
  createPsnUsBudgetLedger,
  fetchPsnUsPage,
  resolvePsnUsSharedBudgetPath,
  reservePsnUsPage,
} from '../lib/psn-request-budget.mjs';

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

test('PSN reservations persist before requests and recover an exited lock owner', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'psn-us-budget-'));
  const budgetPath = path.join(directory, 'budget.json');
  try {
    reservePsnUsPage({ budgetPath, now: new Date('2026-07-18T00:00:00.000Z') });
    reservePsnUsPage({ budgetPath, now: new Date('2026-07-18T01:00:00.000Z') });
    assert.equal(JSON.parse(readFileSync(budgetPath, 'utf8'))
      .days['2026-07-18'].pageRequests, 2);

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

test('weekly workflow checkpoints the consumed ledger before downstream gates', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/psn-weekly.yml', import.meta.url), 'utf8');
  const scrape = workflow.indexOf('Scrape PlayStation Store US POC');
  const checkpoint = workflow.indexOf('Checkpoint PSN request budget');
  const history = workflow.indexOf('Evolve price history');
  assert.ok(scrape >= 0 && checkpoint > scrape && history > checkpoint);
  assert.match(workflow, /always\(\).*steps\.scope\.outputs\.enabled/u);
  assert.match(workflow, /git add data\/seeds\/psn-us-request-budget\.json/u);
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
