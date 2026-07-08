import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePriceEntry, indexPricesById, ESHOP_REGIONS, filterOutlierRegions } from '../lib/eshop.mjs';
import { assembleSnapshot } from '../lib/snapshot.mjs';

const usBody = JSON.parse(readFileSync(new URL('./fixtures/eshop-price-us.json', import.meta.url)));
const gbBody = JSON.parse(readFileSync(new URL('./fixtures/eshop-price-gb-discount.json', import.meta.url)));

test('region set is 16 with valid groups', () => {
  assert.equal(ESHOP_REGIONS.length, 16);
  for (const r of ESHOP_REGIONS) assert.ok(['americas', 'europe', 'japan'].includes(r.group));
  assert.ok(!ESHOP_REGIONS.some((r) => ['KR', 'HK', 'RU'].includes(r.cc)), 'excluded regions must stay excluded');
});

test('normal price entry parses without discount fields', () => {
  const map = indexPricesById(usBody);
  const p = parsePriceEntry(map.get('70010000020840'));
  assert.equal(p.currency, 'USD');
  assert.equal(p.amount, 19.99);
  assert.equal(p.list, null);
  assert.equal(p.discountPct, null);
  assert.equal(p.saleEndsAt, null);
});

test('unknown nsuid is absent from prices[] and yields null', () => {
  const map = indexPricesById(usBody);
  assert.equal(map.get('99999999999999'), undefined);
  assert.equal(parsePriceEntry(undefined), null);
});

test('discounted entry exposes list, pct and sale end time', () => {
  const map = indexPricesById(gbBody);
  const p = parsePriceEntry(map.get('70070000027592'));
  assert.equal(p.currency, 'GBP');
  assert.equal(p.amount, 50.39);
  assert.equal(p.list, 125.99);
  assert.equal(p.discountPct, 60);
  assert.match(p.saleEndsAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('non-purchasable sales_status yields null', () => {
  assert.equal(parsePriceEntry({ sales_status: 'not_found' }), null);
  assert.equal(parsePriceEntry({ sales_status: 'sales_termination', regular_price: { raw_value: '9.99', currency: 'USD' } }), null);
});

test('hyperinflation-stale legacy price is dropped, sane cheap regions survive', () => {
  const mk = (cc, usd) => ({ cc, usd, rank: 0 });
  const snap = { slug: 'g', updatedAt: 'x', regions: [mk('AR', 0.12), mk('ZA', 11.36), mk('BR', 13), mk('US', 19.99), mk('GB', 21)] };
  const out = filterOutlierRegions(snap);
  assert.deepEqual(out.regions.map((r) => r.cc), ['ZA', 'BR', 'US', 'GB']);
  assert.equal(out.regions[0].rank, 1);
  const few = { slug: 'g', updatedAt: 'x', regions: [mk('AR', 0.12), mk('US', 19.99)] };
  assert.equal(filterOutlierRegions(few).regions.length, 2, 'too few points: no filtering');
});

test('eshop rows flow through shared snapshot assembler with saleEndsAt', () => {
  const rows = [
    { cc: 'gb', currency: 'GBP', amount: 50.39, list: 125.99, discountPct: 60, saleEndsAt: '2026-07-08T22:59:59Z' },
    { cc: 'us', currency: 'USD', amount: 59.99, list: null, discountPct: null, saleEndsAt: null },
  ];
  const snap = assembleSnapshot('demo', rows, { GBP: 0.8 }, new Date('2026-07-08T00:00:00Z'));
  assert.equal(snap.regions[0].cc, 'US');
  assert.equal(snap.regions[1].cc, 'GB');
  assert.equal(snap.regions[1].usd, 62.99);
  assert.equal(snap.regions[1].saleEndsAt, '2026-07-08T22:59:59Z');
});
