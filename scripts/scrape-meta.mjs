/**
 * Metadata + review refresh for catalog games (single-appid requests;
 * combined data is allowed there, plan §2.1).
 *
 * Usage:
 *   node scripts/scrape-meta.mjs                 # full sweep (manual / migration)
 *   node scripts/scrape-meta.mjs slug ...        # targeted (no source-health)
 *   node scripts/scrape-meta.mjs --shard=auto|N  # daily 1/14 catch-up shard
 *
 * Writes: data/meta/{slug}.json
 * Fail-soft per game: a failed fetch keeps the previous meta file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, fetchText, sleep } from './lib/http.mjs';
import { parseNintendoMeta } from './lib/nintendo-meta.mjs';
import { looksDegraded } from './lib/meta-guard.mjs';
import { completeSourceRun, recordSourceRun, readSourceHealth } from './lib/sourcehealth.mjs';
import { shardOf, pickOverdueShard, coveredMetaKeys, META_SHARDS } from './lib/schedule.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const META_DIR = path.join(ROOT, 'data', 'meta');
fs.mkdirSync(META_DIR, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const args = process.argv.slice(2);
const shardArg = args.find((a) => a.startsWith('--shard='))?.split('=')[1] ?? null;
const onlySlugs = args.filter((a) => !a.startsWith('--'));
if (shardArg && onlySlugs.length > 0) {
  console.error('--shard and slug arguments are mutually exclusive.');
  process.exit(1);
}
let shard = null;
if (shardArg !== null) {
  shard = shardArg === 'auto' ? pickOverdueShard(readSourceHealth(), 'meta', META_SHARDS, 'shard') : Number(shardArg);
  if (!(Number.isInteger(shard) && shard >= 0 && shard < META_SHARDS)) {
    console.error(`Bad shard "${shardArg}" (0..${META_SHARDS - 1} or auto).`);
    process.exit(1);
  }
  console.log(`meta shard ${shard} selected${shardArg === 'auto' ? ' (most overdue)' : ''}`);
}
const games = catalog.games
  .filter((g) => Number.isInteger(g.steamAppId)
    || (g.nsuids?.americas && g.nintendoUsSlug))
  .filter((g) => shard === null || shardOf(g.slug, META_SHARDS) === shard)
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));


function sameMeta(previous, next) {
  if (!previous) return false;
  const withoutCheckStamp = ({ updatedAt: _updatedAt, ...meta }) => meta;
  return JSON.stringify(withoutCheckStamp(previous)) === JSON.stringify(withoutCheckStamp(next));
}

async function steamMeta(g) {
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
  return {
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
}

async function nintendoMeta(g) {
  const url = `https://www.nintendo.com/us/store/products/${g.nintendoUsSlug}/`;
  const { text, finalUrl } = await fetchText(url, {
    label: `Nintendo metadata ${g.slug}`,
    headers: {
      // Nintendo's product frontend serves structured data only to a browser
      // user agent; all transport/retry behavior still goes through http.mjs.
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    },
  });
  if (new URL(finalUrl).pathname !== `/us/store/products/${g.nintendoUsSlug}/`) {
    throw new Error(`unexpected Nintendo redirect to ${finalUrl}`);
  }
  const parsed = parseNintendoMeta(text, {
    slug: g.slug,
    title: g.title,
    nsuid: g.nsuids.americas,
    platforms: g.platforms,
    productSlug: g.nintendoUsSlug,
  });
  if (!parsed) throw new Error('official page identity or metadata guard failed');
  await sleep(1200);
  return parsed;
}

let written = 0;
let unchanged = 0;
let failed = 0;
for (const g of games) {
  try {
    const meta = Number.isInteger(g.steamAppId) ? await steamMeta(g) : await nintendoMeta(g);
    const metaPath = path.join(META_DIR, `${g.slug}.json`);
    const previous = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
    if (looksDegraded(previous, meta)) {
      console.warn(`  ${g.slug}: response hollowed out (image/genres/reviews vanished) — keeping previous meta`);
      failed++;
      continue;
    }
    if (sameMeta(previous, meta)) {
      unchanged++;
      continue;
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    written++;
  } catch (err) {
    console.warn(`  ${g.slug}: ${err.message} — keeping previous meta`);
    failed++;
  }
}
const complete = completeSourceRun({ expected: games.length, changed: written, unchanged, failedItems: failed });
if (onlySlugs.length === 0) {
  const note = `changed ${written}, unchanged ${unchanged}, failed games ${failed}, expected ${games.length}`;
  for (const key of coveredMetaKeys({ shard })) {
    recordSourceRun(key, { ok: complete, note });
  }
}
console.log(`Meta changed: ${written}, unchanged: ${unchanged}, failed: ${failed}, expected: ${games.length}`);
if (onlySlugs.length > 0 && !complete) process.exit(1);
