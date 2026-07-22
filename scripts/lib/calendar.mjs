/**
 * Release calendar parsing/merging — pure functions, no I/O.
 * Official-source edition: Steam coming_soon, eShop-EU upcoming, plus sealed
 * Xbox/PlayStation release-source caches refreshed by their own bounded jobs.
 */

import { normTitle } from './match.mjs';

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

const PLATFORM_ORDER = new Map(['pc', 'switch', 'xbox', 'psn'].map((key, index) => [key, index]));

/**
 * Merge calendar entries from multiple sources.
 * entries: [{ title, date|null, month|null, platform, url, image, slugIfTracked }]
 * Only the same normalized title on the same release date merges. A port that
 * ships on a different day remains a separate calendar row. Every platform
 * keeps its own official URL so a cross-platform merge can never redirect a
 * reader to the wrong storefront.
 * Entries without at least a month are dropped (unusable on month pages).
 */
export function mergeCalendarEntries(entries) {
  const grouped = new Map();
  for (const e of entries) {
    if (!e.month) continue;
    const normalized = normTitle(e.title);
    if (!normalized || !e.platform || !e.url) continue;
    const key = `${normalized}\u0000${e.date ?? `${e.month}-tbc`}`;
    (grouped.get(key) ?? grouped.set(key, []).get(key)).push(e);
  }

  const mergedEntries = [];
  for (const group of grouped.values()) {
    const urlsByPlatform = new Map();
    const trackedSlugs = new Set();
    for (const entry of group) {
      (urlsByPlatform.get(entry.platform) ?? urlsByPlatform.set(entry.platform, new Set()).get(entry.platform)).add(entry.url);
      if (entry.slugIfTracked) trackedSlugs.add(entry.slugIfTracked);
    }
    // Multiple products on the same platform (often standard/generation
    // variants with identical public titles) make cross-platform association
    // ambiguous. Keep each official product as its own row; never choose a URL.
    const ambiguous = [...urlsByPlatform.values()].some((urls) => urls.size > 1)
      || trackedSlugs.size > 1;
    if (ambiguous) {
      const seen = new Set();
      for (const entry of group) {
        const identity = `${entry.platform}\u0000${entry.url}\u0000${entry.slugIfTracked ?? ''}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        mergedEntries.push({
          title: entry.title,
          date: entry.date,
          month: entry.month,
          platforms: [entry.platform],
          urls: { [entry.platform]: entry.url },
          image: entry.image ?? null,
          slugIfTracked: entry.slugIfTracked ?? null,
        });
      }
      continue;
    }

    const [first, ...rest] = group;
    const merged = {
      title: first.title,
      date: first.date,
      month: first.month,
      platforms: [first.platform],
      urls: { [first.platform]: first.url },
      image: first.image ?? null,
      slugIfTracked: first.slugIfTracked ?? null,
    };
    for (const entry of rest) {
      if (!merged.platforms.includes(entry.platform)) merged.platforms.push(entry.platform);
      merged.urls[entry.platform] = entry.url;
      merged.image ??= entry.image ?? null;
      merged.slugIfTracked ??= entry.slugIfTracked ?? null;
    }
    mergedEntries.push(merged);
  }

  const months = {};
  for (const entry of mergedEntries) {
    (months[entry.month] ??= []).push(entry);
  }
  for (const list of Object.values(months)) {
    for (const entry of list) entry.platforms.sort((a, b) => (PLATFORM_ORDER.get(a) ?? 99) - (PLATFORM_ORDER.get(b) ?? 99));
    list.sort((a, b) => (a.date ?? `${a.month}-99`).localeCompare(b.date ?? `${b.month}-99`)
      || a.title.localeCompare(b.title)
      || Object.values(a.urls).join('\0').localeCompare(Object.values(b.urls).join('\0')));
  }
  return Object.fromEntries(Object.entries(months).sort(([a], [b]) => a.localeCompare(b)));
}
