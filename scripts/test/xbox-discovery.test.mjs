import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverXboxMappings,
  parseDiscoverXboxArgs,
  selectXboxDiscoveryTargets,
} from '../discover-xbox.mjs';
import { createXboxStabilityLedger, validateXboxSuggestionDocument } from '../lib/xbox-mappings.mjs';

const NOW = new Date('2026-07-22T12:00:00.000Z');

function stability() {
  return createXboxStabilityLedger({
    generatedAt: NOW,
    successes: [
      { lastSuccessAt: '2026-07-12T03:05:22.573Z', expected: 14, changed: 14, unchanged: 0, failedProducts: 0, failedRequests: 0 },
      { lastSuccessAt: '2026-07-20T09:02:00.000Z', expected: 14, changed: 0, unchanged: 14, failedProducts: 0, failedRequests: 0 },
    ],
  });
}

function bigId(index) {
  return `A${String(index).padStart(11, '0')}`;
}

function autosuggest(title, id) {
  return { Results: [{ ProductFamilyName: 'Games', Products: [{ ProductId: id, Type: 'Game', Title: title }] }] };
}

function product(title, id, { action = 'Purchase', trial = false, bundle = false } = {}) {
  return {
    ProductId: id,
    ProductKind: 'Game',
    LocalizedProperties: [{ ProductTitle: title }],
    DisplaySkuAvailabilities: [{
      Sku: {
        SkuId: '0010',
        SkuType: 'full',
        LocalizedProperties: [{ SkuTitle: title }],
        Properties: { IsTrial: trial, IsBundle: bundle },
      },
      Availabilities: [{
        Actions: [action],
        Conditions: {
          ClientConditions: { AllowedPlatforms: [{ MinVersion: 0, MaxVersion: 2147483647, PlatformName: 'Windows.Xbox' }] },
          EndDate: '9998-12-30T00:00:00Z',
          ResourceSetIds: ['1'],
          StartDate: '2026-01-01T00:00:00Z',
        },
        OrderManagementData: { GrantedEntitlementKeys: [], Price: { CurrencyCode: 'USD', ListPrice: 19.99, MSRP: 19.99 } },
      }],
    }],
  };
}

test('Xbox discovery args and target selection allow at most 25 declared unmapped slugs', () => {
  assert.deepEqual(parseDiscoverXboxArgs(['--apply', '--max-items=2', 'one', 'two']), {
    apply: true, maxItems: 2, slugs: ['one', 'two'],
  });
  assert.throws(() => parseDiscoverXboxArgs(['--max-items', '26']), /1 to 25/u);
  assert.throws(() => parseDiscoverXboxArgs(['--output', 'data/catalog.json']), /Unknown option/u);
  assert.throws(() => parseDiscoverXboxArgs(['same', 'same']), /Duplicate/u);

  const catalog = { games: [
    { slug: 'ready', title: 'Ready', platforms: ['pc', 'xbox'], xboxBigId: null },
    { slug: 'pc-only', title: 'PC only', platforms: ['pc'], xboxBigId: null },
    { slug: 'mapped', title: 'Mapped', platforms: ['xbox'], xboxBigId: 'AAAAAAAAAAAA' },
  ] };
  assert.deepEqual(selectXboxDiscoveryTargets(catalog), [{ slug: 'ready', title: 'Ready' }]);
  assert.throws(() => selectXboxDiscoveryTargets(catalog, { slugs: ['pc-only'] }), /not declared/u);
  assert.throws(() => selectXboxDiscoveryTargets(catalog, { slugs: ['mapped'] }), /already mapped/u);
});

test('25 Xbox discoveries use 25 autosuggest requests and product chunks of 20 + 5', async () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({ slug: `game-${index + 1}`, title: `Game ${index + 1}` }));
  const idByTitle = new Map(entries.map((entry, index) => [entry.title, bigId(index + 1)]));
  const calls = [];
  const report = await discoverXboxMappings({
    entries,
    stabilityEvidence: stability(),
    now: NOW,
    requestDelayMs: 0,
    fetchJsonImpl: async (url) => {
      calls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/autosuggest')) {
        const title = parsed.searchParams.get('query');
        return autosuggest(title, idByTitle.get(title));
      }
      const ids = parsed.searchParams.get('bigIds').split(',');
      return { Products: ids.map((id) => {
        const index = Number(id.slice(1));
        return product(`Game ${index}`, id);
      }) };
    },
  });
  assert.equal(report.candidates.length, 25);
  assert.deepEqual(report.failures, []);
  const productCalls = calls.map((url) => new URL(url)).filter((url) => url.pathname.endsWith('/products'));
  assert.deepEqual(productCalls.map((url) => url.searchParams.get('bigIds').split(',').length), [20, 5]);
  assert.equal(calls.length, 27);
  assert.equal(validateXboxSuggestionDocument(report.document, { now: NOW.valueOf() }), report.document);
});

test('duplicate BigIDs and non-Purchase/trial products fail closed without candidates', async () => {
  const entries = [
    { slug: 'one', title: 'One' },
    { slug: 'two', title: 'Two' },
  ];
  const duplicate = await discoverXboxMappings({
    entries,
    stabilityEvidence: stability(),
    now: NOW,
    requestDelayMs: 0,
    fetchJsonImpl: async (url) => {
      const title = new URL(url).searchParams.get('query');
      return autosuggest(title, 'AAAAAAAAAAAA');
    },
  });
  assert.equal(duplicate.candidates.length, 0);
  assert.deepEqual(duplicate.failures.map(({ reason }) => reason), ['duplicate_big_id_in_batch', 'duplicate_big_id_in_batch']);

  const rejected = await discoverXboxMappings({
    entries: [{ slug: 'one', title: 'One' }],
    stabilityEvidence: stability(),
    now: NOW,
    requestDelayMs: 0,
    fetchJsonImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/autosuggest')) return autosuggest('One', 'AAAAAAAAAAAA');
      return { Products: [product('One', 'AAAAAAAAAAAA', { action: 'License', trial: true })] };
    },
  });
  assert.equal(rejected.candidates.length, 0);
  assert.deepEqual(rejected.failures, [{ slug: 'one', reason: 'product_standard_public_purchase_fingerprint_failed' }]);
});
