import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bestPriceNow, bestPriceFlags, overallAtl, atlFor, isLive, buyWaitVerdict, primaryRegionalSource, regionalPriceSources, regionalCardModel, regionalListingCards, popularRegionalCards, multiRegionalPriceSummary, regionGapBoard, atlBoard, hotDealsBoard, trackedDeals, fmtMoney, regionalPriceSummary,
} from '../../site/src/lib/derive.mjs';
import { gameBundle } from '../../site/src/lib/data.mjs';
import { regionalPriceModel } from '../../site/src/lib/regions.mjs';

const bundle = (over = {}) => ({
  slug: 'g',
  game: { title: 'G' },
  steam: { regions: [{ cc: 'UA', usd: 20, rank: 1 }, { cc: 'US', usd: 30, discountPct: 50, listUsd: 60, rank: 2 }] },
  eshop: { regions: [{ cc: 'ZA', usd: 11, rank: 1 }, { cc: 'US', usd: 35, discountPct: null, rank: 2 }] },
  xbox: null,
  history: { atl: { pc: { usd: 25, date: '2025-11-28', seed: 'cheapshark' } }, events: [] },
  meta: null,
  ...over,
});

test('bestPriceNow picks the cheaper US channel', () => {
  assert.deepEqual(bestPriceNow(bundle()), { usd: 30, channel: 'steam' });
});

test('BEST flags hide an all-store tie and include every partial low-price tie', () => {
  assert.deepEqual(bestPriceFlags([19.99, 19.99, 19.99]), [false, false, false]);
  assert.deepEqual(bestPriceFlags([19.99, 19.99, 29.99]), [true, true, false]);
  assert.deepEqual(bestPriceFlags([19.99, 29.99]), [true, false]);
  assert.deepEqual(bestPriceFlags([19.99]), [false]);
  assert.deepEqual(bestPriceFlags([19.99, 19.994, 29.99]), [true, true, false], 'half-cent rounding noise stays tied');
});

test('Xbox joins current-price and channel-specific ATL derivations', () => {
  const b = bundle({
    xbox: { regions: [{ cc: 'US', usd: 20, discountPct: 60, rank: 1 }] },
    history: { atl: { 'xbox-us': { usd: 20, seed: 'self' } }, events: [] },
  });
  assert.deepEqual(bestPriceNow(b), { usd: 20, channel: 'xbox' });
  assert.equal(atlFor(b.history, 'xbox').usd, 20);
  assert.equal(hotDealsBoard([b])[0].channel, 'xbox');
});

test('verdict tiers: BUY at ATL, FAIR within 15%, WAIT beyond', () => {
  const atlHit = bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } });
  assert.equal(buyWaitVerdict(atlHit).verdict, 'BUY');
  const fair = bundle({ history: { atl: { pc: { usd: 27, seed: 'cheapshark' } }, events: [] } });
  assert.equal(buyWaitVerdict(fair).verdict, 'FAIR');
  assert.equal(buyWaitVerdict(bundle()).verdict, 'WAIT');
  assert.equal(buyWaitVerdict(bundle({ history: null })), null);
});

test('WAIT percentage means "ATL below today", never exceeds 100', () => {
  // best $30 vs ATL $15: below-today = 1 - 15/30 = 50% (not (30/15 - 1) = 100%)
  const b = bundle({ history: { atl: { pc: { usd: 15, seed: 'self' } }, events: [] } });
  assert.match(buyWaitVerdict(b).text, /50% below today/);
});

test('verdict wording distinguishes self-tracked vs seeded ATL (honesty)', () => {
  const self = bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } });
  assert.match(buyWaitVerdict(self).text, /lowest we have tracked/);
  const seeded = bundle({ history: { atl: { pc: { usd: 30, seed: 'cheapshark' } }, events: [] } });
  assert.match(buyWaitVerdict(seeded).text, /all-time low on record/);
});

test('primary regional source defaults to Steam and allows a valid catalog override', () => {
  assert.equal(primaryRegionalSource(bundle()).key, 'steam');
  assert.equal(primaryRegionalSource(bundle({ game: { title: 'G', primaryRegionalChannel: 'eshop' } })).key, 'eshop');
  assert.equal(primaryRegionalSource(bundle({ steam: null })).key, 'eshop');
  assert.equal(primaryRegionalSource(bundle({ steam: null, eshop: null })), null);
});

