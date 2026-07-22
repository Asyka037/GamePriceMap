import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePsnSearchPage } from '../lib/psn-search.mjs';

const STANDARD = 'UP9000-PPSA99999_00-BALDURSGATE30000';
const SECOND_STANDARD = 'UP9000-PPSA99998_00-BALDURSGATE30000';
const DELUXE = 'UP9000-PPSA99997_00-BALDURSGATE3DLX0';
const DLC = 'UP9000-PPSA99996_00-BALDURSGATE3DLC0';
const FINAL_URL = 'https://store.playstation.com/en-us/search/baldur%27s%20gate%203';

function entities(value) {
  return JSON.stringify(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function tile({ id = STANDARD, name = "Baldur's Gate 3", index = 0, searchTerm = "baldur's gate 3", href } = {}) {
  const meta = entities({ id, name, index, searchTerm });
  return `<a class="psw-link" data-telemetry-meta="${meta}" href="${href ?? `/en-us/product/${id}`}" data-track-content="web:store:product-tile">${name}</a>`;
}

function parse(html, overrides = {}) {
  return parsePsnSearchPage(html, {
    expectedTitle: "Baldur's Gate 3",
    finalUrl: FINAL_URL,
    ...overrides,
  });
}

test('PSN search binds entity-decoded telemetry to the exact standard product tile', () => {
  const html = [
    tile({ id: DELUXE, name: "Baldur's Gate 3 - Digital Deluxe Edition", index: 0 }),
    tile({ id: DLC, name: "Baldur's Gate 3 - Dice Skin DLC", index: 1 }),
    tile({ index: 2 }),
  ].join('');
  assert.deepEqual(parse(html), [{
    productId: STANDARD,
    matchedTitle: "Baldur's Gate 3",
    index: 2,
    sourceUrl: `https://store.playstation.com/en-us/product/${STANDARD}`,
  }]);
});

test('title matching allows only the bounded terminal PS4/PS5 decoration', () => {
  assert.equal(parse(tile({ name: "Baldur's Gate 3 PS4 & PS5" })).length, 1);
  assert.deepEqual(parse(tile({ name: "Baldur's Gate 3 Deluxe PS5" })), []);
  assert.deepEqual(parse(tile({ name: "Baldur's Gate 3 Soundtrack" })), []);
});

test('duplicate exact cards collapse and multiple exact products sort deterministically', () => {
  const html = [
    tile({ id: SECOND_STANDARD, index: 4 }),
    tile({ id: STANDARD, index: '3' }),
    tile({ id: STANDARD, index: 7, name: "Baldur's Gate 3 PS5" }),
    tile({ id: SECOND_STANDARD, index: 3 }),
  ].join('');
  assert.deepEqual(parse(html).map(({ productId, index }) => ({ productId, index })), [
    { productId: SECOND_STANDARD, index: 3 },
    { productId: STANDARD, index: 3 },
  ]);
});

test('wrong terminal origin, locale, route, or search term fails closed', () => {
  const html = tile();
  assert.equal(parse(html, { finalUrl: "https://example.com/en-us/search/baldur's%20gate%203" }), null);
  assert.equal(parse(html, { finalUrl: "https://store.playstation.com/en-gb/search/baldur's%20gate%203" }), null);
  assert.equal(parse(html, { finalUrl: `https://store.playstation.com/en-us/product/${STANDARD}` }), null);
  assert.equal(parse(html, { finalUrl: 'https://store.playstation.com/en-us/search/elden%20ring' }), null);
  assert.equal(parse(html, { finalUrl: `${FINAL_URL}?tracking=1` }), null);
  assert.equal(parse(html, { finalUrl: `${FINAL_URL}#results` }), null);
  assert.equal(parse(html, { finalUrl: FINAL_URL.replace('https://', 'https://user@') }), null);
  assert.equal(parse(tile({ searchTerm: 'Elden Ring' })), null);
});

test('telemetry id and product href must identify the same valid US product', () => {
  assert.equal(parse(tile({ href: `/en-us/product/${SECOND_STANDARD}` })), null);
  assert.equal(parse(tile({ id: 'not-a-product' })), null);
  assert.equal(parse(tile({ href: `/en-gb/product/${STANDARD}` })), null);
  assert.equal(parse(tile({ href: `https://evil.example/en-us/product/${STANDARD}` })), null);
  assert.equal(parse(tile({ href: `/en-us/product/${STANDARD}?offer=wrong` })), null);
});

test('empty, malformed, duplicated, and malicious marked attributes fail closed', () => {
  assert.equal(parse(''), null);
  assert.equal(parse('<a data-track-content="web:store:product-tile"></a>'), null);
  assert.equal(parse(`<a data-track-content="web:store:product-tile" data-telemetry-meta="{}" href="/en-us/product/${STANDARD}"></a>`), null);
  assert.equal(parse(tile().replace(' data-track-content=', ' data-track-content="web:store:product-tile" data-track-content=')), null);
  assert.equal(parse(tile().replace('data-telemetry-meta="', 'data-telemetry-meta="&#xD800;')), null);
  assert.equal(parse(`${tile()}<a / data-track-content="web:store:product-tile"></a>`), null);
  assert.equal(parse(`<script>${tile()}</script>`), null, 'markup-like script text is not a product tile');
});

test('unrelated anchors are ignored but every marked tile must retain the official shape', () => {
  assert.equal(parse(`<a href="javascript:alert(1)">noise</a>${tile()}`).length, 1);
  assert.equal(parse(`${tile()}<a data-track-content="web:store:product-tile" href="javascript:alert(1)" data-telemetry-meta="{}">bad</a>`), null);
});
