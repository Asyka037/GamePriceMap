/**
 * Release calendar parsing/merging — pure functions, no I/O.
 * Degraded-source edition (plan §T3.2): Steam coming_soon + eShop-EU
 * upcoming. IGDB becomes the primary source once Twitch credentials exist;
 * these parsers stay as the fallback/enrichment layer.
 */

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/**
 * Steam release_date.date strings → { date, month } (either may be null).
 * Handles "24 Jul, 2026", "Jul 24, 2026", "July 2026"; rejects vague forms
 * ("Q4 2026", "2026", "Coming soon", "To be announced").
 */
export function parseSteamReleaseDate(str) {
  if (!str) return { date: null, month: null };
  const s = String(str).trim();

  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return { date: `${m[3]}-${mo}-${m[1].padStart(2, '0')}`, month: `${m[3]}-${mo}` };
  }
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return { date: `${m[3]}-${mo}-${m[2].padStart(2, '0')}`, month: `${m[3]}-${mo}` };
  }
  m = s.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return { date: null, month: `${m[2]}-${mo}` };
  }
  return { date: null, month: null };
}

const JUNK = /\b(demo|playtest|soundtrack|dlc|art\s*book|trailer)\b/i;

export function isJunkComingSoonName(name) {
  return JUNK.test(name ?? '');
}

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/**
 * Merge calendar entries from multiple sources.
 * entries: [{ title, date|null, month|null, platform, url, slugIfTracked }]
 * Same normalized title merges platforms; concrete dates beat month-only.
 * Entries without at least a month are dropped (unusable on month pages).
 */
export function mergeCalendarEntries(entries) {
  const byTitle = new Map();
  for (const e of entries) {
    if (!e.month) continue;
    const key = norm(e.title);
    const prev = byTitle.get(key);
    if (!prev) {
      byTitle.set(key, { title: e.title, date: e.date, month: e.month, platforms: [e.platform], url: e.url, slugIfTracked: e.slugIfTracked ?? null });
      continue;
    }
    if (!prev.platforms.includes(e.platform)) prev.platforms.push(e.platform);
    if (!prev.date && e.date) { prev.date = e.date; prev.month = e.month; }
    prev.slugIfTracked ??= e.slugIfTracked ?? null;
  }
  const months = {};
  for (const entry of byTitle.values()) {
    (months[entry.month] ??= []).push(entry);
  }
  for (const list of Object.values(months)) {
    list.sort((a, b) => (a.date ?? `${a.month}-99`).localeCompare(b.date ?? `${b.month}-99`) || a.title.localeCompare(b.title));
  }
  return Object.fromEntries(Object.entries(months).sort(([a], [b]) => a.localeCompare(b)));
}
