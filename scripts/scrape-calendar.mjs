/**
 * Release calendar (next ~6 months) from degraded sources:
 *   - eShop-EU Solr upcoming (has real dates + NSUIDs)
 *   - Steam featuredcategories.coming_soon, enriched per-app with
 *     appdetails release_date (single-appid requests — combined data is
 *     fine there, see plan §2.1)
 * IGDB replaces this as primary once Twitch credentials are provided.
 *
 * Writes: data/feeds/calendar.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';
import { parseSteamReleaseDate, isJunkComingSoonName, mergeCalendarEntries } from './lib/calendar.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'feeds', 'calendar.json');
const STEAM_LIMIT = 25;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const euNsuidToSlug = new Map(catalog.games.filter((g) => g.nsuids?.europe).map((g) => [g.nsuids.europe, g.slug]));
const appIdToSlug = new Map(catalog.games.filter((g) => g.steamAppId).map((g) => [g.steamAppId, g.slug]));

const entries = [];

// --- eShop EU upcoming ---
try {
  const fq = encodeURIComponent('type:GAME AND dates_released_dts:[NOW TO NOW+180DAYS]');
  const body = await fetchJson(
    `https://searching.nintendo-europe.com/en/select?q=*&fq=${fq}&wt=json&rows=120&sort=dates_released_dts%20asc`,
    { label: 'eu upcoming' },
  );
  for (const doc of body.response?.docs ?? []) {
    const iso = doc.dates_released_dts?.[0];
    if (!iso) continue;
    const date = iso.slice(0, 10);
    const nsuid = (doc.nsuid_txt ?? []).find((n) => String(n).startsWith('7001')) ?? null;
    entries.push({
      title: doc.title,
      date,
      month: date.slice(0, 7),
      platform: 'switch',
      url: doc.url ? `https://www.nintendo.co.uk${doc.url}` : null,
      slugIfTracked: nsuid ? (euNsuidToSlug.get(nsuid) ?? null) : null,
    });
  }
  console.log(`eu upcoming: ${entries.length} entries`);
} catch (err) {
  console.warn(`eu upcoming FAILED (${err.message})`);
}

// --- Steam coming soon ---
try {
  const fc = await fetchJson('https://store.steampowered.com/api/featuredcategories?cc=us&l=english', { label: 'featuredcategories' });
  const ids = (fc.coming_soon?.items ?? [])
    .filter((it) => !isJunkComingSoonName(it.name))
    .map((it) => it.id)
    .slice(0, STEAM_LIMIT);
  let added = 0;
  for (const id of ids) {
    await sleep(1500);
    try {
      const body = await fetchJson(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=english`, { label: `appdetails ${id}` });
      const data = body?.[String(id)]?.data;
      if (!data || data.type !== 'game' || !data.release_date?.coming_soon) continue;
      const { date, month } = parseSteamReleaseDate(data.release_date.date);
      if (!month) continue;
      entries.push({
        title: data.name,
        date,
        month,
        platform: 'pc',
        url: `https://store.steampowered.com/app/${id}/`,
        slugIfTracked: appIdToSlug.get(id) ?? null,
      });
      added++;
    } catch { /* skip one app */ }
  }
  console.log(`steam coming soon: ${added} dated entries`);
} catch (err) {
  console.warn(`steam coming soon FAILED (${err.message})`);
}

if (entries.length === 0) {
  console.error('Calendar: no entries from any source — keeping previous file.');
  process.exit(1);
}

const months = mergeCalendarEntries(entries);
fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), months }, null, 2) + '\n');
const total = Object.values(months).reduce((n, l) => n + l.length, 0);
console.log(`calendar.json: ${Object.keys(months).length} months, ${total} entries`);
