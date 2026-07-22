import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardXboxCalendarReplacement, runXboxCalendarScrape } from '../scrape-xbox-calendar.mjs';
import { xboxComingSoonPageUrl } from '../lib/xbox-calendar.mjs';

const NOW = new Date('2026-07-22T00:00:00Z');
const DIRECT_ID = '9P0HWNX5QFQ9';
const BUNDLE_ID = '9ABC123DEF45';

function categoryPage() {
  return `<!doctype html>
  <html><body>
    <p>Showing 1 - 2 of 2 items</p>
    <div data-bi-hN="Games coming soon" data-bi-cT="Product Card" data-bi-compnm="Product Cards: Games" data-bi-pid="${DIRECT_ID}" data-bi-prdname="Club Soko" data-bi-carpos="0"></div>
    <div data-bi-hN="Games coming soon" data-bi-cT="Product Card" data-bi-compnm="Product Cards: Games" data-bi-pid="${BUNDLE_ID}" data-bi-prdname="Cats &amp; Robots" data-bi-carpos="1"></div>
  </body></html>`;
}

function product(bigId, title, { bundle = false } = {}) {
  const release = '2026-08-10T10:00:00Z';
  return {
    ProductId: bigId,
    ProductKind: 'Game',
    LocalizedProperties: [{
      Language: 'en',
      Markets: ['US'],
      ProductTitle: title,
      Images: [{
        ImagePurpose: 'TitledHeroArt',
        Uri: `//store-images.s-microsoft.com/image/apps/${bigId.toLowerCase()}`,
        Width: 1920,
        Height: 1080,
      }],
    }],
    MarketProperties: [{ Markets: ['US'], OriginalReleaseDate: release }],
    DisplaySkuAvailabilities: [{
      Sku: {
        SkuId: '0017',
        SkuType: 'full',
        LocalizedProperties: [{ Language: 'en', Markets: ['US'], SkuTitle: title }],
        MarketProperties: [{ Markets: ['US'], FirstAvailableDate: release }],
        Properties: {
          IsTrial: false,
          IsBundle: bundle,
          IsPreOrder: true,
          Packages: [{ PlatformDependencies: [{ PlatformName: 'Windows.Xbox' }] }],
        },
      },
      Availabilities: [{
        Actions: ['Purchase'],
        Markets: ['US'],
        Conditions: {
          ClientConditions: {
            AllowedPlatforms: [{ MinVersion: 0, MaxVersion: 2147483647, PlatformName: 'Windows.Xbox' }],
          },
          ResourceSetIds: ['1'],
          StartDate: '2026-07-01T00:00:00Z',
          EndDate: release,
        },
        OrderManagementData: { GrantedEntitlementKeys: [], Price: { CurrencyCode: 'USD', ListPrice: 29.99 } },
      }],
    }],
  };
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-calendar-scraper-'));
  fs.mkdirSync(path.join(root, 'data', 'feeds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'catalog.json'), JSON.stringify({
    games: [
      { slug: 'club-soko', title: 'A deliberately unrelated local title', xboxBigId: DIRECT_ID },
      { slug: 'same-title-but-unmapped', title: 'Club Soko' },
    ],
  }));
  return root;
}

function successfulDependencies(root, overrides = {}) {
  const health = [];
  const budgets = [];
  const requestedJsonUrls = [];
  return {
    root,
    now: NOW,
    categoryDelayMs: 0,
    catalogDelayMs: 0,
    sleepImpl: async () => {},
    setRequestBudgetImpl: (limit) => budgets.push(limit),
    recordSourceRunImpl: (source, state) => health.push({ source, ...state }),
    fetchTextImpl: async (url) => {
      assert.equal(url, xboxComingSoonPageUrl(0));
      return { text: categoryPage(), finalUrl: url };
    },
    fetchJsonImpl: async (url) => {
      requestedJsonUrls.push(url);
      assert.equal(new URL(url).origin, 'https://displaycatalog.mp.microsoft.com');
      assert.deepEqual(new URL(url).searchParams.get('bigIds').split(','), [DIRECT_ID, BUNDLE_ID]);
      return {
        Products: [
          product(DIRECT_ID, 'Club Soko'),
          product(BUNDLE_ID, 'Cats & Robots', { bundle: true }),
        ],
      };
    },
    ...overrides,
    health,
    budgets,
    requestedJsonUrls,
  };
}

