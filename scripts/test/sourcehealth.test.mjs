import test from 'node:test';
import assert from 'node:assert/strict';
import { completeSourceRun, sourceRunExitCode } from '../lib/sourcehealth.mjs';

test('source success advances only after complete expected coverage', () => {
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 40 }), true);
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 39, skipped: 1 }), false);
  assert.equal(completeSourceRun({ expected: 42, changed: 2, unchanged: 40, failedRequests: 1 }), false);
  assert.equal(completeSourceRun({ expected: 14, changed: 13, unchanged: 0, failedItems: 1 }), false);
});

test('incomplete targeted runs fail while scheduled runs remain fail-soft', () => {
  assert.equal(sourceRunExitCode({ targeted: true, complete: false }), 1);
  assert.equal(sourceRunExitCode({ targeted: true, complete: true }), 0);
  assert.equal(sourceRunExitCode({ targeted: false, complete: false }), 0);
});
