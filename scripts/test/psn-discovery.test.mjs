import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  discoverPsnMappings,
  parseDiscoverPsnArgs,
  psnSearchUrl,
} from '../discover-psn.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/psn-product-pages.json', import.meta.url)));
const SAMPLE = fixture.samples.publicSale;
const NOW = new Date('2026-07-18T00:00:00.000Z');

function env(cache, id) {
  return `<script id="env:${id}" type="application/json">${JSON.stringify({ cache })}</script>`;
}

function productHtml(sample = SAMPLE) {
  const productRef = `Product:${sample.productId}`;
  const product = {
    id: sample.productId,
    __typename: 'Product',
    invariantName: sample.title,
    name: sample.title,
    concept: { __ref: `Concept:${sample.conceptId}` },
    skus: sample.skuIds.map((id) => ({ __ref: `Sku:${id}` })),
    webctas: sample.ctas.map((cta) => ({ __ref: cta.cacheKey })),
  };
  const ctaCache = { [productRef]: product };
  for (const skuId of sample.skuIds) ctaCache[`Sku:${skuId}`] = { id: skuId, __typename: 'Sku', name: 'Game' };
  for (const cta of sample.ctas) {
    ctaCache[cta.cacheKey] = {
      id: cta.id,
      __typename: 'GameCTA',
      type: cta.type,
      local: { ctaType: cta.ctaType },
      action: {
        type: cta.actionType,
        param: [{ name: 'skuId', value: cta.skuId }, { name: 'rewardId', value: cta.rewardId }],
      },
      meta: { upSellService: cta.upSellService, exclusive: cta.exclusive },
      price: cta.price,
    };
  }
  const nextData = {
    props: {
      pageProps: {
        locale: 'en-us',
        productId: sample.productId,
        batarangs: {
          classification: { text: env({
            [productRef]: {
              id: sample.productId,
              __typename: 'Product',
              name: sample.title,
              topCategory: 'GAME',
              storeDisplayClassification: 'FULL_GAME',
              edition: sample.edition,
              platforms: sample.platforms,
            },
          }, 'classification') },
          info: { text: env({ [productRef]: { id: sample.productId, __typename: 'Product', type: 'GAME' } }, 'info') },
          cta: { text: env(ctaCache, 'cta') },
        },
      },
    },
  };
  return `<script type="application/json" id="__NEXT_DATA__">${JSON.stringify(nextData).replaceAll('<', '\\u003c')}</script>`;
}

function searchHtml({ title = SAMPLE.title, productId = SAMPLE.productId } = {}) {
  const telemetry = JSON.stringify({ id: productId, index: 0, name: title, searchTerm: title })
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;');
  return `<a data-track-content="web:store:product-tile" data-telemetry-meta="${telemetry}" href="/en-us/product/${productId}">${title}</a>`;
}

test('discover args and official search URL stay bounded', () => {
  assert.equal(psnSearchUrl('ASTRO BOT'), 'https://store.playstation.com/en-us/search/ASTRO%20BOT');
  assert.deepEqual(parseDiscoverPsnArgs(['--apply', '--max-items', '3', 'astro-bot']).slugs, ['astro-bot']);
  assert.throws(() => parseDiscoverPsnArgs(['--max-items', '21']), /at most 20/);
  assert.throws(() => parseDiscoverPsnArgs(['same', 'same']), /Duplicate/);
  assert.throws(() => parseDiscoverPsnArgs(['--output', 'data/catalog.json']), /Unknown option/);
});

test('official search is only a locator and one independently verified standard product is sealed', async () => {
  const searchUrl = psnSearchUrl(SAMPLE.title);
  const calls = [];
  const report = await discoverPsnMappings({
    entries: [{ slug: 'astro-bot', title: SAMPLE.title }],
    now: NOW,
    fetchPage: async (url, options) => {
      calls.push({ url, label: options.label });
      if (url === searchUrl) return { text: searchHtml(), finalUrl: searchUrl };
      if (url === SAMPLE.sourceUrl) return { text: productHtml(), finalUrl: SAMPLE.sourceUrl };
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(report.attempted, 1);
  assert.equal(report.failures.length, 0);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].psnProductId, SAMPLE.productId);
  assert.equal(report.candidates[0].evidence.discovery.sourceUrl, searchUrl);
  assert.deepEqual(calls.map(({ url }) => url), [searchUrl, SAMPLE.sourceUrl]);
});

test('search structure drift and product fingerprint failure remain auditable exceptions', async () => {
  const entry = { slug: 'astro-bot', title: SAMPLE.title };
  const searchUrl = psnSearchUrl(SAMPLE.title);
  const drift = await discoverPsnMappings({
    entries: [entry],
    now: NOW,
    fetchPage: async () => ({ text: '<main>changed</main>', finalUrl: searchUrl }),
  });
  assert.deepEqual(drift.failures, [{ slug: 'astro-bot', reason: 'search_identity_or_structure_failed' }]);

  const noOffer = await discoverPsnMappings({
    entries: [entry],
    now: NOW,
    fetchPage: async (url) => url === searchUrl
      ? { text: searchHtml(), finalUrl: searchUrl }
      : { text: '<script id="__NEXT_DATA__" type="application/json">{}</script>', finalUrl: SAMPLE.sourceUrl },
  });
  assert.deepEqual(noOffer.failures, [{ slug: 'astro-bot', reason: 'no_standard_public_paid_product' }]);
});
