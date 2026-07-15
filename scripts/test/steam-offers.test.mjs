import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildSteamOfferSnapshot,
  buildSteamPackageUrl,
  enrichSteamOffers,
  parseSteamPackageDetail,
  preserveFailedSteamOfferRows,
  sameSteamOfferObservations,
  sameSteamOfferPrices,
} from '../lib/steam-offers.mjs';
import { steamOffers } from '../../site/src/lib/data.mjs';

const edition = {
  packageId: 123,
  name: 'Demo Deluxe Edition',
  kind: 'edition',
  baseAppId: 10,
  includesBaseGame: true,
  expectedAppIds: [10, 11],
};

const response = {
  success: true,
  data: {
    apps: [{ id: 11 }, { id: 10 }],
    price: { currency: 'USD', initial: 7999, final: 5999, discount_percent: 25 },
  },
};

test('single-package URL carries exactly one package id and region', () => {
  assert.equal(
    buildSteamPackageUrl(123, 'jp'),
    'https://store.steampowered.com/api/packagedetails?packageids=123&cc=jp&l=english',
  );
});

test('official package price and discount parse from minor units', () => {
  assert.deepEqual(parseSteamPackageDetail(response, edition), {
    currency: 'USD', amount: 59.99, list: 79.99, discountPct: 25,
  });
});

test('edition fails closed when Steam adds an unexpected app', () => {
  const changed = structuredClone(response);
  changed.data.apps.push({ id: 999 });
  assert.throws(() => parseSteamPackageDetail(changed, edition), /contents changed/);
});

test('add-on package may expose no app list but cannot include the base app', () => {
  const addOn = { ...edition, kind: 'add-on', includesBaseGame: false, expectedAppIds: [] };
  const noApps = structuredClone(response);
  delete noApps.data.apps;
  assert.equal(parseSteamPackageDetail(noApps, addOn).amount, 59.99);
  assert.throws(() => parseSteamPackageDetail(response, addOn), /unexpectedly includes the base game/);
});

test('manually reviewed add-on fails closed if its name or requirement copy changes', () => {
  const addOn = {
    ...edition,
    kind: 'add-on',
    includesBaseGame: false,
    expectedAppIds: [],
    expectedStoreName: 'Demo Extras',
    requiredPageText: 'requires the base game',
  };
  const checked = structuredClone(response);
  checked.data.apps = [];
  checked.data.name = 'Demo Extras';
  checked.data.page_content = 'This content requires the base game.';
  assert.equal(parseSteamPackageDetail(checked, addOn).amount, 59.99);
  checked.data.name = 'Unrelated Bundle';
  assert.throws(() => parseSteamPackageDetail(checked, addOn), /store name changed/);
});

test('raw offer snapshots are sorted and contain no rank or USD derivations', () => {
  const raw = buildSteamOfferSnapshot('demo', [edition], new Map([
    [123, {
      us: { currency: 'USD', amount: 59.99, list: 79.99, discountPct: 25 },
      jp: { currency: 'JPY', amount: 7000, list: null, discountPct: null },
    }],
  ]));
  assert.deepEqual(raw.offers[0].regions.map((row) => row.cc), ['JP', 'US']);
  for (const row of raw.offers[0].regions) {
    assert.equal('usd' in row, false);
    assert.equal('listUsd' in row, false);
    assert.equal('rank' in row, false);
    assert.equal('vsUsPct' in row, false);
  }
});

test('build-time offer enrichment adds display USD only, never comparison semantics', () => {
  const raw = buildSteamOfferSnapshot('demo', [edition], {
    123: { jp: { currency: 'JPY', amount: 1500, list: 3000, discountPct: 50 } },
  });
  const enriched = enrichSteamOffers(raw, { JPY: 150 });
  assert.equal(enriched.offers[0].regions[0].usd, 10);
  assert.equal(enriched.offers[0].regions[0].listUsd, 20);
  assert.equal('rank' in enriched.offers[0].regions[0], false);
  assert.equal('vsUsPct' in enriched.offers[0].regions[0], false);
});

test('write guard ignores timestamps but detects price and catalog-semantic changes', () => {
  const raw = buildSteamOfferSnapshot('demo', [edition], {
    123: { us: { currency: 'USD', amount: 59.99, list: null, discountPct: null } },
  });
  assert.equal(sameSteamOfferObservations(raw, { ...raw, lastPriceChangeAt: '2099-01-01' }), true);
  const changed = structuredClone(raw);
  changed.offers[0].regions[0].amount = 60.99;
  assert.equal(sameSteamOfferObservations(raw, changed), false);
});

test('lastPriceChangeAt semantics ignore label-only edits but detect price edits', () => {
  const raw = buildSteamOfferSnapshot('demo', [edition], {
    123: { us: { currency: 'USD', amount: 59.99, list: null, discountPct: null } },
  });
  const relabeled = structuredClone(raw);
  relabeled.offers[0].name = 'Reviewed display label';
  assert.equal(sameSteamOfferObservations(raw, relabeled), false);
  assert.equal(sameSteamOfferPrices(raw, relabeled), true);
  relabeled.offers[0].regions[0].amount = 60.99;
  assert.equal(sameSteamOfferPrices(raw, relabeled), false);
});

test('failed regions preserve old rows while explicit unavailability removes them', () => {
  const previous = buildSteamOfferSnapshot('demo', [edition], {
    123: {
      jp: { currency: 'JPY', amount: 7000, list: null, discountPct: null },
      us: { currency: 'USD', amount: 59.99, list: null, discountPct: null },
    },
  });
  const current = new Map([[123, { us: null }]]); // JP failed (missing); US explicitly unavailable.
  const safe = preserveFailedSteamOfferRows([edition], current, previous, ['jp', 'us']);
  assert.equal(safe.get(123).jp.amount, 7000);
  assert.equal(safe.get(123).us, null);
});

test('offer display metadata joins at build time and never leaks into raw observations', () => {
  const raw = JSON.parse(readFileSync(new URL('../../data/offers/steam/monster-hunter-rise.json', import.meta.url)));
  assert.equal(raw.offers.some((offer) => 'columnLabel' in offer || 'note' in offer), false);
  const built = steamOffers('monster-hunter-rise');
  assert.deepEqual(built.offers.map((offer) => offer.name), [
    'Monster Hunter Rise + Sunbreak',
    'Monster Hunter Rise + Sunbreak Deluxe',
    'Monster Hunter Rise - DLC Collection',
    'Monster Hunter Rise: Sunbreak - DLC Collection',
  ]);
  assert.equal(built.offers.every((offer) => typeof offer.note === 'string' && offer.note.length > 0), true);
});