test('regionalPriceSources returns multi-region Steam then eShop and excludes Xbox', () => {
  const sources = regionalPriceSources(bundle({
    xbox: { regions: [{ cc: 'US', usd: 20 }, { cc: 'JP', usd: 18 }] },
  }));
  assert.deepEqual(sources.map(({ key, label }) => ({ key, label })), [
    { key: 'steam', label: 'Steam' },
    { key: 'eshop', label: 'Nintendo eShop' },
  ]);
  const steamOnly = regionalPriceSources(bundle({
    eshop: { regions: [{ cc: 'US', usd: 35 }] },
    xbox: { regions: [{ cc: 'US', usd: 20 }, { cc: 'JP', usd: 18 }] },
  }));
  assert.deepEqual(steamOnly.map((source) => source.key), ['steam']);
});

test('regional card selects one whole store by its largest visible savings', () => {
  const card = regionalCardModel(bundle({
    steam: { regions: [{ cc: 'UA', usd: 20 }, { cc: 'CH', usd: 100 }] },
    eshop: { regions: [{ cc: 'ZA', usd: 10 }, { cc: 'JP', usd: 40 }] },
  }));
  assert.equal(card.sourceKey, 'steam', '80% Steam savings beats the lower-starting 75% eShop set');
  assert.equal(card.cheapest.cc, 'UA');
  assert.equal(card.mostExpensive.cc, 'CH', 'maximum must stay on the selected Steam price set');
  assert.equal(card.savingsPct, 80, 'Save up to uses 1 − cheapest / most expensive');
});

test('regional listing membership stays platform-specific but display facts stay identical', () => {
  const tied = bundle({
    slug: 'tied',
    game: { title: 'Tied' },
    steam: { regions: [{ cc: 'US', usd: 10 }, { cc: 'CH', usd: 20 }] },
    eshop: { regions: [{ cc: 'US', usd: 10 }, { cc: 'JP', usd: 20 }] },
  });
  assert.equal(regionalListingCards([tied], 'steam')[0].sourceKey, 'steam');
  assert.equal(regionalListingCards([tied], 'eshop')[0].sourceKey, 'steam');
  assert.deepEqual(
    regionalListingCards([tied], 'steam')[0],
    regionalListingCards([tied], 'eshop')[0],
    'the current hub must never change a shared game card fact',
  );

  const steamOnly = bundle({ slug: 'steam-only', game: { title: 'Steam only' }, eshop: null });
  assert.equal(regionalListingCards([steamOnly], 'steam').length, 1);
  assert.equal(regionalListingCards([steamOnly], 'eshop').length, 0);

  const alpha = { ...tied, slug: 'alpha', game: { title: 'Alpha' } };
  const wider = bundle({
    slug: 'wider',
    game: { title: 'Wider' },
    steam: { regions: [{ cc: 'UA', usd: 5 }, { cc: 'CH', usd: 20 }] },
    eshop: null,
  });
  assert.deepEqual(
    regionalListingCards([tied, alpha, wider], 'steam').map((card) => card.slug),
    ['wider', 'alpha', 'tied'],
    'cards sort by savings descending, then title',
  );
});

test('Nintendo regional listing puts Switch exclusives first and preserves savings order within each group', () => {
  const listingBundle = ({ slug, title, platforms, savingsMax }) => bundle({
    slug,
    game: {
      title,
      platforms,
      steamAppId: platforms.includes('pc') ? 123 : null,
      xboxBigId: platforms.includes('xbox') ? 'xbox-id' : null,
    },
    steam: platforms.includes('pc')
      ? { regions: [{ cc: 'US', usd: 20 }, { cc: 'CH', usd: 40 }] }
      : null,
    eshop: { regions: [{ cc: 'US', usd: 100 - savingsMax }, { cc: 'CH', usd: 100 }] },
  });

  const exclusiveLowerSaving = listingBundle({
    slug: 'exclusive-lower', title: 'Exclusive Lower', platforms: ['switch'], savingsMax: 20,
  });
  const exclusiveHigherSaving = listingBundle({
    slug: 'exclusive-higher', title: 'Exclusive Higher', platforms: ['switch'], savingsMax: 30,
  });
  const switchTwoExclusive = listingBundle({
    slug: 'switch-two-exclusive', title: 'Switch 2 Exclusive', platforms: ['switch-2'], savingsMax: 10,
  });
  const nintendoCrossGenerationExclusive = listingBundle({
    slug: 'nintendo-cross-generation', title: 'Nintendo Cross Generation', platforms: ['switch', 'switch-2'], savingsMax: 5,
  });
  const multiHigherSaving = listingBundle({
    slug: 'multi-higher', title: 'Multi Higher', platforms: ['pc', 'switch'], savingsMax: 90,
  });
  const multiLowerSaving = listingBundle({
    slug: 'multi-lower', title: 'Multi Lower', platforms: ['switch', 'xbox'], savingsMax: 70,
  });

  assert.deepEqual(
    regionalListingCards([
      multiLowerSaving, exclusiveLowerSaving, multiHigherSaving, exclusiveHigherSaving,
      switchTwoExclusive, nintendoCrossGenerationExclusive,
    ], 'eshop').map((card) => card.slug),
    [
      'exclusive-higher', 'exclusive-lower', 'switch-two-exclusive',
      'nintendo-cross-generation', 'multi-higher', 'multi-lower',
    ],
  );
});

