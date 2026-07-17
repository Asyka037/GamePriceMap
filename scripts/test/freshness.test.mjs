import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUtcStamp, freshnessState, sourceBudgetHours } from '../../site/src/lib/freshness.mjs';

const stamp = '2026-07-15T09:30:00.000Z';
const atHoursAfter = (hours) => Date.parse(stamp) + hours * 3600e3;

test('freshness state ages from fresh through stale to down at runtime', () => {
  assert.equal(freshnessState(stamp, 26, atHoursAfter(26)), 'fresh');
  assert.equal(freshnessState(stamp, 26, atHoursAfter(26.01)), 'stale');
  assert.equal(freshnessState(stamp, 26, atHoursAfter(52)), 'stale');
  assert.equal(freshnessState(stamp, 26, atHoursAfter(52.01)), 'down');
  assert.equal(freshnessState(null, 26, atHoursAfter(1)), 'down');
  assert.equal(freshnessState(stamp, 0, atHoursAfter(1)), 'down');
});

test('status timestamps are formatted with an explicit UTC label', () => {
  assert.equal(formatUtcStamp('2026-07-15T09:30:52.418Z'), '2026-07-15 09:30 UTC');
  assert.equal(formatUtcStamp(null), 'never');
  assert.equal(formatUtcStamp('invalid'), 'never');
});

test('status budgets match daily, seven-shard, and fourteen-shard cadences', () => {
  assert.equal(sourceBudgetHours('steam-regional'), 26);
  assert.equal(sourceBudgetHours('steam-regional:extended-3'), 8 * 24);
  assert.equal(sourceBudgetHours('meta'), 15 * 24);
  assert.equal(sourceBudgetHours('meta:shard-12'), 15 * 24);
  assert.equal(freshnessState(stamp, sourceBudgetHours('meta'), atHoursAfter(14 * 24)), 'fresh');
});
