import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestPriceNow, overallAtl, atlFor, isLive, buyWaitVerdict, regionGapBoard, atlBoard, hotDealsBoard, trackedDeals, fmtMoney,
} from '../../site/src/lib/derive.mjs';

const bundle = (over = {}) => ({
  slug: 'g',
  game: { title: 'G' },
  steam: { regions: [{ cc: 'UA', usd: 20, rank: 1 }, { cc: 'US', usd: 30, discountPct: 50, listUsd: 60, rank: 2 }] },
  eshop: { regions: [{ cc: 'ZA', usd: 11, rank: 1 }, { cc: 'US', usd: 35, discountPct: null, rank: 2 }] },
  history: { atl: { pc: { usd: 25, date: '2025-11-28', seed: 'cheapshark' } }, events: [] },
  meta: null,
  ...over,
});

test('bestPriceNow picks the cheaper US channel', () => {
  assert.deepEqual(bestPriceNow(bundle()), { usd: 30, channel: 'steam' });
});

test('verdict tiers: BUY at ATL, FAIR within 15%, WAIT beyond', () => {
  const atlHit = bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } });
  assert.equal(buyWaitVerdict(atlHit).verdict, 'BUY');
  const fair = bundle({ history: { atl: { pc: { usd: 27, seed: 'cheapshark' } }, events: [] } });
  assert.equal(buyWaitVerdict(fair).verdict, 'FAIR');
  assert.equal(buyWaitVerdict(bundle()).verdict, 'WAIT');
  assert.equal(buyWaitVerdict(bundle({ history: null })), null);
});

test('WAIT percentage means "ATL below today", never exceeds 100', () => {
  // best $30 vs ATL $15: below-today = 1 - 15/30 = 50% (not (30/15 - 1) = 100%)
  const b = bundle({ history: { atl: { pc: { usd: 15, seed: 'self' } }, events: [] } });
  assert.match(buyWaitVerdict(b).text, /50% below today/);
});

test('verdict wording distinguishes self-tracked vs seeded ATL (honesty)', () => {
  const self = bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } });
  assert.match(buyWaitVerdict(self).text, /lowest we have tracked/);
  const seeded = bundle({ history: { atl: { pc: { usd: 30, seed: 'cheapshark' } }, events: [] } });
  assert.match(buyWaitVerdict(seeded).text, /all-time low on record/);
});

test('regionGapBoard prefers eshop row, computes savings vs US', () => {
  const rows = regionGapBoard([bundle()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cc, 'ZA');
  assert.equal(rows[0].savePct, 69); // 1 - 11/35
  assert.equal(rows[0].channel, 'eshop');
});

test('atlBoard only includes games at their ATL', () => {
  assert.equal(atlBoard([bundle()]).length, 0);
  const at = bundle({ history: { atl: { pc: { usd: 30, date: '2026-07-08', seed: 'self' } }, events: [] } });
  assert.equal(atlBoard([at]).length, 1);
});

test('hotDealsBoard ranks by pct and trackedDeals flags ATL rows', () => {
  const rows = hotDealsBoard([bundle()]);
  assert.equal(rows[0].pct, 50);
  const deals = trackedDeals([bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } })], 'steam');
  assert.equal(deals.length, 1);
  assert.equal(deals[0].isAtl, true);
});

test('fmtMoney uses symbols and falls back to code suffix', () => {
  assert.equal(fmtMoney(19.99, 'USD'), '$19.99');
  assert.equal(fmtMoney(16.75, 'GBP'), '£16.75');
  assert.equal(fmtMoney(2300, 'JPY'), '¥2300');
  assert.equal(fmtMoney(179.99, 'ARS'), '179.99 ARS');
});

test('isLive: missing endsAt is live, past is dead, future is live', () => {
  assert.equal(isLive(null), true);
  assert.equal(isLive(undefined), true);
  assert.equal(isLive('2020-01-01T00:00:00Z'), false);
  assert.equal(isLive('2099-01-01T00:00:00Z'), true);
  assert.equal(isLive('garbage'), true, 'unparseable dates fail open');
});

test('atlFor never crosses channels (Celeste case)', () => {
  const history = { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 19.99, seed: 'self' } } };
  assert.equal(atlFor(history, 'steam').usd, 1.99);
  assert.equal(atlFor(history, 'eshop').usd, 19.99);
  assert.equal(atlFor(null, 'steam'), null);
});

test('trackedDeals drops expired sales and uses channel ATL for the badge', () => {
  const b = bundle({
    eshop: { regions: [{ cc: 'US', usd: 9.99, discountPct: 50, listUsd: 19.99, saleEndsAt: '2020-01-01T00:00:00Z' }] },
    history: { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 9.99, seed: 'self' } }, events: [] },
  });
  assert.equal(trackedDeals([b], 'eshop').length, 0, 'expired eshop sale excluded');
  const live = bundle({
    eshop: { regions: [{ cc: 'US', usd: 9.99, discountPct: 50, listUsd: 19.99, saleEndsAt: '2099-01-01T00:00:00Z' }] },
    history: { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 9.99, seed: 'self' } }, events: [] },
  });
  const rows = trackedDeals([live], 'eshop');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isAtl, true, 'ATL badge judged against eshop-us, not the $1.99 PC record');
});
