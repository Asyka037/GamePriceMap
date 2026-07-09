/**
 * Weekly metadata + review refresh for catalog games (single-appid requests;
 * combined data is allowed there, plan §2.1).
 *
 * Writes: data/meta/{slug}.json
 * Fail-soft per game: a failed fetch keeps the previous meta file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, sleep } from './lib/http.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const META_DIR = path.join(ROOT, 'data', 'meta');
fs.mkdirSync(META_DIR, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const onlySlugs = process.argv.slice(2);
const games = catalog.games
  .filter((g) => Number.isInteger(g.steamAppId))
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));

let written = 0;
for (const g of games) {
  try {
    const details = await fetchJson(
      `https://store.steampowered.com/api/appdetails?appids=${g.steamAppId}&cc=us&l=english`,
      { label: `appdetails ${g.slug}` },
    );
    await sleep(1500);
    const reviews = await fetchJson(
      `https://store.steampowered.com/appreviews/${g.steamAppId}?json=1&language=all&purchase_type=all&num_per_page=0`,
      { label: `appreviews ${g.slug}` },
    );
    await sleep(1500);

    const d = details?.[String(g.steamAppId)]?.data ?? {};
    const q = reviews?.query_summary ?? {};
    const total = q.total_reviews ?? 0;
    const meta = {
      slug: g.slug,
      updatedAt: new Date().toISOString(),
      name: d.name ?? g.title,
      headerImage: d.header_image ?? null,
      genres: (d.genres ?? []).map((x) => x.description),
      releaseDate: d.release_date?.date ?? null,
      comingSoon: d.release_date?.coming_soon ?? false,
      metacritic: d.metacritic?.score ?? null,
      recommendations: d.recommendations?.total ?? null,
      reviewDesc: q.review_score_desc ?? null,
      reviewCount: total,
      reviewPercent: total > 0 ? Math.round((q.total_positive / total) * 100) : null,
    };
    fs.writeFileSync(path.join(META_DIR, `${g.slug}.json`), JSON.stringify(meta, null, 2) + '\n');
    written++;
  } catch (err) {
    console.warn(`  ${g.slug}: ${err.message} — keeping previous meta`);
  }
}
console.log(`Meta written: ${written}/${games.length}`);
if (written === 0) process.exit(1);
