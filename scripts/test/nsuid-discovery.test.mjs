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
