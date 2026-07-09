import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSteamSpecials, parseEpicFree, parseEuDiscounts, parseCheapSharkDeals, parseStores } from '../lib/feeds.mjs';

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const fc = fx('featuredcategories.json');
const epic = fx('epic-free.json');
const eu = fx('eu-discounts.json');
const csDeals = fx('cheapshark-deals.json');
const csStores = fx('cheapshark-stores.json');

test('steam specials parse with cents conversion and expiration', () => {
  const { deals } = parseSteamSpecials(fc, new Map([[1091500, 'cyberpunk-2077']]));
  assert.ok(deals.length > 0);
  const cp = deals.find((d) => d.steamAppId === 1091500);
  assert.equal(cp.price, 17.99);
  assert.equal(cp.list, 59.99);
  assert.equal(cp.pct, 70);
  assert.match(cp.endsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(cp.slugIfTracked, 'cyberpunk-2077');
});

test('epic free games: free-now with end date, upcoming distinguished, errors tolerated', () => {
  assert.ok(epic.errors?.length > 0, 'fixture must contain top-level errors to prove tolerance');
  const items = parseEpicFree(epic);
  const now = items.filter((i) => i.status === 'free-now');
  const upcoming = items.filter((i) => i.status === 'upcoming');
  assert.ok(now.length > 0);
  assert.ok(now[0].endsAt);
  assert.equal(now[0].price, 0);
  assert.ok(now[0].url.includes('epicgames.com'));
  assert.ok(upcoming.every((u) => u.status === 'upcoming'));
});

test('eu discounts parse GBP prices and integer pct', () => {
  const items = parseEuDiscounts(eu);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal(it.currency, 'GBP');
    assert.ok(it.price < it.list);
    assert.ok(Number.isInteger(it.pct) && it.pct > 0 && it.pct <= 100);
    assert.match(it.url, /^https:\/\/www\.nintendo\.co\.uk\//);
  }
});

test('cheapshark deals exclude giveaway zero prices and map store names', () => {
  const stores = parseStores(csStores);
  assert.equal(stores.get('1'), 'steam');
  const items = parseCheapSharkDeals(csDeals, stores);
  assert.ok(items.every((i) => i.price > 0), 'salePrice 0 giveaways must be excluded');
  assert.ok(csDeals.some((d) => Number.parseFloat(d.salePrice) === 0), 'fixture must contain a giveaway to prove exclusion');
  assert.ok(items.every((i) => !i.storeId.startsWith('store-') || i.storeId.length > 6));
});
