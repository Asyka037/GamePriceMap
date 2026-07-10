import test from 'node:test';
import assert from 'node:assert/strict';
import { WORLD, directionFor, mapRegions, DEEP_GAP_PCT, LABEL_OFFSETS } from '../../site/src/lib/mapgrid.mjs';
import { STEAM_REGIONS } from '../lib/steam.mjs';
import { ESHOP_REGIONS } from '../lib/eshop.mjs';

test('every tracked steam + eshop region exists in the world raster', () => {
  const tracked = new Set([...STEAM_REGIONS.map((c) => c.toUpperCase()), ...ESHOP_REGIONS.map((r) => r.cc)]);
  for (const cc of tracked) {
    assert.ok(WORLD.countries[cc]?.length > 0, `missing raster cells for ${cc}`);
    const cen = WORLD.centroids[cc];
    assert.ok(cen.x > 0 && cen.x < WORLD.cols && cen.y > 0 && cen.y < WORLD.rows, `centroid out of bounds for ${cc}`);
  }
});

test('raster runs stay inside the grid', () => {
  for (const [cc, runs] of Object.entries(WORLD.countries)) {
    for (const [r, c, len] of runs) {
      assert.ok(r >= 0 && r < WORLD.rows && c >= 0 && c + len <= WORLD.cols, `${cc} run out of bounds`);
    }
  }
});

test('three directions only: baseline neutral, cheaper green, pricier red', () => {
  assert.equal(directionFor(0, true).dir, 'baseline');
  assert.equal(directionFor(-45).cls, 'wm-cheaper-2');
  assert.equal(directionFor(-DEEP_GAP_PCT).cls, 'wm-cheaper-2');
  assert.equal(directionFor(-12).cls, 'wm-cheaper-1');
  assert.equal(directionFor(12).cls, 'wm-pricier-1');
  assert.equal(directionFor(DEEP_GAP_PCT).cls, 'wm-pricier-2');
  assert.equal(directionFor(null).dir, 'nodata');
  assert.deepEqual(directionFor(0), { dir: 'par', cls: 'wm-par' }, 'non-baseline at parity is its own direction, never black');
});

test('mapRegions computes pct vs US baseline and attaches geometry', () => {
  const { baseline, regions } = mapRegions([
    { cc: 'ZA', usd: 11.36, amount: 199, currency: 'ZAR' },
    { cc: 'US', usd: 19.99, amount: 19.99, currency: 'USD' },
    { cc: 'CH', usd: 25, amount: 22, currency: 'CHF' },
  ]);
  assert.equal(baseline, 'US');
  const za = regions.find((r) => r.cc === 'ZA');
  assert.equal(za.pctVsBaseline, -43);
  assert.equal(za.dir, 'cheaper');
  assert.ok(za.runs.length > 0 && za.centroid);
  assert.equal(regions.find((r) => r.cc === 'CH').dir, 'pricier');
  assert.equal(regions.find((r) => r.cc === 'US').dir, 'baseline');
});

test('every tracked region has a hand-tuned label offset inside the frame', () => {
  for (const cc of Object.keys(WORLD.countries)) {
    assert.ok(Array.isArray(LABEL_OFFSETS[cc]) && LABEL_OFFSETS[cc].length === 2, `missing label offset for ${cc}`);
    const { x, y } = WORLD.centroids[cc];
    const lx = x + LABEL_OFFSETS[cc][0];
    const ly = y + LABEL_OFFSETS[cc][1];
    assert.ok(lx > 2 && lx < WORLD.cols - 2 && ly > 1 && ly < WORLD.rows - 1, `label for ${cc} out of frame (${lx},${ly})`);
  }
});

test('without a US row the cheapest region becomes baseline', () => {
  const { baseline, regions } = mapRegions([
    { cc: 'JP', usd: 15, amount: 2300, currency: 'JPY' },
    { cc: 'GB', usd: 20, amount: 16, currency: 'GBP' },
  ]);
  assert.equal(baseline, 'JP');
  assert.equal(regions.find((r) => r.cc === 'JP').dir, 'baseline');
  assert.equal(regions.find((r) => r.cc === 'GB').dir, 'pricier');
});
