import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { sha256Digest } from '../lib/candidate-evidence.mjs';
import { validateNintendoAmericasEvidence } from '../lib/ns-candidates.mjs';
import {
  NINTENDO_US_PRODUCT_DAILY_LIMIT,
  NINTENDO_US_PRODUCT_MIN_INTERVAL_MS,
  consumeNintendoUsProductPageBudget,
  createNintendoUsBudgetLedger,
  evaluateNintendoUsProductPage,
  nintendoUsProductPageCandidates,
  parseNintendoUsStoreSitemap,
} from '../lib/nintendo-us-discovery.mjs';
import {
  acquireNintendoUsDiscoveryRun,
  discoverAmericasOfficial,
  reserveNintendoUsProductPage,
} from '../discover-nsuid.mjs';

const html = readFileSync(new URL('./fixtures/nintendo-us-product-page.html', import.meta.url), 'utf8');
const marioUrl = 'https://www.nintendo.com/us/store/products/super-mario-odyssey-switch/';
const mario = {
  slug: 'super-mario-odyssey',
  title: 'Super Mario Odyssey',
  platforms: ['switch'],
};

test('current-product parser binds terminal path, title, 7001 identity, generation and release', () => {
  const parsed = evaluateNintendoUsProductPage({ text: html, requestedUrl: marioUrl, finalUrl: marioUrl }, {
    ...mario,
    now: new Date('2026-07-18T00:00:00.000Z'),
  });
  assert.equal(parsed.status, 'matched');
  assert.deepEqual(parsed.candidate, {
    source: 'next_data_analytics_product',
    nsuid: '70010000001130',
    matchedTitle: 'Super Mario Odyssey™',
    generation: 'HAC',
    releaseDate: '2017-10-27T00:00:00.000Z',
    productSlug: 'super-mario-odyssey-switch',
    sourceUrl: marioUrl,
    finalUrl: marioUrl,
    releasedAt: '2017-10-27T00:00:00.000Z',
  });

  assert.equal(evaluateNintendoUsProductPage({
    text: html,
    requestedUrl: marioUrl,
    finalUrl: 'https://www.nintendo.com/us/store/games/',
  }, mario).reason, 'final_product_path_mismatch');
  assert.equal(evaluateNintendoUsProductPage({ text: html, requestedUrl: marioUrl, finalUrl: marioUrl }, {
    ...mario,
    title: 'Super Mario Galaxy',
  }).reason, 'next_data_title_mismatch');
  assert.equal(evaluateNintendoUsProductPage({ text: html, requestedUrl: marioUrl, finalUrl: marioUrl }, {
    ...mario,
    title: 'Super Mario Odyssey Nintendo Switch Edition',
  }).reason, 'next_data_title_mismatch', 'machine identity does not allow edition-suffix title tolerance');
  assert.equal(evaluateNintendoUsProductPage({
    text: html,
    requestedUrl: marioUrl,
    finalUrl: marioUrl.replace('https:', 'http:'),
  }, mario).reason, 'final_product_path_mismatch');
  assert.equal(evaluateNintendoUsProductPage({ text: html, requestedUrl: marioUrl, finalUrl: marioUrl }, {
    ...mario,
    platforms: ['switch-2'],
  }).reason, 'generation_mismatch');
  const addOn = html.replaceAll('70010000001130', '70050000001130');
  assert.equal(evaluateNintendoUsProductPage({ text: addOn, requestedUrl: marioUrl, finalUrl: marioUrl }, mario).reason,
    'next_data_not_base_game');
});

test('JSON-LD fallback requires exact title + URL and conflicts with analytics fail closed', () => {
  const jsonLdOnly = html.replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/u, '');
  const noMansSkyUrl = 'https://www.nintendo.com/us/store/products/no-mans-sky-switch/';
  const fallback = evaluateNintendoUsProductPage({
    text: jsonLdOnly,
    requestedUrl: noMansSkyUrl,
    finalUrl: noMansSkyUrl,
  }, {
    title: "No Man's Sky",
    platforms: ['switch'],
    now: new Date('2026-07-18T00:00:00.000Z'),
  });
  assert.equal(fallback.status, 'matched');
  assert.equal(fallback.candidate.nsuid, '70010000044642');

  const conflict = html
    .replaceAll('No Man\'s Sky', 'Super Mario Odyssey')
    .replaceAll('no-mans-sky-switch', 'super-mario-odyssey-switch');
  assert.equal(evaluateNintendoUsProductPage({ text: conflict, requestedUrl: marioUrl, finalUrl: marioUrl }, mario).reason,
    'current_product_evidence_conflict');
});

