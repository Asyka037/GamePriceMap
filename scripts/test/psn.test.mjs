import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractPsnNextData,
  parsePsnNextData,
  parsePsnProductPage,
  psnProductUrl,
  validPsnProductId,
} from '../lib/psn.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/psn-product-pages.json', import.meta.url)));
const NOW = Date.parse('2026-07-18T00:00:00Z');

function env(cache, id) {
  return `<script id="env:${id}" type="application/json">${JSON.stringify({ cache })}</script>`;
}

function nextDataFor(sample) {
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
  for (const skuId of sample.skuIds) {
    ctaCache[`Sku:${skuId}`] = { id: skuId, __typename: 'Sku', name: 'Game' };
  }
  for (const cta of sample.ctas) {
    ctaCache[cta.cacheKey] = {
      id: cta.id,
      __typename: 'GameCTA',
      type: cta.type,
      local: { ctaType: cta.ctaType },
      action: {
        type: cta.actionType,
        param: [
          { name: 'skuId', value: cta.skuId },
          { name: 'rewardId', value: cta.rewardId },
        ],
      },
      meta: { upSellService: cta.upSellService, exclusive: cta.exclusive },
      price: cta.price,
    };
  }
  return {
    props: {
      pageProps: {
        locale: fixture.market,
        productId: sample.productId,
        batarangs: {
          classification: {
            text: env({
              [productRef]: {
                id: sample.productId,
                __typename: 'Product',
                name: sample.title,
                topCategory: 'GAME',
                storeDisplayClassification: 'FULL_GAME',
                edition: sample.edition,
                platforms: sample.platforms,
              },
            }, 'classification'),
          },
          info: {
            text: env({
              [productRef]: { id: sample.productId, __typename: 'Product', type: 'GAME' },
            }, 'info'),
          },
          cta: { text: env(ctaCache, 'cta') },
        },
      },
    },
  };
}

function htmlFor(sample) {
  const json = JSON.stringify(nextDataFor(sample)).replaceAll('<', '\\u003c');
  return `<!doctype html><script type="application/json" id="__NEXT_DATA__">${json}</script>`;
}

function parse(sampleName) {
  const sample = fixture.samples[sampleName];
  return parsePsnProductPage(htmlFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW);
}

test('PSN URL builder accepts an exact content id and enforces US-only POC', () => {
  const id = fixture.samples.publicSale.productId;
  assert.equal(validPsnProductId(id), true);
  assert.equal(psnProductUrl(id), fixture.samples.publicSale.sourceUrl);
  assert.equal(validPsnProductId('10002684'), false);
  assert.throws(() => psnProductUrl(id, 'ja-jp'), /en-us/);
  assert.throws(() => psnProductUrl('../wrong'), /Malformed/);
});

test('page parser reads the official public sale as native USD', () => {
  const parsed = parse('publicSale');
  assert.deepEqual(parsed.row, {
    cc: 'US', currency: 'USD', amount: 39.59, list: 59.99,
    discountPct: 34, saleEndsAt: '2026-07-30T06:59:00.000Z',
  });
  assert.equal(parsed.productId, fixture.samples.publicSale.productId);
  assert.equal(parsed.edition, 'standard');
  assert.deepEqual(parsed.platforms, ['ps5']);
  assert.equal(parsed.annotations.psPlus, null);
});

test('Plus member price remains annotation; public price alone enters the row', () => {
  const parsed = parse('plusAndPublicSale');
  assert.deepEqual(parsed.row, {
    cc: 'US', currency: 'USD', amount: 1.59, list: 3.99,
    discountPct: 60, saleEndsAt: '2026-07-30T06:59:00.000Z',
  });
  assert.deepEqual(parsed.annotations.psPlus, {
    currency: 'USD', amount: 1.19, list: 3.99, discountPct: 70,
    saleEndsAt: '2026-07-30T06:59:00.000Z',
    skuId: 'UP6989-PPSA16751_00-0731950739441726-U001',
  });
});

test('Plus price remains auditable even when its CTA shell looks like a cash purchase', () => {
  const sample = structuredClone(fixture.samples.plusAndPublicSale);
  Object.assign(sample.ctas[0], {
    type: 'ADD_TO_CART',
    actionType: 'ADD_TO_CART',
    ctaType: 'purchase',
    upSellService: 'NONE',
    exclusive: false,
    rewardId: 'OUTRIGHT',
  });
  const parsed = parsePsnNextData(nextDataFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW);
  assert.equal(parsed.row.amount, 1.59);
  assert.equal(parsed.annotations.psPlus.amount, 1.19);
});

test('a zero-price Plus trial is excluded while the public purchase survives', () => {
  const parsed = parse('trialAndPublicPrice');
  assert.deepEqual(parsed.row, {
    cc: 'US', currency: 'USD', amount: 69.99, list: null,
    discountPct: null, saleEndsAt: null,
  });
  assert.equal(parsed.annotations.psPlus, null);
  assert.equal(parsed.annotations.excludedTrials, 1);
});

