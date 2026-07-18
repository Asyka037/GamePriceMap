import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PSN_AWAITING_FIRST_FULL_RUN_NOTE,
  completeSourceRun,
  isAwaitingFirstFullRun,
  sourceRunExitCode,
} from '../lib/sourcehealth.mjs';

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

test('PSN registration is explicit and never masquerades as a successful run', () => {
  const registered = {
    lastAttemptAt: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
    note: PSN_AWAITING_FIRST_FULL_RUN_NOTE,
  };
  assert.equal(isAwaitingFirstFullRun('psn-us', registered), true);
  assert.equal(isAwaitingFirstFullRun('xbox-us', registered), false);
  assert.equal(isAwaitingFirstFullRun('psn-us', { ...registered, lastSuccessAt: '2026-07-18T00:00:00Z' }), false);
});
