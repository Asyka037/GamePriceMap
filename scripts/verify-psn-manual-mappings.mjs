/**
 * Verify manually selected PlayStation Store product URLs. This is not a
 * search crawler: it only visits exact en-us product URLs supplied in the
 * bounded input file and writes suggestions, never catalog.json. The user
 * accepted PlayStation automation risk on 2026-07-18; non-empty execution
 * still requires the explicit PSN_AUTOMATION_AUTHORIZED accident guard.
 *
 * Usage:
 *   node scripts/verify-psn-manual-mappings.mjs [input.json]
 *   node scripts/verify-psn-manual-mappings.mjs --apply [input.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setRequestBudget,
  shouldTripCircuit,
} from './lib/http.mjs';
import {
  buildPsnMappingCandidate,
  createPsnSuggestionDocument,
  validatePsnManualInput,
} from './lib/psn-manual-mappings.mjs';
import { parsePsnProductPage } from './lib/psn.mjs';
import { writePsnSuggestionDocument } from './lib/psn-suggestion-output.mjs';
import {
  acquirePsnUsRequestRun,
  fetchPsnUsPage,
} from './lib/psn-request-budget.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_INPUT = path.join(ROOT, 'data', 'suggestions', 'psn-manual-input.json');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter((arg) => arg !== '--apply');
if (positional.length > 1) throw new Error('Expected at most one manual input path');
const inputPath = positional[0] ? path.resolve(positional[0]) : DEFAULT_INPUT;
const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'catalog.json'), 'utf8'));
const validated = validatePsnManualInput(input, { catalog });

console.log(`PSN manual queue: ${validated.ready.length} ready, ${validated.pending.length} pending`);
if (validated.ready.length === 0) {
  console.log('No product URLs supplied; no network requests or suggestion writes performed.');
  process.exit(0);
}

if (process.env.PSN_AUTOMATION_AUTHORIZED !== 'true') {
  console.error('PSN page verification is authorized but disabled in this invocation: set PSN_AUTOMATION_AUTHORIZED=true only in an approved job.');
  process.exit(2);
}

const releaseRun = acquirePsnUsRequestRun();
try {
  setRequestBudget(validated.ready.length);
  const candidates = [];
  const failures = [];
  let attempted = 0;
  for (const [index, entry] of validated.ready.entries()) {
    if (shouldTripCircuit(attempted, failures.length)) {
      for (const skipped of validated.ready.slice(index)) {
        failures.push({ slug: skipped.slug, reason: 'circuit_open_unrequested' });
      }
      break;
    }
    attempted++;
    try {
      const response = await fetchPsnUsPage(entry.canonicalUrl, {
        label: `psn manual verify ${entry.slug}`,
      });
      const parsed = parsePsnProductPage(response.text, {
        productId: entry.productId,
        expectedTitle: entry.title,
        edition: 'standard',
        finalUrl: response.finalUrl,
      });
      if (!parsed) throw new Error('product_identity_edition_or_public_offer_failed');
      const candidate = buildPsnMappingCandidate(entry, parsed, { finalUrl: response.finalUrl });
      candidates.push(candidate);
      console.log(`${entry.slug.padEnd(36)} ${candidate.psnProductId} · ${candidate.platforms.join('+')}`);
    } catch (error) {
      if (error?.budget || error?.code === 'psn_us_budget_locked') {
        for (const unrequested of validated.ready.slice(index)) {
          failures.push({ slug: unrequested.slug, reason: 'persistent_request_budget_unrequested' });
        }
        console.warn(`  ${entry.slug}: persistent request budget stopped verification; remaining pages unrequested`);
        break;
      }
      const reason = error?.budget ? 'request_budget_exhausted'
        : error?.status ? `http_${error.status}`
          : error?.message === 'product_identity_edition_or_public_offer_failed'
            ? error.message
            : 'verification_error';
      failures.push({ slug: entry.slug, reason });
      console.warn(`  ${entry.slug}: ${reason}; candidate dropped`);
    }
  }

  const document = createPsnSuggestionDocument({
    candidates,
    pending: validated.pending.map((entry) => entry.slug),
    failures,
  });
  console.log(`Verified PSN mapping candidates: ${candidates.length}/${validated.ready.length}; failures: ${failures.length}`);
  if (!apply) {
    console.log('Dry run. Re-run with --apply to write data/suggestions/psn-candidates.json; catalog remains unchanged.');
  } else {
    writePsnSuggestionDocument(document);
    console.log(`${candidates.length} candidate(s) written to data/suggestions/psn-candidates.json; catalog unchanged.`);
  }
} finally {
  releaseRun();
}