test('homepage popular rows keep platform membership but use the shared display source', () => {
  const lower = bundle({ slug: 'lower', game: { title: 'Lower' }, meta: { headerImage: '/lower.jpg', reviewCount: 10 } });
  const higher = bundle({ slug: 'higher', game: { title: 'Higher' }, meta: { headerImage: '/higher.jpg', reviewCount: 20 } });
  const rows = popularRegionalCards([lower, higher], 'steam', 1);
  assert.deepEqual(rows.map((row) => row.slug), ['higher']);
  assert.equal(rows[0].sourceKey, 'eshop', 'the higher-saving eShop set owns facts even in the Steam member row');
  assert.deepEqual(popularRegionalCards([lower, higher], 'steam', 1, ['higher']).map((row) => row.slug), ['lower']);
});

test('multi-regional summary and card use the same max-savings storefront', () => {
  const sample = bundle({
    steam: { regions: [{ cc: 'UA', usd: 20.13 }, { cc: 'CH', usd: 86.04 }] },
    eshop: { regions: [{ cc: 'ZA', usd: 11 }, { cc: 'US', usd: 35 }] },
  });
  const sources = regionalPriceSources(sample);
  const summary = multiRegionalPriceSummary('Example Game', sources);
  const card = regionalCardModel(sample);
  assert.equal(summary.gameTitle, 'Example Game');
  assert.equal(summary.platformListLabel, 'Steam and Nintendo eShop');
  assert.equal(summary.sourceKey, 'steam');
  assert.equal(summary.cheapest.countryName, 'Ukraine');
  assert.equal(summary.cheapest.sourceKey, 'steam');
  assert.equal(summary.cheapest.sourceLabel, 'Steam');
  assert.equal(summary.mostExpensive.countryName, 'Switzerland');
  assert.equal(summary.mostExpensive.sourceKey, 'steam');
  assert.equal(summary.savingsPct, 77);
  assert.equal(summary.priceSpreadPct, 327);
  assert.equal(card.sourceKey, summary.sourceKey);
  assert.equal(card.cheapest.cc, summary.cheapest.cc);
  assert.equal(card.cheapest.usd, summary.cheapest.usd);
  assert.equal(card.mostExpensive.cc, summary.mostExpensive.cc);
  assert.equal(card.mostExpensive.usd, summary.mostExpensive.usd);
  assert.equal(card.savingsPct, summary.savingsPct);
  assert.equal('sourceIndex' in summary.cheapest, false);
  assert.equal(
    summary.text,
    'Compare Example Game Steam and Nintendo eShop prices globally. Cheapest: Ukraine ($20.13). Most expensive: Switzerland ($86.04). Save up to 77% across tracked stores and regions.',
  );
  assert.doesNotMatch(summary.text, / on (?:Steam|Nintendo eShop)/);
  const singleStore = multiRegionalPriceSummary('Example Game', sources.slice(0, 1));
  assert.match(singleStore.text, /Save up to \d+% via regional pricing\./);
  assert.doesNotMatch(singleStore.text, /across tracked stores/);
  assert.equal(multiRegionalPriceSummary('Empty', []), null);
});

test('Terraria card and detail summary stay on the same real max-savings source', () => {
  const terraria = gameBundle('terraria');
  const sources = regionalPriceSources(terraria);
  const card = regionalCardModel(terraria);
  const summary = multiRegionalPriceSummary(terraria.game.title, sources);
  const maxStoreSavings = Math.max(...sources.map((source) => regionalPriceModel(source.snapshot).savingsPct));

  assert.equal(card.savingsPct, maxStoreSavings);
  assert.equal(card.sourceKey, summary.sourceKey);
  assert.deepEqual(
    [card.cheapest.cc, card.cheapest.usd, card.mostExpensive.cc, card.mostExpensive.usd, card.savingsPct],
    [summary.cheapest.cc, summary.cheapest.usd, summary.mostExpensive.cc, summary.mostExpensive.usd, summary.savingsPct],
  );
});

