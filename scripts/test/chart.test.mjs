import test from 'node:test';
import assert from 'node:assert/strict';
import { multiStepChartModel, stepChartModel } from '../../site/src/lib/chart.mjs';

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

test('multi-channel chart shares date and zero-based price axes', () => {
  const m = multiStepChartModel(events, {
    channels: [
      { id: 'steam', endDate: '2026-07-11' },
      { id: 'eshop', endDate: '2026-07-12' },
    ],
  });
  const steam = m.series.find((series) => series.id === 'steam');
  const eshop = m.series.find((series) => series.id === 'eshop');
  assert.equal(steam.dots[0].x, eshop.dots[0].x, 'same day has one shared x position');
  assert.equal(steam.dots[0].y, eshop.dots[0].y, 'same price has one shared y position');
  assert.equal(m.yTicks[0].label, '$0');
  assert.equal(m.yTicks[0].y, m.plot.y + m.plot.h);
  assert.ok(m.domain.maxUsd >= 29.99 * 1.1);
});

test('each channel ends at its own successful check and stale dates are clamped', () => {
  const m = multiStepChartModel(events, {
    channels: [
      { id: 'steam', endDate: '2026-07-09' },
      { id: 'eshop', endDate: '2026-07-12' },
    ],
  });
  const steam = m.series.find((series) => series.id === 'steam');
  const eshop = m.series.find((series) => series.id === 'eshop');
  assert.equal(steam.endDate, '2026-07-10', 'source date cannot precede its final event');
  assert.equal(eshop.endDate, '2026-07-12');
  assert.ok(Number(steam.path.match(/H(\d+)$/)[1]) < Number(eshop.path.match(/H(\d+)$/)[1]));
});

test('one observation becomes a confirmed flat line only after a later successful check', () => {
  const confirmed = multiStepChartModel(events, {
    channels: [{ id: 'eshop', endDate: '2026-07-11' }],
  }).series[0];
  assert.equal(confirmed.state, 'confirmed-flat');
  assert.match(confirmed.path, /^M\d+ \d+ H\d+$/);
  assert.equal(confirmed.dots.length, 1);
  assert.ok(confirmed.endPoint.x > confirmed.dots[0].x);

  const pointModel = multiStepChartModel(events, {
    channels: [{ id: 'eshop', endDate: '2026-07-08' }],
  });
  const point = pointModel.series[0];
  assert.equal(point.state, 'point');
  assert.equal(point.path, null);
  assert.equal(point.endPoint, null);
  assert.equal(point.dots[0].x, pointModel.plot.x + pointModel.plot.w / 2, 'a same-day-only observation is centered instead of stranded at the left edge');
});

test('empty and malformed multi-channel data stays finite and does not mutate input', () => {
  const noisy = [
    ...events,
    { d: 'not-a-date', ch: 'steam', cc: 'US', usd: 9.99, pct: null },
    { d: '2026-07-09', ch: 'steam', cc: 'CA', usd: 9.99, pct: null },
    { d: '2026-07-09', ch: 'steam', cc: 'US', usd: NaN, pct: null },
    { d: '2026-07-09', ch: 'unknown', cc: 'US', usd: 9.99, pct: null },
  ];
  const before = noisy.map((event) => ({ ...event }));
  const m = multiStepChartModel(noisy, {
    channels: [{ id: 'steam', endDate: 'bad-date' }, { id: 'xbox', endDate: '2026-07-11' }],
  });
  assert.equal(m.series.find((series) => series.id === 'steam').dots.length, 2);
  assert.equal(m.series.find((series) => series.id === 'xbox').state, 'empty');
  assert.deepEqual(noisy, before);

  const empty = multiStepChartModel(undefined, {
    channels: [{ id: 'xbox', endDate: '2026-07-11' }],
  });
  assert.equal(empty.hasObservations, false);
  assert.equal(empty.plot, null);
  assert.equal(empty.series[0].state, 'empty');
  assert.doesNotMatch(JSON.stringify(empty), /NaN/);
});
