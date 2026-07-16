import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupIsDue, seedCheckIsDue, plusDays, RECHECK_DAYS } from '../lib/cheapshark.mjs';

test('plusDays crosses month boundaries in UTC', () => {
  assert.equal(plusDays('2026-07-16', 30), '2026-08-15');
  assert.equal(plusDays('2026-12-31', 1), '2027-01-01');
});

test('lookup misses pause retries for the window, then become due again', () => {
  assert.ok(lookupIsDue(undefined, '2026-07-16'), 'never tried: due');
  assert.ok(lookupIsDue({}, '2026-07-16'), 'no recorded miss: due');
  const missed = { lookupMissUntil: plusDays('2026-07-16', RECHECK_DAYS) };
  assert.ok(!lookupIsDue(missed, '2026-07-17'), 'inside window: not due');
  assert.ok(lookupIsDue(missed, '2026-08-15'), 'window elapsed: due');
});

test('seed checks are due when never done or older than the recheck window', () => {
  assert.ok(seedCheckIsDue(undefined, '2026-07-16'), 'never checked: due');
  const checked = { seedCheckedAt: '2026-07-16' };
  assert.ok(!seedCheckIsDue(checked, '2026-07-17'), 'fresh check: not due');
  assert.ok(!seedCheckIsDue(checked, '2026-08-14'), 'day 29: still not due');
  assert.ok(seedCheckIsDue(checked, '2026-08-15'), 'day 30: due again');
});

test('a network failure records nothing, so the game stays due (fail-soft retry)', () => {
  // build-history only writes lookupMissUntil on a parsed "not found" and
  // seedCheckedAt on a successful batch response; this pins the ledger
  // semantics the script relies on.
  assert.ok(lookupIsDue({}, '2026-07-16'));
  assert.ok(seedCheckIsDue({}, '2026-07-16'));
});
