import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSourceRun } from '../lib/sourcehealth.mjs';

test('source success advances only after complete expected coverage', () => {
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 40 }), true);
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 39, skipped: 1 }), false);
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 40, failedRequests: 1 }), false);
  assert.equal(completeSourceRun({ expected: 14, changed: 13, unchanged: 0, failedItems: 1 }), false);
});
