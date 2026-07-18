/**
 * PSN US POC: verified standard-edition product mappings, weekly cadence.
 * Failed pages retain their old raw observations. Targeted prefetches never
 * update source-wide freshness; scheduled runs are fail-soft like Xbox B'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchText,
  requestBudgetFor,
  setRequestBudget,
  shouldTripCircuit,
  sleep,
} from './lib/http.mjs';
import { parsePsnProductPage, psnProductUrl, validPsnProductId } from './lib/psn.mjs';
import { assembleRawSnapshot, sameObservations } from './lib/snapshot.mjs';
import { completeSourceRun, recordSourceRun } from './lib/sourcehealth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(ROOT, 'data', 'snapshots', 'psn');
const REQUEST_DELAY_MS = 1500;
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const onlySlugs = process.argv.slice(2);

// PlayStation's current US website terms prohibit automated data collection.
// Unlike Nintendo US, the user has not explicitly accepted that platform's
// automation risk. Keep the engineered POC closed until that separate opt-in
// is deliberately supplied in the invoking environment/repository variable.
if (process.env.PSN_AUTOMATION_AUTHORIZED !== 'true') {
  console.error('PSN automation is disabled: set PSN_AUTOMATION_AUTHORIZED=true only after explicit user authorization.');
  process.exit(2);
}
const games = catalog.games
  .filter((g) => validPsnProductId(g.psnProductId) && g.psnEdition === 'standard')
  .filter((g) => onlySlugs.length === 0 || onlySlugs.includes(g.slug));

if (games.length === 0) {
  console.log('No verified PSN standard-edition mappings in catalog; POC scrape skipped.');
  process.exit(0);
}

setRequestBudget(requestBudgetFor(games.length));
fs.mkdirSync(SNAP_DIR, { recursive: true });
let written = 0;
let unchanged = 0;
let failedProducts = 0;
let failedRequests = 0;
let skipped = 0;
let attempted = 0;
const today = new Date().toISOString().slice(0, 10);

for (const [index, game] of games.entries()) {
  if (shouldTripCircuit(attempted, failedProducts + failedRequests)) {
    skipped = games.length - index;
    console.warn(`PSN US circuit opened after ${attempted} products; ${skipped} left unrequested`);
    break;
  }
  attempted++;
  let response;
  try {
    response = await fetchText(psnProductUrl(game.psnProductId), { label: `psn US ${game.slug}` });
  } catch {
    failedRequests++;
    await sleep(REQUEST_DELAY_MS);
    continue;
  }

  const parsed = parsePsnProductPage(response.text, {
    productId: game.psnProductId,
    expectedTitle: game.title,
    edition: game.psnEdition,
    finalUrl: response.finalUrl,
  });
  if (!parsed) {
    console.warn(`  ${game.slug}: no verified public standard-edition purchase offer; keeping old snapshot`);
    failedProducts++;
    await sleep(REQUEST_DELAY_MS);
    continue;
  }
  if (parsed.annotations.psPlus) {
    console.log(`  ${game.slug}: excluded PS Plus member offer ${parsed.annotations.psPlus.currency} ${parsed.annotations.psPlus.amount}`);
  }

  const snap = assembleRawSnapshot(game.slug, [parsed.row]);
  const snapPath = path.join(SNAP_DIR, `${game.slug}.json`);
  const old = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : null;
  if (old && sameObservations(old, snap)) {
    unchanged++;
  } else {
    snap.lastPriceChangeAt = today;
    fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2) + '\n');
    written++;
  }
  await sleep(REQUEST_DELAY_MS);
}

const complete = completeSourceRun({
  expected: games.length,
  changed: written,
  unchanged,
  skipped,
  failedItems: failedProducts,
  failedRequests,
});
recordSourceRun('psn-us', {
  targeted: onlySlugs.length > 0,
  ok: complete,
  note: `changed ${written}, unchanged ${unchanged}, failed products ${failedProducts}, failed requests ${failedRequests}, skipped ${skipped}, expected ${games.length}`,
});
console.log(`PSN US snapshots changed: ${written}, unchanged: ${unchanged}, failed products: ${failedProducts}, failed requests: ${failedRequests}, skipped: ${skipped}`);
// Deliberately fail-soft: PSN is an isolated POC and source-health exposes a
// partial scheduled run without blocking unrelated weekly jobs.