test('regionGapBoard uses the same primary source and computes savings vs US', () => {
  const rows = regionGapBoard([bundle()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cc, 'UA');
  assert.equal(rows[0].savePct, 33); // 1 - 20/30
  assert.equal(rows[0].channel, 'steam');
});

test('atlBoard only includes games at their ATL', () => {
  assert.equal(atlBoard([bundle()]).length, 0);
  const at = bundle({ history: { atl: { pc: { usd: 30, date: '2026-07-08', seed: 'self' } }, events: [] } });
  assert.equal(atlBoard([at]).length, 1);
});

test('hotDealsBoard ranks by pct and trackedDeals flags ATL rows', () => {
  const rows = hotDealsBoard([bundle()]);
  assert.equal(rows[0].pct, 50);
  const deals = trackedDeals([bundle({ history: { atl: { pc: { usd: 30, seed: 'self' } }, events: [] } })], 'steam');
  assert.equal(deals.length, 1);
  assert.equal(deals[0].isAtl, true);
});

test('fmtMoney uses unambiguous currency symbols and grouped local amounts', () => {
  assert.equal(fmtMoney(19.99, 'USD'), '$19.99');
  assert.equal(fmtMoney(16.75, 'GBP'), '£16.75');
  assert.equal(fmtMoney(2300, 'JPY'), '¥2,300');
  assert.equal(fmtMoney(66000, 'KRW'), '₩66,000');
  assert.equal(fmtMoney(79.99, 'CAD'), 'CA$79.99');
});

test('regional summary separates honest savings from the min-to-max price spread', () => {
  const summary = regionalPriceSummary('Baldur\'s Gate 3', 'Steam', {
    regions: [
      { cc: 'UA', usd: 20.13, amount: 899, currency: 'UAH', rank: 1 },
      { cc: 'US', usd: 59.99, amount: 59.99, currency: 'USD', rank: 2 },
      { cc: 'CH', usd: 86.04, amount: 69.99, currency: 'CHF', rank: 3 },
    ],
  });
  assert.equal(summary.savingsPct, 77, 'saving uses 1 − cheapest / most expensive and stays below 100%');
  assert.equal(summary.priceSpreadPct, 327, 'spread states how much higher the maximum is than the minimum');
  assert.equal(
    summary.text,
    "Compare Baldur's Gate 3 Steam prices globally. Cheapest: Ukraine ($20.13). Most expensive: Switzerland ($86.04). Save up to 77% via regional pricing.",
  );
  assert.doesNotMatch(summary.text, /highest-priced region/);
});

test('isLive: missing endsAt is live, past is dead, future is live', () => {
  assert.equal(isLive(null), true);
  assert.equal(isLive(undefined), true);
  assert.equal(isLive('2020-01-01T00:00:00Z'), false);
  assert.equal(isLive('2099-01-01T00:00:00Z'), true);
  assert.equal(isLive('garbage'), true, 'unparseable dates fail open');
});

test('atlFor never crosses channels (Celeste case)', () => {
  const history = { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 19.99, seed: 'self' } } };
  assert.equal(atlFor(history, 'steam').usd, 1.99);
  assert.equal(atlFor(history, 'eshop').usd, 19.99);
  assert.equal(atlFor(null, 'steam'), null);
});

test('trackedDeals drops expired sales and uses channel ATL for the badge', () => {
  const b = bundle({
    eshop: { regions: [{ cc: 'US', usd: 9.99, discountPct: 50, listUsd: 19.99, saleEndsAt: '2020-01-01T00:00:00Z' }] },
    history: { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 9.99, seed: 'self' } }, events: [] },
  });
  assert.equal(trackedDeals([b], 'eshop').length, 0, 'expired eshop sale excluded');
  const live = bundle({
    eshop: { regions: [{ cc: 'US', usd: 9.99, discountPct: 50, listUsd: 19.99, saleEndsAt: '2099-01-01T00:00:00Z' }] },
    history: { atl: { pc: { usd: 1.99, seed: 'cheapshark' }, 'eshop-us': { usd: 9.99, seed: 'self' } }, events: [] },
  });
  const rows = trackedDeals([live], 'eshop');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isAtl, true, 'ATL badge judged against eshop-us, not the $1.99 PC record');
});
