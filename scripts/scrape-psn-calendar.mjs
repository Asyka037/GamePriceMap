/**
 * PlayStation Store US release calendar discovery.
 *
 * Runs separately from PSN price tracking so both jobs stay below the shared
 * 60-page/day envelope. A complete official category + product-page sweep is
 * required before replacing the last good source cache; partial runs only
 * advance failure health and the persistent request ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setRequestBudget, shouldTripCircuit } from './lib/http.mjs';
import {
  PSN_CATEGORY_MAX_PAGES,
  assertCompletePsnPreorderCategoryPages,
  assertUniquePsnCalendarEntries,
  parsePsnCalendarProductPage,
  parsePsnPreorderCategoryPage,
  psnPreorderCategoryUrl,
  releaseWithinWindow,
} from './lib/psn-calendar.mjs';
import {
  acquirePsnUsRequestRun,
  fetchPsnUsPageWithRetry,
  psnUsBudgetStatus,
} from './lib/psn-request-budget.mjs';
import { recordSourceRun } from './lib/sourcehealth.mjs';
import { releaseCalendarCliExitCode } from './lib/release-calendar-run.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'feeds', 'releases-psn.json');
const SOURCE = 'calendar-psn-us';
const hadPreviousCache = fs.existsSync(OUT);
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const slugByProduct = new Map(catalog.games.filter((game) => game.psnProductId)
  .map((game) => [game.psnProductId, game.slug]));

if (process.env.PSN_AUTOMATION_AUTHORIZED !== 'true') {
  console.error('PSN calendar automation is authorized but disabled in this invocation: set PSN_AUTOMATION_AUTHORIZED=true only in an approved job.');
  process.exit(2);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

const releaseRun = acquirePsnUsRequestRun();
let complete = false;
let note = 'calendar discovery did not start';
try {
  setRequestBudget(60);
  const pages = [];
  let failedRequests = 0;
  let failedProducts = 0;
  let skipped = 0;

  try {
    const firstResponse = await fetchPsnUsPageWithRetry(psnPreorderCategoryUrl(1), { label: 'psn preorder category page 1' });
    const first = parsePsnPreorderCategoryPage(firstResponse.text, { page: 1, finalUrl: firstResponse.finalUrl });
    if (!first || first.pageCount > PSN_CATEGORY_MAX_PAGES) throw new Error('PSN preorder category page 1 failed its structural guard');
    pages.push(first);
    for (let page = 2; page <= first.pageCount; page += 1) {
      const response = await fetchPsnUsPageWithRetry(psnPreorderCategoryUrl(page), { label: `psn preorder category page ${page}` });
      const parsed = parsePsnPreorderCategoryPage(response.text, { page, finalUrl: response.finalUrl });
      if (!parsed || parsed.totalCount !== first.totalCount || parsed.pageCount !== first.pageCount) {
        throw new Error(`PSN preorder category page ${page} disagrees with page 1`);
      }
      pages.push(parsed);
    }
  } catch (error) {
    failedRequests++;
    throw error;
  }

  const { totalCount, candidates } = assertCompletePsnPreorderCategoryPages(pages);
  const budget = psnUsBudgetStatus();
  if (budget.remaining < candidates.length) {
    skipped = candidates.length;
    throw new Error(`PSN release sweep needs ${candidates.length} product pages but only ${budget.remaining} requests remain for ${budget.day}`);
  }

  const entries = [];
  let attempted = 0;
  for (const [index, candidate] of candidates.entries()) {
    if (shouldTripCircuit(attempted, failedProducts + failedRequests)) {
      skipped = candidates.length - index;
      break;
    }
    attempted++;
    try {
      const response = await fetchPsnUsPageWithRetry(candidate.sourceUrl, { label: `psn release ${candidate.productId}` });
      const entry = parsePsnCalendarProductPage(response.text, candidate, { finalUrl: response.finalUrl });
      if (!entry) {
        failedProducts++;
        continue;
      }
      if (!releaseWithinWindow(entry.date)) continue;
      entries.push({
        title: entry.title,
        date: entry.date,
        month: entry.month,
        platform: entry.platform,
        url: entry.url,
        image: entry.image,
        slugIfTracked: slugByProduct.get(entry.productId) ?? null,
      });
    } catch (error) {
      failedRequests++;
      if (error?.budget) {
        skipped = candidates.length - index - 1;
        break;
      }
    }
  }

  const sweepComplete = failedRequests === 0 && failedProducts === 0 && skipped === 0 && attempted === candidates.length;
  note = `pages ${pages.length}/${pages[0].pageCount}, category products ${totalCount}, verified preorders ${attempted}/${candidates.length}, published ${entries.length}, failed products ${failedProducts}, failed requests ${failedRequests}, skipped ${skipped}`;
  if (sweepComplete) {
    if (entries.length === 0) throw new Error('PSN release sweep produced no entries inside the guarded window');
    assertUniquePsnCalendarEntries(entries);
    entries.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title) || a.url.localeCompare(b.url));
    atomicWriteJson(OUT, {
      schemaVersion: 1,
      source: SOURCE,
      updatedAt: new Date().toISOString(),
      items: entries,
    });
    complete = true;
  }
} catch (error) {
  complete = false;
  note = `${note}; ${error.message}`;
  console.warn(`PSN release calendar kept previous cache: ${error.message}`);
} finally {
  recordSourceRun(SOURCE, { ok: complete, note });
  releaseRun();
}

console.log(`PSN release calendar ${complete ? 'updated' : 'kept previous cache'}: ${note}`);
process.exitCode = releaseCalendarCliExitCode({ complete, hadPreviousCache });
