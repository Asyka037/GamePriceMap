/**
 * Step-chart geometry for the US self-observed price trend — pure, no DOM.
 *
 * History events are change points, not daily samples, so the honest render
 * is a step line: price holds until the next event. The final segment
 * extends to the channel source's lastSuccessAt (the last day we *confirmed*
 * the price), never to "today" — if scraping stalls, the line stops moving.
 */

const DAY = 86400e3;

function niceTop(max) {
  if (!(max > 0)) return 1;
  const raw = max * 1.15;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

const fmtShort = (d) => d.slice(5).replace('-', '/'); // '2026-07-08' -> '07/08'

/**
 * @param {Array<{d:string,ch:string,usd:number,pct:number|null}>} events history events (all channels)
 * @param {{channel:string, endDate:string|null, width?:number, height?:number}} opts
 *   endDate: date (YYYY-MM-DD) of the source's lastSuccessAt; clamped to >= last event.
 * @returns model for an SVG step chart, or null when the channel has <2 events.
 */
export function stepChartModel(events, { channel, endDate, width = 640, height = 190 } = {}) {
  const pts = (events ?? [])
    .filter((e) => e.ch === channel && Number.isFinite(e.usd))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (pts.length < 2) return null;

  const pad = { t: 12, r: 14, b: 24, l: 46 };
  const first = Date.parse(pts[0].d);
  const lastEvent = Date.parse(pts[pts.length - 1].d);
  let end = endDate ? Date.parse(endDate.slice(0, 10)) : lastEvent;
  if (!Number.isFinite(end) || end < lastEvent) end = lastEvent;
  const span = Math.max(end - first, DAY);

  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const top = niceTop(Math.max(...pts.map((p) => p.usd)));
  const x = (t) => Math.round(pad.l + ((t - first) / span) * innerW);
  const y = (usd) => Math.round(pad.t + (1 - usd / top) * innerH);

  const dots = pts.map((p) => ({ x: x(Date.parse(p.d)), y: y(p.usd), d: p.d, usd: p.usd, pct: p.pct ?? null }));
  let path = `M${dots[0].x} ${dots[0].y}`;
  for (let i = 1; i < dots.length; i++) path += ` H${dots[i].x} V${dots[i].y}`;
  path += ` H${x(end)}`;

  const yTicks = [0, top / 2, top].map((v) => ({ y: y(v), label: `$${v % 1 ? v.toFixed(2) : v}` }));
  const endLabel = new Date(end).toISOString().slice(0, 10);
  const xTicks = [{ x: dots[0].x, label: fmtShort(pts[0].d), anchor: 'start' }];
  if (end - first >= 2 * DAY) xTicks.push({ x: x(end), label: fmtShort(endLabel), anchor: 'end' });

  return {
    w: width, h: height, plot: { x: pad.l, y: pad.t, w: innerW, h: innerH },
    path, dots, yTicks, xTicks,
    lastUsd: pts[pts.length - 1].usd, endDate: endLabel,
  };
}
