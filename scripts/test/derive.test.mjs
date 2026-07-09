import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestPriceNow, overallAtl, buyWaitVerdict, regionGapBoard, atlBoard, hotDealsBoard, trackedDeals, fmtMoney,
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
