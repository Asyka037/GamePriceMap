import test from 'node:test';
import assert from 'node:assert/strict';
import { stepChartModel } from '../../site/src/lib/chart.mjs';

const events = [
  { d: '2026-07-08', ch: 'steam', cc: 'US', usd: 20.99, pct: 30 },
  { d: '2026-07-08', ch: 'eshop', cc: 'US', usd: 20.99, pct: 30 },
  { d: '2026-07-10', ch: 'steam', cc: 'US', usd: 29.99, pct: null },
];

test('fewer than 2 channel events yields null (page shows "tracking since")', () => {
  assert.equal(stepChartModel(events, { channel: 'eshop', endDate: '2026-07-11' }), null);
  assert.equal(stepChartModel([], { channel: 'steam', endDate: '2026-07-11' }), null);
  assert.equal(stepChartModel(undefined, { channel: 'steam', endDate: null }), null);
});

test('step line ends at the source lastSuccessAt, not at the last event', () => {
  const m = stepChartModel(events, { channel: 'steam', endDate: '2026-07-11T07:35:00Z' });
  assert.equal(m.endDate, '2026-07-11');
  const tailX = Number(m.path.match(/H(\d+)$/)[1]);
  assert.ok(tailX > m.dots[1].x, 'final H segment extends past the last event dot');
  assert.match(m.path, /^M\d+ \d+ H\d+ V\d+ H\d+$/, 'pure horizontal/vertical steps');
});

test('stale endDate earlier than the last event is clamped to the last event', () => {
  const m = stepChartModel(events, { channel: 'steam', endDate: '2026-07-09' });
  assert.equal(m.endDate, '2026-07-10');
});

test('dots carry event data and y decreases as price increases', () => {
  const m = stepChartModel(events, { channel: 'steam', endDate: '2026-07-11' });
  assert.equal(m.dots.length, 2);
  assert.equal(m.dots[0].usd, 20.99);
  assert.equal(m.dots[0].pct, 30);
  assert.ok(m.dots[1].y < m.dots[0].y, 'higher price sits higher on the chart');
  assert.equal(m.lastUsd, 29.99);
});

test('y axis is zero-based with a nice top above the max price', () => {
  const m = stepChartModel(events, { channel: 'steam', endDate: '2026-07-11' });
  assert.equal(m.yTicks[0].label, '$0');
  const top = Number(m.yTicks[2].label.slice(1));
  assert.ok(top >= 29.99 * 1.1, 'headroom above max');
  assert.equal(m.yTicks[0].y, m.plot.y + m.plot.h, '$0 sits on the baseline');
});

test('non-channel and malformed events are ignored', () => {
  const noisy = [...events, { d: '2026-07-09', ch: 'steam', cc: 'US', usd: NaN, pct: null }];
  const m = stepChartModel(noisy, { channel: 'steam', endDate: '2026-07-11' });
  assert.equal(m.dots.length, 2);
});
