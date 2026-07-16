import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  selectEuropeDiscoveryCandidate,
  selectJapanDiscoveryCandidate,
} from '../lib/nsuid-discovery.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/nsuid-discovery-candidates.json', import.meta.url),
  'utf8',
));

test('EU discovery rejects an exact-title BEE result for a Switch 1 game', () => {
  const title = fixture.europe.dqXiSwitch2.title;
  const afterRelease = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.dqXiSwitch2], {
      title,
      platforms: ['pc', 'switch'],
      now: afterRelease,
    }),
    null,
    'DQ XI S must not map its Switch 2 re-release onto a Switch 1 catalog entry',
  );
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.dqXiSwitch2], {
      title,
      platforms: ['pc', 'switch-2'],
      now: afterRelease,
    })?.nsuid,
    '70010000097771',
  );
});

test('EU discovery excludes unreleased and zero-price products', () => {
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.dqXiSwitch2], {
      title: fixture.europe.dqXiSwitch2.title,
      platforms: ['switch-2'],
      now: Date.parse('2026-07-15T00:00:00Z'),
    }),
    null,
  );
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.zeroPrice], {
      title: 'Example Game',
      platforms: ['switch'],
      now: Date.parse('2026-07-15T00:00:00Z'),
    }),
    null,
  );
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.validHac], {
      title: 'Example Game',
      platforms: ['switch'],
      now: Date.parse('2026-07-15T00:00:00Z'),
    })?.nsuid,
    '70010000000001',
  );
});

test('EU discovery keeps an exact first-party candidate for price-API verification', () => {
  assert.equal(
    selectEuropeDiscoveryCandidate([fixture.europe.firstPartyIndexFalse], {
      title: 'Super Mario Bros. Wonder',
      platforms: ['switch'],
      now: Date.parse('2026-07-16T00:00:00Z'),
    })?.nsuid,
    '70010000068689',
    'Solr digital_version_b=false must not override a live official price API',
  );
});

test('JP discovery selects HAC or BEE according to catalog platforms', () => {
  const items = [fixture.japan.hogwartsBee, fixture.japan.hogwartsHac];
  assert.equal(
    selectJapanDiscoveryCandidate(items, { title: 'Hogwarts Legacy', platforms: ['switch'] })?.nsuid,
    '70010000062278',
  );
  assert.equal(
    selectJapanDiscoveryCandidate(items, { title: 'Hogwarts Legacy', platforms: ['switch-2'] })?.nsuid,
    '70010000095416',
  );
});

test('JP discovery excludes upgrades, bundles, terminated, and zero-price products', () => {
  for (const item of [
    fixture.japan.upgrade,
    fixture.japan.bundle,
    fixture.japan.terminated,
    fixture.japan.zeroPrice,
  ]) {
    assert.equal(
      selectJapanDiscoveryCandidate([item], { title: 'Example Game', platforms: ['switch'] }),
      null,
    );
  }
});

test('JP discovery matches bilingual titles before either parenthesis style', () => {
  const common = {
    nsuid: '70010000005309',
    hard: '1_HAC',
    sform: 'HAC_DOWNLOADABLE',
    ssitu: 'onsale',
    upgrade: 0,
    current_price: 6500,
  };
  for (const title of ['Pikmin 4 (ピクミン４)', 'Pikmin 4（ピクミン４）']) {
    assert.equal(
      selectJapanDiscoveryCandidate([{ ...common, title }], { title: 'Pikmin 4', platforms: ['switch'] })?.nsuid,
      '70010000005309',
    );
  }
});