test('official sitemap locates exact canonical product URLs and never returns an absent guess', () => {
  const sitemap = parseNintendoUsStoreSitemap(`<?xml version="1.0"?>
    <urlset>
      <url><loc>${marioUrl}</loc></url>
      <url><loc>https://www.nintendo.com/us/store/products/balatro-switch-2/</loc></url>
      <url><loc>https://example.com/us/store/products/fake-switch/</loc></url>
    </urlset>`);
  assert.deepEqual(nintendoUsProductPageCandidates(mario, sitemap), [{
    productSlug: 'super-mario-odyssey-switch',
    url: marioUrl,
    locatedBy: 'official_sitemap_exact_slug',
  }]);
  assert.deepEqual(nintendoUsProductPageCandidates({
    slug: 'missing', title: 'Missing', platforms: ['switch'],
  }, sitemap), []);
  assert.deepEqual(nintendoUsProductPageCandidates({
    ...mario,
    nintendoUsSlugHint: 'not-in-sitemap-switch',
  }, sitemap), [], 'even an audited hint cannot bypass the official sitemap');
});

test('daily product-page budget is UTC-persistent, consumes failures up front and caps at 100', () => {
  assert.equal(NINTENDO_US_PRODUCT_MIN_INTERVAL_MS, 1500);
  let ledger = createNintendoUsBudgetLedger();
  for (let index = 0; index < NINTENDO_US_PRODUCT_DAILY_LIMIT; index += 1) {
    ledger = consumeNintendoUsProductPageBudget(ledger, {
      now: new Date('2026-07-18T12:00:00.000Z'),
    }).ledger;
  }
  assert.throws(() => consumeNintendoUsProductPageBudget(ledger, {
    now: new Date('2026-07-18T23:59:59.000Z'),
  }), { code: 'nintendo_us_daily_budget_exhausted' });
  assert.equal(consumeNintendoUsProductPageBudget(ledger, {
    now: new Date('2026-07-19T00:00:00.000Z'),
  }).used, 1);

  let concurrent = createNintendoUsBudgetLedger();
  const first = consumeNintendoUsProductPageBudget(concurrent, {
    now: new Date('2026-07-18T00:00:00.000Z'),
  });
  concurrent = first.ledger;
  const second = consumeNintendoUsProductPageBudget(concurrent, {
    now: new Date('2026-07-18T00:00:00.000Z'),
  });
  assert.equal(first.waitMs, 0);
  assert.equal(second.waitMs, 1500, 'persistent reservations serialize concurrent processes');

  const directory = mkdtempSync(path.join(tmpdir(), 'nintendo-us-budget-'));
  try {
    const budgetPath = path.join(directory, 'budget.json');
    reserveNintendoUsProductPage({ budgetPath, now: new Date('2026-07-18T00:00:00.000Z') });
    reserveNintendoUsProductPage({ budgetPath, now: new Date('2026-07-18T01:00:00.000Z') });
    const persisted = JSON.parse(readFileSync(budgetPath, 'utf8'));
    assert.equal(persisted.days['2026-07-18'].productPageRequests, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('budget lock rejects a live owner and safely recovers crash locks', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nintendo-us-lock-'));
  const budgetPath = path.join(directory, 'budget.json');
  const lockPath = `${budgetPath}.lock`;
  const now = new Date('2026-07-18T12:00:00.000Z');
  try {
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: 'live-owner',
      createdAt: now.toISOString(),
    })}\n`);
    assert.throws(() => reserveNintendoUsProductPage({ budgetPath, now }), {
      code: 'nintendo_us_budget_locked',
    });

    const old = new Date(now.valueOf() - 10 * 60_000);
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      token: 'expired-live-pid',
      createdAt: old.toISOString(),
    })}\n`);
    utimesSync(lockPath, old, old);
    assert.equal(
      reserveNintendoUsProductPage({ budgetPath, now }).used,
      1,
      'a bounded lease prevents PID reuse or a wedged owner from blocking forever',
    );

    writeFileSync(lockPath, '');
    utimesSync(lockPath, old, old);
    const reservation = reserveNintendoUsProductPage({ budgetPath, now });
    assert.equal(reservation.used, 2);

    const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.ok(Number.isSafeInteger(exited.pid));
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: 1,
      pid: exited.pid,
      token: 'exited-owner',
      createdAt: now.toISOString(),
    })}\n`);
    assert.equal(reserveNintendoUsProductPage({ budgetPath, now }).used, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a delayed discovery process blocks a second process from reordering page slots', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nintendo-us-run-lock-'));
  const lockPath = path.join(directory, 'discovery.run.lock');
  const moduleUrl = new URL('../discover-nsuid.mjs', import.meta.url).href;
  const holderSource = `
    const { acquireNintendoUsDiscoveryRun } = await import(${JSON.stringify(moduleUrl)});
    const release = acquireNintendoUsDiscoveryRun({ lockPath: ${JSON.stringify(lockPath)} });
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
      once(holder, 'exit').then(([code]) => { throw new Error(`run-lock holder exited early (${code})`); }),
    ]);
    assert.equal(ready, 'locked');
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.throws(() => acquireNintendoUsDiscoveryRun({ lockPath }), {
      code: 'nintendo_us_budget_locked',
    });
    const contenderSource = `
      const { acquireNintendoUsDiscoveryRun } = await import(${JSON.stringify(moduleUrl)});
      try {
        const release = acquireNintendoUsDiscoveryRun({ lockPath: ${JSON.stringify(lockPath)} });
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
    assert.equal(contender.stdout.trim(), 'nintendo_us_budget_locked');

    const exited = once(holder, 'exit');
    holder.send('release');
    assert.equal((await exited)[0], 0);
    const release = acquireNintendoUsDiscoveryRun({ lockPath });
    release();
  } finally {
    if (holder.exitCode == null) holder.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('US discoverer seals sitemap/page/terminal URL/price evidence and uses browser UA only for product HTML', async () => {
  const sitemap = new Map([['super-mario-odyssey-switch', marioUrl]]);
  const calls = [];
  const evidence = await discoverAmericasOfficial(mario, {
    collectedAt: '2026-07-18T00:00:00.000Z',
    sitemap,
    sitemapDigest: sha256Digest({ sitemap: 1 }),
    reserveProductPage: () => {
      calls.push('reserve');
      return { waitMs: 1500 };
    },
    waitForReservation: async (waitMs) => calls.push(`wait:${waitMs}`),
    fetchPage: async (url, options) => {
      calls.push({ kind: 'page', url, options });
      return { text: html, finalUrl: url };
    },
    fetchPrice: async (url, options) => {
      calls.push({ kind: 'price', url, options });
      return {
        prices: [{
          title_id: '70010000001130',
          sales_status: 'onsale',
          regular_price: { raw_value: '59.99', currency: 'USD' },
        }],
      };
    },
  });
  assert.equal(evidence.status, 'matched');
  assert.equal(evidence.requestedUrl, marioUrl);
  assert.equal(evidence.finalUrl, marioUrl);
  assert.match(evidence.pageSourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(evidence.sourceDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(validateNintendoAmericasEvidence(evidence, mario), evidence);
  assert.deepEqual(calls.slice(0, 2), ['reserve', 'wait:1500']);
  const pageCall = calls.find((call) => call?.kind === 'page');
  const priceCall = calls.find((call) => call?.kind === 'price');
  assert.equal(pageCall.options.attempts, 1, 'one budget reservation must permit exactly one product-page request');
  assert.match(pageCall.options.headers['User-Agent'], /^Mozilla\/5\.0/u);
  assert.equal(priceCall.options.headers, undefined, 'the browser UA exception must not leak to the price API');
});