test('complete Xbox sweep publishes only verified base games and joins catalog by exact BigID', async () => {
  const root = tempRoot();
  const dependencies = successfulDependencies(root);
  const result = await runXboxCalendarScrape(dependencies);
  assert.equal(result.complete, true);
  assert.equal(result.published, 1);
  assert.deepEqual(dependencies.budgets, [30]);
  assert.equal(dependencies.requestedJsonUrls.length, 1);
  assert.deepEqual(dependencies.health, [{
    source: 'calendar-xbox-us',
    ok: true,
    note: result.note,
  }]);

  const document = JSON.parse(fs.readFileSync(path.join(root, 'data', 'feeds', 'releases-xbox.json'), 'utf8'));
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.source, 'calendar-xbox-us');
  assert.equal(document.updatedAt, NOW.toISOString());
  assert.deepEqual(document.items, [{
    title: 'Club Soko',
    date: '2026-08-10',
    month: '2026-08',
    platform: 'xbox',
    url: `https://www.microsoft.com/en-us/p/_/${DIRECT_ID.toLowerCase()}`,
    image: `https://store-images.s-microsoft.com/image/apps/${DIRECT_ID.toLowerCase()}`,
    slugIfTracked: 'club-soko',
  }]);
  assert.match(result.note, /bundle_requires_manual_resolution=1/u);
});

test('incomplete Display Catalog batch keeps the previous cache byte-for-byte and records failure', async () => {
  const root = tempRoot();
  const output = path.join(root, 'data', 'feeds', 'releases-xbox.json');
  const previous = '{"sentinel":"last-good-cache"}\n';
  fs.writeFileSync(output, previous);
  const dependencies = successfulDependencies(root, {
    fetchJsonImpl: async () => ({ Products: [product(DIRECT_ID, 'Club Soko')] }),
  });

  const result = await runXboxCalendarScrape(dependencies);
  assert.equal(result.complete, false);
  assert.equal(result.published, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), previous);
  assert.deepEqual(dependencies.health, [{
    source: 'calendar-xbox-us',
    ok: false,
    note: result.note,
  }]);
  assert.match(result.note, /returned 1\/2 requested products/u);
});

test('category request failure also retains the sealed cache and does not query Display Catalog', async () => {
  const root = tempRoot();
  const output = path.join(root, 'data', 'feeds', 'releases-xbox.json');
  const previous = '{"sentinel":"category-fallback"}\n';
  fs.writeFileSync(output, previous);
  let jsonRequests = 0;
  const dependencies = successfulDependencies(root, {
    fetchTextImpl: async () => { throw new Error('simulated Microsoft outage'); },
    fetchJsonImpl: async () => { jsonRequests += 1; },
  });

  const result = await runXboxCalendarScrape(dependencies);
  assert.equal(result.complete, false);
  assert.equal(jsonRequests, 0);
  assert.equal(fs.readFileSync(output, 'utf8'), previous);
  assert.equal(dependencies.health[0].source, 'calendar-xbox-us');
  assert.equal(dependencies.health[0].ok, false);
});

test('replacement guard retains the old cache on product drift or a sudden collapse', () => {
  const previous = {
    schemaVersion: 1,
    source: 'calendar-xbox-us',
    items: [DIRECT_ID, BUNDLE_ID, '9AAA111BBB22', '9CCC333DDD44'].map((bigId, index) => ({
      title: `Previous ${index}`,
      date: `2026-08-${String(10 + index).padStart(2, '0')}`,
      url: `https://www.microsoft.com/en-us/p/_/${bigId.toLowerCase()}`,
    })),
  };
  const entries = [{
    title: 'Club Soko',
    date: '2026-08-10',
    url: `https://www.microsoft.com/en-us/p/_/${DIRECT_ID.toLowerCase()}`,
  }];
  assert.throws(() => guardXboxCalendarReplacement({
    previous,
    entries,
    cardIds: new Set([DIRECT_ID, BUNDLE_ID]),
    now: NOW,
  }), /no longer passes product guards/u);
  assert.throws(() => guardXboxCalendarReplacement({
    previous,
    entries,
    cardIds: new Set([DIRECT_ID]),
    now: NOW,
  }), /collapsed from 4 future entries to 1/u);
});
