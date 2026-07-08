import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGameLookup, parseCheapestEver } from '../lib/cheapshark.mjs';
import { applySnapshot, seedAtl, emptyHistory } from '../lib/history.mjs';

const lookup = JSON.parse(readFileSync(new URL('./fixtures/cheapshark-lookup.json', import.meta.url)));
const batch = JSON.parse(readFileSync(new URL('./fixtures/cheapshark-batch.json', import.meta.url)));

test('cheapshark lookup picks exact steamAppID match', () => {
  assert.equal(parseGameLookup(lookup, 1245620), '236717');
  assert.equal(parseGameLookup(lookup, 999999), null);
  assert.equal(parseGameLookup({ not: 'array' }, 1), null);
});

test('cheapestPriceEver parses price and unix date', () => {
  const cpe = parseCheapestEver(batch, '236717');
  assert.equal(cpe.price, 29.95);
  assert.match(cpe.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(parseCheapestEver(batch, 'nope'), null);
});

test('zero-price giveaway history is not a purchasable ATL seed', () => {
  const body = { g1: { cheapestPriceEver: { price: '0.00', date: 1751353695 } } };
  assert.equal(parseCheapestEver(body, 'g1'), null);
});

function snap(usd, pct = null) {
  return { slug: 'g', regions: [{ cc: 'US', usd, discountPct: pct }] };
}
const opts = { channel: 'steam', atlKey: 'pc', today: '2026-07-08' };

test('first observation creates one event and self ATL', () => {
  const { history: h, changed } = applySnapshot(null, snap(59.99), opts);
  assert.equal(changed, true);
  assert.equal(h.events.length, 1);
  assert.deepEqual(h.atl.pc, { usd: 59.99, date: '2026-07-08', seed: 'self' });
});

test('unchanged price on rerun appends nothing (idempotent)', () => {
  const { history: h1 } = applySnapshot(null, snap(59.99), opts);
  const { history: h2, changed } = applySnapshot(h1, snap(59.99), opts);
  assert.equal(changed, false);
  assert.equal(h2.events.length, 1);
});

test('price drop appends event and lowers ATL', () => {
  const { history: h1 } = applySnapshot(null, snap(59.99), opts);
  const { history: h2 } = applySnapshot(h1, snap(29.99, 50), { ...opts, today: '2026-07-09' });
  assert.equal(h2.events.length, 2);
  assert.equal(h2.events[1].pct, 50);
  assert.equal(h2.atl.pc.usd, 29.99);
});

test('external seed only wins when lower; self observation can beat seed later', () => {
  let { history: h } = applySnapshot(null, snap(59.99), opts);
  ({ history: h } = seedAtl(h, 'pc', { price: 29.95, date: '2025-07-01', seed: 'cheapshark' }));
  assert.equal(h.atl.pc.seed, 'cheapshark');
  const worse = seedAtl(h, 'pc', { price: 49.99, date: '2024-01-01', seed: 'cheapshark' });
  assert.equal(worse.changed, false);
  ({ history: h } = applySnapshot(h, snap(19.99, 67), { ...opts, today: '2026-08-01' }));
  assert.equal(h.atl.pc.usd, 19.99);
  assert.equal(h.atl.pc.seed, 'self');
});

test('snapshot without US region is a no-op', () => {
  const { changed } = applySnapshot(emptyHistory('g'), { slug: 'g', regions: [{ cc: 'BR', usd: 10 }] }, opts);
  assert.equal(changed, false);
});
