import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleRawSnapshot,
  sameObservations,
  enrichSnapshot,
  usObservation,
  DERIVED_REGION_FIELDS,
  singleMarketHistoryErrors,
  singleMarketSnapshotErrors,
} from '../lib/snapshot.mjs';

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

test('US-only platform snapshots require a catalog mapping and one native US row', () => {
  const snapshot = assembleRawSnapshot('g', [{ cc: 'US', currency: 'USD', amount: 19.99 }]);
  assert.deepEqual(singleMarketSnapshotErrors({
    channel: 'xbox', fileName: 'g.json', snapshot, hasMapping: true,
  }), []);
  assert.deepEqual(singleMarketSnapshotErrors({
    channel: 'xbox', fileName: 'orphan.json', snapshot, hasMapping: false,
  }), [
    'filename does not match slug g',
    'Xbox snapshot has no catalog product mapping',
  ]);
  const wrongRegion = assembleRawSnapshot('g', [{ cc: 'CA', currency: 'CAD', amount: 29.99 }]);
  assert.match(singleMarketSnapshotErrors({
    channel: 'psn', fileName: 'g.json', snapshot: wrongRegion, hasMapping: true,
  }).join('\n'), /exactly one US region/u);
});

test('US-only platform mappings require an isolated event and ATL', () => {
  const history = { events: [{ ch: 'xbox', cc: 'US', usd: 19.99 }], atl: { 'xbox-us': { usd: 19.99 } } };
  assert.deepEqual(singleMarketHistoryErrors({ channel: 'xbox', history, hasMapping: true }), []);
  assert.deepEqual(singleMarketHistoryErrors({ channel: 'xbox', history: {}, hasMapping: true }), [
    'Xbox mapping requires a public US history event',
    'Xbox mapping requires xbox-us ATL',
  ]);
  assert.deepEqual(singleMarketHistoryErrors({ channel: 'xbox', history: {}, hasMapping: false }), []);
});
