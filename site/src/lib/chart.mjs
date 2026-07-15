/**
 * Geometry for self-observed US price history — pure, no DOM.
 *
 * Events are change points rather than daily samples, so every series is a
 * step line. A series ends at its own source lastSuccessAt, never at "today"
 * or at another source's fresher date. One event may form a flat segment only
 * when a later complete source run confirmed that the price stayed unchanged.
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

function parseDay(value) {
  if (typeof value !== 'string') return null;
  const label = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label)) return null;
  const time = Date.parse(`${label}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== label) return null;
  return { label, time };
}

function fmtShort(day) {
  return day.slice(5).replace('-', '/'); // '2026-07-08' -> '07/08'
}

function channelPoints(events, id) {
  return (events ?? [])
    .filter((event) => event?.ch === id && event.cc === 'US' && Number.isFinite(event.usd) && event.usd >= 0)
    .map((event) => ({ event, day: parseDay(event.d) }))
    .filter(({ day }) => day)
    .sort((a, b) => a.day.time - b.day.time)
    .map(({ event, day }) => ({
      d: day.label,
      time: day.time,
      usd: event.usd,
      pct: event.pct ?? null,
    }));
}

/**
 * Build several independent price-step series on one shared date/price scale.
 *
 * @param {Array<{d:string,ch:string,cc:string,usd:number,pct:number|null}>} events
 * @param {{channels:Array<{id:string,endDate:string|null}>,width?:number,height?:number}} opts
 * @returns shared SVG geometry, including empty series for tracked channels.
 */
export function multiStepChartModel(events, { channels = [], width = 1040, height = 300 } = {}) {
  const seen = new Set();
  const uniqueChannels = channels.filter(({ id }) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const rawSeries = uniqueChannels
    .map(({ id, endDate }) => {
      const points = channelPoints(events, id);
      if (points.length === 0) {
        return { id, points, state: 'empty', firstDate: null, lastEventDate: null, endDate: null };
      }

      const first = points[0];
      const last = points[points.length - 1];
      const requestedEnd = parseDay(endDate);
      const endTime = requestedEnd && requestedEnd.time >= last.time ? requestedEnd.time : last.time;
      const endLabel = new Date(endTime).toISOString().slice(0, 10);
      const state = points.length > 1
        ? 'changes'
        : endTime > first.time ? 'confirmed-flat' : 'point';
      return {
        id,
        points,
        state,
        firstDate: first.d,
        lastEventDate: last.d,
        endDate: endLabel,
        firstTime: first.time,
        endTime,
      };
    });

  const observed = rawSeries.filter(({ points }) => points.length > 0);
  if (observed.length === 0) {
    return {
      w: width,
      h: height,
      plot: null,
      domain: null,
      yTicks: [],
      xTicks: [],
      hasObservations: false,
      series: rawSeries.map(({ id, state, firstDate, lastEventDate, endDate }) => ({
        id, state, firstDate, lastEventDate, endDate, lastUsd: null, path: null, dots: [], endPoint: null,
      })),
    };
  }

  const pad = { t: 16, r: 18, b: 30, l: 58 };
  const first = Math.min(...observed.map((series) => series.firstTime));
  const latest = Math.max(...observed.map((series) => series.endTime));
  const axisStart = latest === first ? first - DAY / 2 : first;
  const axisEnd = latest === first ? latest + DAY / 2 : latest;
  const span = axisEnd - axisStart;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const top = niceTop(Math.max(...observed.flatMap((series) => series.points.map((point) => point.usd))));
  const x = (time) => Math.round(pad.l + ((time - axisStart) / span) * innerW);
  const y = (usd) => Math.round(pad.t + (1 - usd / top) * innerH);

  const series = rawSeries.map((raw) => {
    if (raw.points.length === 0) {
      return {
        id: raw.id,
        state: raw.state,
        firstDate: null,
        lastEventDate: null,
        endDate: null,
        lastUsd: null,
        path: null,
        dots: [],
        endPoint: null,
      };
    }

    const dots = raw.points.map((point) => ({
      x: x(point.time),
      y: y(point.usd),
      d: point.d,
      usd: point.usd,
      pct: point.pct,
    }));
    const last = dots[dots.length - 1];
    const endX = x(raw.endTime);
    let path = null;
    if (dots.length > 1 || endX > dots[0].x) {
      path = `M${dots[0].x} ${dots[0].y}`;
      for (let i = 1; i < dots.length; i += 1) path += ` H${dots[i].x} V${dots[i].y}`;
      path += ` H${endX}`;
    }

    return {
      id: raw.id,
      state: raw.state,
      firstDate: raw.firstDate,
      lastEventDate: raw.lastEventDate,
      endDate: raw.endDate,
      lastUsd: last.usd,
      path,
      dots,
      endPoint: endX > last.x ? { x: endX, y: last.y, d: raw.endDate, usd: last.usd } : null,
    };
  });

  const firstLabel = new Date(first).toISOString().slice(0, 10);
  const latestLabel = new Date(latest).toISOString().slice(0, 10);
  const xTicks = [{ x: x(first), label: fmtShort(firstLabel), anchor: latest === first ? 'middle' : 'start' }];
  if (latest > first) xTicks.push({ x: x(latest), label: fmtShort(latestLabel), anchor: 'end' });
  const yTicks = [0, top / 2, top].map((value) => ({
    y: y(value),
    label: `$${value % 1 ? value.toFixed(2) : value}`,
  }));

  return {
    w: width,
    h: height,
    plot: { x: pad.l, y: pad.t, w: innerW, h: innerH },
    domain: { firstDate: firstLabel, endDate: latestLabel, maxUsd: top },
    yTicks,
    xTicks,
    hasObservations: true,
    series,
  };
}

/**
 * Backwards-compatible single-channel model. The legacy UI intentionally
 * required two change events; callers needing confirmed flat segments should
 * use multiStepChartModel.
 */
export function stepChartModel(events, { channel, endDate, width = 640, height = 190 } = {}) {
  const shared = multiStepChartModel(events, {
    channels: [{ id: channel, endDate }],
    width,
    height,
  });
  const series = shared.series[0];
  if (!series || series.dots.length < 2) return null;
  return {
    w: shared.w,
    h: shared.h,
    plot: shared.plot,
    path: series.path,
    dots: series.dots,
    yTicks: shared.yTicks,
    xTicks: shared.xTicks,
    lastUsd: series.lastUsd,
    endDate: series.endDate,
  };
}
