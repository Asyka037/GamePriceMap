import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseXboxCalendarProduct,
  parseXboxComingSoonPage,
  xboxComingSoonPageUrl,
  xboxProductUrl,
} from '../lib/xbox-calendar.mjs';

const PAGE = fs.readFileSync(new URL('./fixtures/xbox-coming-soon-page.html', import.meta.url), 'utf8');
const BIG_ID = '9P0HWNX5QFQ9';
const TITLE = 'Club Soko';
const RELEASE = '2026-07-23T10:00:00.0000000Z';
const NOW = Date.parse('2026-07-22T00:00:00Z');

function directProduct() {
  return {
    ProductId: BIG_ID,
    ProductKind: 'Game',
    LocalizedProperties: [{
      Language: 'en',
      Markets: ['US'],
      ProductTitle: TITLE,
      Images: [
        {
          ImagePurpose: 'SuperHeroArt',
          Uri: '//store-images.s-microsoft.com/image/apps/fallback',
          Width: 1920,
          Height: 1080,
        },
        {
          ImagePurpose: 'TitledHeroArt',
          Uri: '//store-images.s-microsoft.com/image/apps/preferred',
          Width: 1920,
          Height: 1080,
        },
      ],
    }],
    MarketProperties: [{ Markets: ['US'], OriginalReleaseDate: RELEASE }],
    DisplaySkuAvailabilities: [{
      Sku: {
        SkuId: '0017',
        SkuType: 'full',
        LocalizedProperties: [{ Language: 'en', Markets: ['US'], SkuTitle: TITLE }],
        MarketProperties: [{ Markets: ['US'], FirstAvailableDate: RELEASE }],
        Properties: {
          IsTrial: false,
          IsBundle: false,
          IsPreOrder: true,
          Packages: [{ PlatformDependencies: [{ PlatformName: 'Windows.Xbox' }] }],
        },
      },
      Availabilities: [{
        Actions: ['Details', 'Purchase'],
        Markets: ['US'],
        Conditions: {
          ClientConditions: {
            AllowedPlatforms: [{ MinVersion: 0, MaxVersion: 2147483647, PlatformName: 'Windows.Xbox' }],
          },
          ResourceSetIds: ['1'],
          StartDate: '2026-07-01T00:00:00Z',
          EndDate: '2026-07-23T10:00:00Z',
        },
        OrderManagementData: { GrantedEntitlementKeys: [], Price: { CurrencyCode: 'USD', ListPrice: 0 } },
      }],
    }],
  };
}

function parseProduct(product = directProduct(), overrides = {}) {
  return parseXboxCalendarProduct(product, {
    card: { bigId: BIG_ID, title: TITLE },
    now: NOW,
    slugIfTracked: 'club-soko',
    ...overrides,
  });
}

test('coming-soon parser binds the exact requested page, range and marked cards', () => {
  const parsed = parseXboxComingSoonPage(PAGE, {
    finalUrl: xboxComingSoonPageUrl(50),
    expectedSkip: 50,
  });
  assert.deepEqual({
    start: parsed.start,
    end: parsed.end,
    total: parsed.total,
    pageNumber: parsed.pageNumber,
    pageCount: parsed.pageCount,
    nextSkip: parsed.nextSkip,
  }, {
    start: 51,
    end: 52,
    total: 52,
    pageNumber: 2,
    pageCount: 2,
    nextSkip: null,
  });
  assert.deepEqual(parsed.cards, [
    {
      bigId: BIG_ID,
      title: 'Club Soko',
      position: 0,
      index: 50,
      url: xboxProductUrl(BIG_ID),
    },
    {
      bigId: '9ABC123DEF45',
      title: 'Cats & Robots',
      position: 1,
      index: 51,
      url: xboxProductUrl('9ABC123DEF45'),
    },
  ]);
});

test('page parser rejects locale drift, page mismatch, changed totals and incomplete cards', () => {
  assert.throws(() => parseXboxComingSoonPage(PAGE, {
    finalUrl: 'https://www.microsoft.com/en-gb/store/coming-soon/games/xbox?skipitems=50',
    expectedSkip: 50,
  }), /exact US category URL/u);
  assert.throws(() => parseXboxComingSoonPage(PAGE, {
    finalUrl: xboxComingSoonPageUrl(0),
    expectedSkip: 0,
  }), /requested page/u);
  assert.throws(() => parseXboxComingSoonPage(PAGE, {
    finalUrl: xboxComingSoonPageUrl(50),
    expectedSkip: 50,
    expectedTotal: 53,
  }), /total changed/u);
  assert.throws(() => parseXboxComingSoonPage(
    PAGE.replace('data-bi-carpos="1"', 'data-bi-carpos="2"'),
    { finalUrl: xboxComingSoonPageUrl(50), expectedSkip: 50 },
  ), /positions are not contiguous/u);
  assert.throws(() => parseXboxComingSoonPage(
    PAGE.replace('9abc123def45', '9p0hwnx5qfq9'),
    { finalUrl: xboxComingSoonPageUrl(50), expectedSkip: 50 },
  ), /repeats BigID/u);
});

