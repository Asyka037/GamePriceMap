import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRawSnapshot, sameObservations, enrichSnapshot, usObservation, DERIVED_REGION_FIELDS } from '../lib/snapshot.mjs';

const rows = [
  { cc: 'ua', currency: 'UAH', amount: 899, list: 1799, discountPct: 50, saleEndsAt: null },
  { cc: 'us', currency: 'USD', amount: 59.99, list: null, discountPct: null, saleEndsAt: null },
];

test('write guard: identical observations compare equal regardless of assembly order', () => {
  const a = assembleRawSnapshot('g', rows);
  const b = assembleRawSnapshot('g', [...rows].reverse());
  assert.ok(sameObservations(a, b), 'cc-sort makes order irrelevant');
  const changed = assembleRawSnapshot('g', [{ ...rows[0], amount: 900 }, rows[1]]);
  assert.ok(!sameObservations(a, changed));
});

test('lastPriceChangeAt is excluded from the semantic comparison', () => {
  const a = { ...assembleRawSnapshot('g', rows), lastPriceChangeAt: '2026-07-01' };
  const b = { ...assembleRawSnapshot('g', rows), lastPriceChangeAt: '2026-07-11' };
  assert.ok(sameObservations(a, b));
});

test('usObservation returns native-USD amount and rejects non-USD US rows', () => {
  const raw = assembleRawSnapshot('g', rows);
  assert.equal(usObservation(raw).usd, 59.99);
  const weird = assembleRawSnapshot('g', [{ cc: 'us', currency: 'CAD', amount: 79.99 }]);
  assert.equal(usObservation(weird), null);
});

test('enrichment drops regions with missing rates (validate makes that a hard failure upstream)', () => {
  const rich = enrichSnapshot(assembleRawSnapshot('g', rows), {});
  assert.deepEqual(rich.regions.map((r) => r.cc), ['US'], 'UAH has no rate → dropped at build');
});

test('persisted-snapshot denylist covers every v2.1 derived field', () => {
  assert.deepEqual(DERIVED_REGION_FIELDS, ['usd', 'listUsd', 'rank']);
});
