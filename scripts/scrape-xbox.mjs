/**
 * Xbox B' POC: approved catalog mappings, US market only, weekly cadence.
 * A failed source/product keeps old observations. Partial runs conservatively
 * do not advance source lastSuccessAt, because chart freshness is source-wide.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchJson, chunk, sleep } from './lib/http.mjs';
import { xboxProductsUrl, parseXboxProduct, XBOX_BATCH_SIZE } from './lib/xbox.mjs';
import { assembleRawSnapshot, sameObservations } from './lib/snapshot.mjs';
import { recordSourceRun, completeSourceRun } from './lib/sourcehealth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'xbox');
const REQUEST_DELAY_MS = 1200;
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const onlySlugs = process.argv.slice(2);
const games = catalog.games
  .filter((g) => /^[A-Z0-9]{12}$/.test(g.xboxBigId ?? '') && g.xboxEdition === 'standard')
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));

if (games.length === 0) {
  console.log('No human-approved Xbox mappings in catalog; POC scrape skipped.');
  process.exit(0);
}

const productBodies = [];
let failedRequests = 0;
for (const batch of chunk(games, XBOX_BATCH_SIZE)) {
  try {
    productBodies.push(await fetchJson(xboxProductsUrl(batch.map((g) => g.xboxBigId)), { label: 'xbox US batch' }));
  } catch {
    failedRequests++;
  }
  await sleep(REQUEST_DELAY_MS);
}
const mergedBody = { Products: productBodies.flatMap((b) => b?.Products ?? []) };

fs.mkdirSync(SNAP_DIR, { recursive: true });
let written = 0;
let unchanged = 0;
let failedProducts = 0;
const today = new Date().toISOString().slice(0, 10);
for (const game of games) {
  const parsed = parseXboxProduct(mergedBody, {
    bigId: game.xboxBigId,
    expectedTitle: game.title,
    edition: game.xboxEdition,
  });
  if (!parsed) {
    console.warn(`  ${game.slug}: no verified purchasable standard-edition offer; keeping old snapshot`);
    failedProducts++;
    continue;
  }
  const snap = assembleRawSnapshot(game.slug, [parsed.row]);
  const snapPath = path.join(SNAP_DIR, `${game.slug}.json`);
  const old = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : null;
  if (old && sameObservations(old, snap)) {
    unchanged++;
    continue;
  }
  snap.lastPriceChangeAt = today;
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n');
  written++;
}

const complete = completeSourceRun({ expected: games.length, changed: written, unchanged, failedItems: failedProducts, failedRequests });
recordSourceRun('xbox-us', {
  ok: complete,
  note: `changed ${written}, unchanged ${unchanged}, failed products ${failedProducts}, failed requests ${failedRequests}, expected ${games.length}`,
});
console.log(`Xbox US snapshots changed: ${written}, unchanged: ${unchanged}, failed products: ${failedProducts}, failed requests: ${failedRequests}`);
// Deliberately fail-soft: Xbox is an isolated POC channel and must not block
// unrelated weekly metadata/calendar updates. source-health exposes failures.