test('contradictory visible ranges and malformed marked cards fail closed', () => {
  assert.throws(() => parseXboxComingSoonPage(
    PAGE.replace('</body>', '<p>Showing 1 - 2 of 2 items</p></body>'),
    { finalUrl: xboxComingSoonPageUrl(50), expectedSkip: 50 },
  ), /contradictory ranges/u);
  assert.throws(() => parseXboxComingSoonPage(
    PAGE.replace('data-bi-cT="Product Card"', 'data-bi-cT="Wrong"'),
    { finalUrl: xboxComingSoonPageUrl(50), expectedSkip: 50 },
  ), /invalid data-bi-ct/u);
});

test('direct base-game product becomes one Xbox-specific calendar entry', () => {
  const parsed = parseProduct();
  assert.equal(parsed.reason, null);
  assert.deepEqual(parsed.entry, {
    title: TITLE,
    date: '2026-07-23',
    month: '2026-07',
    platform: 'xbox',
    url: xboxProductUrl(BIG_ID),
    image: 'https://store-images.s-microsoft.com/image/apps/preferred',
    slugIfTracked: 'club-soko',
    xboxBigId: BIG_ID,
  });
});

test('bundle pre-orders are retained as an explicit unresolved reason', () => {
  const product = directProduct();
  product.DisplaySkuAvailabilities[0].Sku.Properties.IsBundle = true;
  assert.deepEqual(parseProduct(product), {
    entry: null,
    reason: 'bundle_requires_manual_resolution',
  });
});

test('product identity, playable SKU, public purchase and artwork all fail closed', () => {
  const cases = [
    ['not_game', (p) => { p.ProductKind = 'Durable'; }],
    ['listed_title_mismatch', (p) => { p.LocalizedProperties[0].ProductTitle = 'Club Soko Deluxe'; }],
    ['non_base_game_title', (p) => {
      p.LocalizedProperties[0].ProductTitle = 'Club Soko (DLC)';
      p.DisplaySkuAvailabilities[0].Sku.LocalizedProperties[0].SkuTitle = 'Club Soko (DLC)';
    }, { card: { bigId: BIG_ID, title: 'Club Soko (DLC)' } }],
    ['us_release_date_missing_or_invalid', (p) => { p.MarketProperties[0].OriginalReleaseDate = '9998-12-30T00:00:00Z'; }],
    ['no_full_preorder_sku', (p) => { p.DisplaySkuAvailabilities[0].Sku.Properties.IsTrial = true; }],
    ['xbox_package_missing', (p) => { p.DisplaySkuAvailabilities[0].Sku.Properties.Packages = []; }],
    ['sku_release_date_mismatch', (p) => { p.DisplaySkuAvailabilities[0].Sku.MarketProperties[0].FirstAvailableDate = '2026-07-24T10:00:00Z'; }],
    ['no_current_public_us_purchase', (p) => { p.DisplaySkuAvailabilities[0].Availabilities[0].Actions = ['License']; }],
    ['hero_image_missing_or_invalid', (p) => {
      for (const image of p.LocalizedProperties[0].Images) image.Uri = 'https://evil.example/image/art';
    }],
  ];
  for (const [reason, mutate, overrides] of cases) {
    const product = directProduct();
    mutate(product);
    assert.equal(parseProduct(product, overrides).reason, reason);
  }
});

test('product ID, US market uniqueness and current availability are hard gates', () => {
  const wrongId = directProduct();
  wrongId.ProductId = '9ABC123DEF45';
  assert.equal(parseProduct(wrongId).reason, 'product_id_mismatch');

  const duplicateMarket = directProduct();
  duplicateMarket.MarketProperties.push({ Markets: ['US'], OriginalReleaseDate: RELEASE });
  assert.equal(parseProduct(duplicateMarket).reason, 'us_release_date_missing_or_invalid');

  const futurePurchase = directProduct();
  futurePurchase.DisplaySkuAvailabilities[0].Availabilities[0].Conditions.StartDate = '2026-07-22T01:00:00Z';
  assert.equal(parseProduct(futurePurchase).reason, 'no_current_public_us_purchase');

  const membershipPurchase = directProduct();
  membershipPurchase.DisplaySkuAvailabilities[0].Availabilities[0].Conditions.ClientConditions.MembershipTier = 'XboxGamePass';
  assert.equal(parseProduct(membershipPurchase).reason, 'no_current_public_us_purchase');

  const opaqueCondition = directProduct();
  opaqueCondition.DisplaySkuAvailabilities[0].Availabilities[0].Conditions.Eligibility = { token: 'opaque' };
  assert.equal(parseProduct(opaqueCondition).reason, 'no_current_public_us_purchase');

  const entitlementPurchase = directProduct();
  entitlementPurchase.DisplaySkuAvailabilities[0].Availabilities[0].OrderManagementData.GrantedEntitlementKeys = ['GAMEPASS'];
  assert.equal(parseProduct(entitlementPurchase).reason, 'no_current_public_us_purchase');
});
