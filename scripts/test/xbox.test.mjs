import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { xboxSuggestUrl, xboxProductsUrl, parseXboxSuggestion, parseXboxProduct } from '../lib/xbox.mjs';

const suggest = JSON.parse(readFileSync(new URL('./fixtures/xbox-autosuggest.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('./fixtures/xbox-product.json', import.meta.url)));

test('Xbox URLs encode discovery and enforce the 20-id batch ceiling', () => {
  const u = new URL(xboxSuggestUrl('Baldur\'s Gate 3'));
  assert.equal(u.searchParams.get('productFamilyNames'), 'Games');
  assert.equal(u.searchParams.get('query'), "Baldur's Gate 3");
  assert.equal(new URL(xboxProductsUrl(['9P3J32CTXLRZ'])).searchParams.get('market'), 'US');
  assert.throws(() => xboxProductsUrl(Array(21).fill('9P3J32CTXLRZ')), /1-20/);
});

test('autosuggest accepts one exact base game and rejects editions or ambiguity', () => {
  assert.deepEqual(parseXboxSuggestion(suggest, 'Elden Ring'), {
    bigId: '9P3J32CTXLRZ', matchedTitle: 'ELDEN RING', edition: 'standard',
  });
  assert.equal(parseXboxSuggestion(suggest, 'Elden Ring Shadow of the Erdtree'), null);
  const duplicate = structuredClone(suggest);
  duplicate.Results[0].Products.push({ ProductId: 'AAAAAAAAAAAA', Type: 'Game', Title: 'ELDEN RING' });
  assert.equal(parseXboxSuggestion(duplicate, 'Elden Ring'), null);
});

test('product parser ignores $0 licenses/trials and reads the paid standard offer', () => {
  const parsed = parseXboxProduct(product, {
    bigId: '9P3J32CTXLRZ', expectedTitle: 'Elden Ring', edition: 'standard',
  }, Date.parse('2026-07-12T00:00:00Z'));
  assert.deepEqual(parsed.row, {
    cc: 'US', currency: 'USD', amount: 41.99, list: 59.99,
    discountPct: 30, saleEndsAt: '2026-07-20T00:00:00.000Z',
  });
  assert.equal(parsed.skuId, '0010');
});

test('product parser fails closed on wrong title, edition, expired or non-Game products', () => {
  const mapping = { bigId: '9P3J32CTXLRZ', expectedTitle: 'Elden Ring', edition: 'standard' };
  assert.equal(parseXboxProduct(product, { ...mapping, expectedTitle: 'Elden Ring 2' }), null);
  assert.equal(parseXboxProduct(product, { ...mapping, edition: 'deluxe' }), null);
  assert.equal(parseXboxProduct(product, mapping, Date.parse('2026-08-01T00:00:00Z')), null);
  const app = structuredClone(product);
  app.Products[0].ProductKind = 'Application';
  assert.equal(parseXboxProduct(app, mapping), null);
});
