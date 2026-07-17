import test from 'node:test';
import assert from 'node:assert/strict';
import { hasNativeUsObservation, isNintendoBaseGameNsuid, minimumApplicableRegionCount } from '../lib/validation.mjs';

test('Nintendo catalog IDs accept only 14-digit 7001 base-game NSUIDs', () => {
  assert.equal(isNintendoBaseGameNsuid('70010000044642'), true);
  assert.equal(isNintendoBaseGameNsuid('70050000044642'), false, '7005 is add-on or upgrade content');
  assert.equal(isNintendoBaseGameNsuid('70070000044642'), false, '7007 is a bundle');
  assert.equal(isNintendoBaseGameNsuid('7001000004464'), false, 'short IDs fail');
  assert.equal(isNintendoBaseGameNsuid('700100000446420'), false, 'long IDs fail');
});

test('Americas coverage requires an actual native US/USD observation', () => {
  assert.equal(hasNativeUsObservation({ regions: [{ cc: 'US', currency: 'USD', amount: 59.99 }] }), true);
  assert.equal(hasNativeUsObservation({ regions: [{ cc: 'US', currency: 'EUR', amount: 59.99 }] }), false);
  assert.equal(hasNativeUsObservation({ regions: [{ cc: 'CA', currency: 'USD', amount: 59.99 }] }), false);
  assert.equal(hasNativeUsObservation({ regions: [] }), false);
  assert.equal(hasNativeUsObservation(null), false);
});

test('new snapshots require 80% of the regions applicable to their mappings', () => {
  const config = {
    steamRegions: Array.from({ length: 18 }, (_, i) => `s${i}`),
    eshopRegions: [
      ...Array.from({ length: 6 }, (_, i) => ({ cc: `a${i}`, group: 'americas' })),
      ...Array.from({ length: 9 }, (_, i) => ({ cc: `e${i}`, group: 'europe' })),
      { cc: 'JP', group: 'japan' },
    ],
  };
  assert.equal(minimumApplicableRegionCount('steam', {}, config), 15);
  assert.equal(minimumApplicableRegionCount('eshop', { nsuids: { europe: 'id' } }, config), 8);
  assert.equal(minimumApplicableRegionCount('eshop', { nsuids: { americas: 'id', europe: 'id' } }, config), 12);
});
