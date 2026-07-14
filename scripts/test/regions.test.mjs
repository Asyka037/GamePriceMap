import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countryFlag, countryName, formatRegionDelta, regionDeltaPct, regionalPriceModel,
} from '../../site/src/lib/regions.mjs';

test('country labels expose full English names with accessible flag companions', () => {
  assert.equal(countryName('UA'), 'Ukraine');
  assert.equal(countryName('CH'), 'Switzerland');
  assert.equal(countryName('KR'), 'South Korea');
  assert.equal(countryName('TR'), 'Turkey');
  assert.equal(countryFlag('UA'), '🇺🇦');
  assert.equal(countryFlag('bad'), '');
});

test('regional percentages share one signed US-baseline formula', () => {
  const us = { cc: 'US', usd: 59.99 };
  assert.equal(regionDeltaPct({ cc: 'UA', usd: 20.13 }, us), -66);
  assert.equal(regionDeltaPct(us, us), 0);
  assert.equal(regionDeltaPct({ cc: 'CH', usd: 86.04 }, us), 43);
  assert.equal(formatRegionDelta(-66), '−66%');
  assert.equal(formatRegionDelta(0), '0%');
  assert.equal(formatRegionDelta(43), '+43%');
});

test('regional model keeps parity neutral and refuses to invent a missing US baseline', () => {
  const parity = regionalPriceModel({ regions: [
    { cc: 'CA', usd: 20 },
    { cc: 'US', usd: 20 },
  ] });
  assert.equal(parity.rows.find((row) => row.cc === 'CA').direction, 'par');
  assert.equal(parity.rows.find((row) => row.cc === 'US').direction, 'baseline');

  const noUs = regionalPriceModel({ regions: [{ cc: 'JP', usd: 15 }] });
  assert.equal(noUs.baseline, null);
  assert.equal(noUs.rows[0].deltaPct, null);
  assert.equal(noUs.rows[0].deltaLabel, '—');
  assert.equal(noUs.rows[0].direction, 'unknown');
});