test('parser fails closed on redirect, identity, edition, classification and offer drift', () => {
  const sample = fixture.samples.publicSale;
  const nextData = nextDataFor(sample);
  const mapping = {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  };
  assert.equal(parsePsnNextData(nextData, { ...mapping, finalUrl: null }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, finalUrl: 'https://store.playstation.com/en-us/' }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, finalUrl: `${sample.sourceUrl}?tracking=1` }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, finalUrl: `${sample.sourceUrl}#offer` }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, finalUrl: sample.sourceUrl.replace('https://', 'https://user@') }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, expectedTitle: 'ASTRO BOT 2' }, NOW), null);
  assert.equal(parsePsnNextData(nextData, { ...mapping, edition: 'deluxe' }, NOW), null);

  const wrongType = structuredClone(nextData);
  const infoText = wrongType.props.pageProps.batarangs.info.text;
  wrongType.props.pageProps.batarangs.info.text = infoText.replace('"type":"GAME"', '"type":"ADD_ON"');
  assert.equal(parsePsnNextData(wrongType, mapping, NOW), null);

  const conflictingEdition = structuredClone(nextData);
  conflictingEdition.props.pageProps.batarangs.deluxeConflict = {
    text: env({
      [`Product:${sample.productId}`]: {
        id: sample.productId,
        __typename: 'Product',
        topCategory: 'GAME',
        storeDisplayClassification: 'FULL_GAME',
        edition: { type: 'DELUXE', name: 'Digital Deluxe' },
      },
    }, 'deluxe-conflict'),
  };
  assert.equal(parsePsnNextData(conflictingEdition, mapping, NOW), null);

  const conflictingOffer = structuredClone(nextData);
  const duplicateCta = JSON.parse(conflictingOffer.props.pageProps.batarangs.cta.text.match(/>([\s\S]*)<\/script>/)[1]);
  const duplicateCtaKey = sample.ctas[0].cacheKey;
  duplicateCta.cache[duplicateCtaKey].price.discountedValue -= 100;
  conflictingOffer.props.pageProps.batarangs.ctaConflict = {
    text: env(duplicateCta.cache, 'cta-conflict'),
  };
  assert.equal(parsePsnNextData(conflictingOffer, mapping, NOW), null);

  const noPlatform = structuredClone(nextData);
  noPlatform.props.pageProps.batarangs.classification.text = noPlatform.props.pageProps.batarangs.classification.text
    .replace('"platforms":["PS5"]', '"platforms":[]');
  assert.equal(parsePsnNextData(noPlatform, mapping, NOW), null);

  const plusOnly = nextDataFor(fixture.samples.plusAndPublicSale);
  const ctaText = plusOnly.props.pageProps.batarangs.cta.text;
  const publicKey = fixture.samples.plusAndPublicSale.ctas[1].cacheKey;
  const doc = JSON.parse(ctaText.match(/>([\s\S]*)<\/script>/)[1]);
  doc.cache[`Product:${fixture.samples.plusAndPublicSale.productId}`].webctas = [
    { __ref: fixture.samples.plusAndPublicSale.ctas[0].cacheKey },
  ];
  delete doc.cache[publicKey];
  plusOnly.props.pageProps.batarangs.cta.text = env(doc.cache, 'cta-plus-only');
  assert.equal(parsePsnNextData(plusOnly, {
    productId: fixture.samples.plusAndPublicSale.productId,
    expectedTitle: fixture.samples.plusAndPublicSale.title,
    edition: 'standard',
    finalUrl: fixture.samples.plusAndPublicSale.sourceUrl,
  }, NOW), null);
});

test('title binding tolerates only a terminal PlayStation platform label', () => {
  const sample = structuredClone(fixture.samples.publicSale);
  sample.title = `${sample.title} PS4 & PS5`;
  const nextData = nextDataFor(sample);
  const mapping = {
    productId: sample.productId,
    expectedTitle: fixture.samples.publicSale.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  };
  assert.ok(parsePsnNextData(nextData, mapping, NOW));
  sample.title = `${fixture.samples.publicSale.title} Digital Deluxe`;
  assert.equal(parsePsnNextData(nextDataFor(sample), mapping, NOW), null);
});

test('only an eight-digit concept identity is retained; short refs are optional metadata', () => {
  const sample = structuredClone(fixture.samples.publicSale);
  sample.conceptId = '234567';
  const parsed = parsePsnNextData(nextDataFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW);
  assert.equal(parsed.conceptId, null);
  assert.deepEqual(parsed.platforms, ['ps5']);
});

test('bounded official variants allow a blank single-edition marker and null cash reward id', () => {
  const sample = structuredClone(fixture.samples.publicSale);
  sample.edition = { name: '' };
  sample.ctas[0].rewardId = null;
  assert.ok(parsePsnNextData(nextDataFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW));

  const experiment = structuredClone(sample);
  experiment.ctas[0].price.qualifications = [{
    type: 'USER_IN_EXPERIMENT', value: 'CrossChannel.IPT_PILOT._.1.1',
  }];
  assert.equal(parsePsnNextData(nextDataFor(experiment), {
    productId: experiment.productId,
    expectedTitle: experiment.title,
    edition: 'standard',
    finalUrl: experiment.sourceUrl,
  }, NOW), null, 'experiment-qualified price is not guaranteed public to everyone');
});

test('a live Base Game label without edition.type is standard, but other named editions fail closed', () => {
  const sample = structuredClone(fixture.samples.publicSale);
  sample.edition = { name: 'Base Game' };
  const accepted = parsePsnProductPage(htmlFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW);
  assert.equal(accepted?.productId, sample.productId);

  sample.edition = { name: 'Digital Deluxe Edition' };
  assert.equal(parsePsnProductPage(htmlFor(sample), {
    productId: sample.productId,
    expectedTitle: sample.title,
    edition: 'standard',
    finalUrl: sample.sourceUrl,
  }, NOW), null);
});

test('__NEXT_DATA__ extraction rejects malformed or missing JSON scripts', () => {
  assert.equal(extractPsnNextData('<html></html>'), null);
  assert.equal(extractPsnNextData('<script id="__NEXT_DATA__" type="application/json">{bad}</script>'), null);
  assert.ok(extractPsnNextData(htmlFor(fixture.samples.publicSale)));
});
