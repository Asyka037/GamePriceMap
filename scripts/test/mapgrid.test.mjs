import test from 'node:test';
import assert from 'node:assert/strict';
import { COUNTRY_TILES, CONTINENT_BLOBS, GRID, tierFor, mapRegions } from '../../site/src/lib/mapgrid.mjs';
import { STEAM_REGIONS } from '../lib/steam.mjs';
import { ESHOP_REGIONS } from '../lib/eshop.mjs';

test('every tracked steam + eshop region has a map tile', () => {
  const tracked = new Set([...STEAM_REGIONS.map((c) => c.toUpperCase()), ...ESHOP_REGIONS.map((r) => r.cc)]);
  for (const cc of tracked) assert.ok(COUNTRY_TILES[cc], `missing tile for ${cc}`);
});

test('tiles and blobs stay inside the 24x12 grid', () => {
  for (const [cc, t] of Object.entries(COUNTRY_TILES)) {
    assert.ok(t.col >= 1 && t.col + t.w - 1 <= GRID.cols, `${cc} overflows cols`);
    assert.ok(t.row >= 1 && t.row + t.h - 1 <= GRID.rows, `${cc} overflows rows`);
  }
  for (const b of CONTINENT_BLOBS) {
    assert.ok(b.col + b.w - 1 <= GRID.cols && b.row + b.h - 1 <= GRID.rows);
  }
});

test('no two country tiles overlap', () => {
  const cells = new Map();
  for (const [cc, t] of Object.entries(COUNTRY_TILES)) {
    for (let c = t.col; c < t.col + t.w; c++) {
      for (let r = t.row; r < t.row + t.h; r++) {
        const key = `${c},${r}`;
        assert.ok(!cells.has(key), `${cc} overlaps ${cells.get(key)} at ${key}`);
        cells.set(key, cc);
      }
    }
  }
});

test('tier boundaries match the legend', () => {
  assert.equal(tierFor(-45).cls, 'tile-cheapest');
  assert.equal(tierFor(-30).cls, 'tile-cheapest');
  assert.equal(tierFor(-15).cls, 'tile-cheaper');
  assert.equal(tierFor(0).cls, 'tile-par');
  assert.equal(tierFor(9).cls, 'tile-par');
  assert.equal(tierFor(15).cls, 'tile-pricier');
  assert.equal(tierFor(40).cls, 'tile-priciest');
  assert.equal(tierFor(null).cls, 'tile-none');
});

test('mapRegions computes pct vs US and drops unknown ccs', () => {
  const rows = mapRegions(
    [
      { cc: 'ZA', usd: 11.36, amount: 199, currency: 'ZAR' },
      { cc: 'US', usd: 19.99, amount: 19.99, currency: 'USD' },
      { cc: 'XX', usd: 5, amount: 5, currency: 'USD' },
    ],
    19.99,
  );
  assert.equal(rows.length, 2);
  const za = rows.find((r) => r.cc === 'ZA');
  assert.equal(za.pctVsUs, -43);
  assert.equal(za.tier.cls, 'tile-cheapest');
  assert.equal(rows.find((r) => r.cc === 'US').tier.cls, 'tile-par');
});
