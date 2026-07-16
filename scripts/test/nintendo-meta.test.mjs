import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseNintendoMeta } from '../lib/nintendo-meta.mjs';

const html = readFileSync(new URL('./fixtures/nintendo-us-product-page.html', import.meta.url), 'utf8');
const input = {
  slug: 'super-mario-odyssey',
  title: 'Super Mario Odyssey',
  nsuid: '70010000001130',
  platforms: ['switch'],
  productSlug: 'super-mario-odyssey-switch',
  now: new Date('2026-07-16T00:00:00Z'),
};

test('Nintendo metadata binds the reviewed page, base NSUID, title and platform', () => {
  const meta = parseNintendoMeta(html, input);
  assert.equal(meta?.name, 'Super Mario Odyssey™');
  assert.equal(meta?.headerImage, 'https://assets.nintendo.com/image/upload/q_auto/f_auto/store/software/switch/70010000001130/hero');
  assert.deepEqual(meta?.genres, ['Action', 'Adventure']);
  assert.equal(meta?.releaseDate, '2017-10-27T00:00:00.000Z');
  assert.equal(meta?.comingSoon, false);
  assert.equal(meta?.storeUrl, 'https://www.nintendo.com/us/store/products/super-mario-odyssey-switch/');
  assert.equal(meta?.metaSource, 'nintendo-us');
});

test('Nintendo metadata fails closed on a different page, NSUID, title or generation', () => {
  assert.equal(parseNintendoMeta(html, { ...input, productSlug: 'wrong-switch' }), null);
  assert.equal(parseNintendoMeta(html, { ...input, nsuid: '70010000001131' }), null);
  assert.equal(parseNintendoMeta(html, { ...input, title: 'Super Mario Galaxy' }), null);
  assert.equal(parseNintendoMeta(html, { ...input, platforms: ['switch-2'] }), null);
});
