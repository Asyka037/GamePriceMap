import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PSN_PREORDER_CATEGORY_ID,
  assertCompletePsnPreorderCategoryPages,
  assertUniquePsnCalendarEntries,
  canonicalPsnCalendarTitle,
  parsePsnCalendarProductPage,
  parsePsnPreorderCategoryPage,
  psnPreorderCategoryUrl,
  releaseWithinWindow,
} from '../lib/psn-calendar.mjs';

const ID = 'UP6312-PPSA31381_00-0202050640964065';
const PREMIUM = 'UP6312-PPSA31381_00-0730774904492744';
const image = (role = 'SIXTEEN_BY_NINE_BANNER') => ({ __typename: 'Media', type: 'IMAGE', role, url: 'https://image.api.playstation.com/example.jpg' });
const script = (document, id = '__NEXT_DATA__') => `<script id="${id}" type="application/json">${JSON.stringify(document).replaceAll('<', '\\u003c')}</script>`;

function categoryHtml() {
  const products = [ID, PREMIUM];
  const state = {
    [`CategoryGrid:${PSN_PREORDER_CATEGORY_ID}:en-us:0:24`]: {
      id: PSN_PREORDER_CATEGORY_ID,
      sortedBy: { name: 'productReleaseDate', isAscending: false },
      pageInfo: { totalCount: 2, offset: 0, size: 24, isLast: true },
      products: products.map((id) => ({ __ref: `Product:${id}:en-us` })),
    },
    [`Product:${ID}:en-us`]: {
      id: ID, name: 'Fable Standard Edition', telemetryData: { interactLink: `PRODUCT:${ID}` },
      platforms: ['PS5'], storeDisplayClassification: 'FULL_GAME', skus: [{ type: 'PREORDER' }], media: [image()],
    },
    [`Product:${PREMIUM}:en-us`]: {
      id: PREMIUM, name: 'Fable Premium Edition', telemetryData: { interactLink: `PRODUCT:${PREMIUM}` },
      platforms: ['PS5'], storeDisplayClassification: 'PREMIUM_EDITION', skus: [{ type: 'PREORDER' }], media: [image()],
    },
  };
  return script({ props: { pageProps: { locale: 'en-us', categoryId: PSN_PREORDER_CATEGORY_ID, page: 1, statusCode: 200 }, apolloState: state } });
}

function productHtml({ conflictDate = false, wrongType = false } = {}) {
  const product = (fields) => ({ [`Product:${ID}`]: { __typename: 'Product', id: ID, name: 'Fable Standard Edition', ...fields } });
  const batarangs = {
    classification: { text: script({ cache: product({
      topCategory: 'GAME', storeDisplayClassification: 'FULL_GAME', platforms: ['PS5'], releaseDate: '2026-10-12T16:00:00Z', media: [image()],
    }) }, 'env:classification') },
    info: { text: script({ cache: product({
      type: wrongType ? 'ADD_ON' : 'GAME', platforms: ['PS5'], releaseDate: conflictDate ? '2026-10-13T16:00:00Z' : '2026-10-12T16:00:00Z',
    }) }, 'env:info') },
  };
  const next = { props: { pageProps: { locale: 'en-us', productId: ID, batarangs } } };
  return `${script(next)}<dd data-qa="gameInfo#releaseInformation#releaseDate-value">10/12/2026</dd>`;
}

test('PSN pre-order category parser keeps only exact full-game preorder products', () => {
  const parsed = parsePsnPreorderCategoryPage(categoryHtml(), { page: 1, finalUrl: psnPreorderCategoryUrl(1) });
  assert.equal(parsed.totalCount, 2);
  assert.equal(parsed.pageCount, 1);
  assert.deepEqual(parsed.rawProductIds, [ID, PREMIUM]);
  assert.deepEqual(parsed.candidates, [{
    productId: ID,
    rawTitle: 'Fable Standard Edition',
    title: 'Fable',
    platforms: ['ps5'],
    image: 'https://image.api.playstation.com/example.jpg',
    sourceUrl: `https://store.playstation.com/en-us/product/${ID}`,
  }]);
  assert.equal(parsePsnPreorderCategoryPage(categoryHtml(), { page: 2, finalUrl: psnPreorderCategoryUrl(2) }), null);
});

