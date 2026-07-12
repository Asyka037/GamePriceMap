import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePriceOverview, toUsd, buildSnapshot, buildPriceUrl } from '../lib/steam.mjs';

const trFixture = JSON.parse(readFileSync(new URL('./fixtures/appdetails-tr.json', import.meta.url)));
const uaFixture = JSON.parse(readFileSync(new URL('./fixtures/appdetails-ua.json', import.meta.url)));

test('TR returns USD and currency is trusted, not inferred from country', () => {
  const p = parsePriceOverview(trFixture['1245620']);
  assert.equal(p.currency, 'USD');
  assert.equal(p.amount, 39.99);
  assert.equal(p.discountPct, null);
  assert.equal(p.list, null);
});

test('discounted entry exposes list price and pct, minor units divided by 100', () => {
  const p = parsePriceOverview(trFixture['1091500']);
  assert.equal(p.amount, 13.49);
  assert.equal(p.list, 44.99);
  assert.equal(p.discountPct, 70);
});

test('local currency entry parses and converts to USD via rates', () => {
  const p = parsePriceOverview(uaFixture['1245620']);
  assert.equal(p.currency, 'UAH');
  assert.equal(p.amount, 1799);
  const usd = toUsd(p.amount, 'UAH', { UAH: 44.5 });
  assert.equal(usd, 40.43);
});

test('USD passthrough needs no rate entry', () => {
  assert.equal(toUsd(39.99, 'USD', {}), 39.99);
});

test('unknown currency yields null instead of a wrong number', () => {
  assert.equal(toUsd(100, 'XXX', { UAH: 44.5 }), null);
});

test('missing price_overview (unreleased/region-locked) yields null', () => {
  assert.equal(parsePriceOverview({ success: true, data: {} }), null);
  assert.equal(parsePriceOverview({ success: false }), null);
  assert.equal(parsePriceOverview(undefined), null);
});

test('raw snapshot keeps local currency only, sorted by cc, no derived fields', () => {
  const snap = buildSnapshot('demo', {
    us: { currency: 'USD', amount: 59.99, list: null, discountPct: null },
    ua: { currency: 'UAH', amount: 899, list: 1799, discountPct: 50 },
  });
  assert.deepEqual(snap.regions.map((r) => r.cc), ['UA', 'US']);
  assert.ok(!('usd' in snap.regions[0]) && !('rank' in snap.regions[0]) && !('updatedAt' in snap));
  assert.equal(snap.regions[0].amount, 899);
});

test('regions without price are dropped from snapshot', () => {
  const snap = buildSnapshot('demo', { us: null, jp: { currency: 'JPY', amount: 100, list: null, discountPct: null } }, { JPY: 150 });
  assert.equal(snap.regions.length, 1);
  assert.equal(snap.regions[0].cc, 'JP');
});

test('price url batches appids with price_overview filter only', () => {
  const url = buildPriceUrl([1, 2, 3], 'tr');
  assert.match(url, /appids=1,2,3/);
  assert.match(url, /filters=price_overview$/);
});