const rawProductId = (index) => `UP0001-PPSA${String(index).padStart(5, '0')}_00-${String(index).padStart(16, '0')}`;

function parsedCategoryPages() {
  const ids = Array.from({ length: 25 }, (_, index) => rawProductId(index + 1));
  return [
    {
      page: 1,
      pageCount: 2,
      totalCount: 25,
      rawCount: 24,
      rawProductIds: ids.slice(0, 24),
      candidates: [{ productId: ids[0] }],
    },
    {
      page: 2,
      pageCount: 2,
      totalCount: 25,
      rawCount: 1,
      rawProductIds: ids.slice(24),
      candidates: [{ productId: ids[24] }],
    },
  ];
}

test('PSN category pagination preserves every raw product id across pages', () => {
  const pages = parsedCategoryPages();
  const complete = assertCompletePsnPreorderCategoryPages(pages);
  assert.equal(complete.rawProductIds.length, 25);
  assert.deepEqual(complete.candidates, [pages[0].candidates[0], pages[1].candidates[0]]);
});

test('PSN category pagination fails closed on a cross-page duplicate', () => {
  const pages = parsedCategoryPages();
  pages[1].rawProductIds[0] = pages[0].rawProductIds[0];
  pages[1].candidates = [];
  assert.throws(
    () => assertCompletePsnPreorderCategoryPages(pages),
    /raw product ids are duplicated/u,
  );
});

test('PSN category pagination fails closed on a missing raw product id', () => {
  const pages = parsedCategoryPages();
  pages[1].rawProductIds = [];
  pages[1].rawCount = 0;
  assert.throws(
    () => assertCompletePsnPreorderCategoryPages(pages),
    /page 2 is incomplete/u,
  );
});

test('PSN calendar product page binds two independent fragments and visible date', () => {
  const [candidate] = parsePsnPreorderCategoryPage(categoryHtml(), { page: 1 }).candidates;
  const entry = parsePsnCalendarProductPage(productHtml(), candidate, { finalUrl: candidate.sourceUrl });
  assert.deepEqual(entry, {
    title: 'Fable', date: '2026-10-12', month: '2026-10', platform: 'psn',
    url: candidate.sourceUrl, image: 'https://image.api.playstation.com/example.jpg', productId: ID,
  });
  assert.equal(parsePsnCalendarProductPage(productHtml({ conflictDate: true }), candidate, { finalUrl: candidate.sourceUrl }), null);
  assert.equal(parsePsnCalendarProductPage(productHtml({ wrongType: true }), candidate, { finalUrl: candidate.sourceUrl }), null);
});

test('PSN title and six-month window stay conservative', () => {
  assert.equal(canonicalPsnCalendarTitle('Fable Standard Edition'), 'Fable');
  assert.equal(canonicalPsnCalendarTitle('Fable Premium Edition'), null);
  const now = Date.parse('2026-07-22T12:00:00Z');
  assert.equal(releaseWithinWindow('2026-07-22', { now }), true);
  assert.equal(releaseWithinWindow('2027-02-23', { now }), false);
});

test('PSN calendar refuses two product URLs for the same normalized title and day', () => {
  const base = { title: 'Fable', date: '2026-10-12', url: `https://store.playstation.com/en-us/product/${ID}` };
  assert.doesNotThrow(() => assertUniquePsnCalendarEntries([base]));
  assert.throws(() => assertUniquePsnCalendarEntries([
    base,
    { ...base, title: 'FABLE™', url: `https://store.playstation.com/en-us/product/${PREMIUM}` },
  ]), /identity is ambiguous/u);
});
