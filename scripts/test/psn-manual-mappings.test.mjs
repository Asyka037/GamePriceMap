import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PSN_MAPPING_EVIDENCE_TTL_MS,
  buildPsnMappingCandidate,
  createPsnSuggestionDocument,
  parseManualPsnProductUrl,
  validatePsnManualInput,
  validatePsnMappingCandidate,
  validatePsnSuggestionDocument,
} from '../lib/psn-manual-mappings.mjs';

const template = JSON.parse(readFileSync(new URL('../../data/suggestions/psn-manual-input.json', import.meta.url)));
const NOW = Date.parse('2026-07-18T12:00:00.000Z');
const ELDEN_ID = 'UP0700-PPSA04610_00-ELDENRING0000000';
const ELDEN_URL = `https://store.playstation.com/en-us/product/${ELDEN_ID}`;

function catalogFor(document = template) {
  return {
    games: document.entries.map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      platforms: ['pc'],
    })),
  };
}

function readyInput() {
  const document = structuredClone(template);
  document.entries[0].productUrl = ELDEN_URL;
  document.entries[0].selectedAt = '2026-07-18T04:30:00.000Z';
  return document;
}

function parsedElden() {
  return {
    productId: ELDEN_ID,
    conceptId: '10000333',
    matchedTitle: 'ELDEN RING PS4 & PS5',
    edition: 'standard',
    platforms: ['ps4', 'ps5'],
    skuId: `${ELDEN_ID}-U001`,
    row: {
      cc: 'US', currency: 'USD', amount: 59.99, list: null,
      discountPct: null, saleEndsAt: null,
    },
    annotations: { psPlus: null, excludedTrials: 0 },
  };
}

test('the 12-row manual queue validates without guessing ids or making rows ready', () => {
  const result = validatePsnManualInput(template, { catalog: catalogFor(), now: NOW });
  assert.equal(result.entries.length, 12);
  assert.equal(result.ready.length, 0);
  assert.equal(result.pending.length, 12);
  assert.ok(result.pending.every((entry) => entry.productId === null));
});

test('only a clean official en-us product URL can become ready', () => {
  assert.deepEqual(parseManualPsnProductUrl(`${ELDEN_URL}/`), {
    productId: ELDEN_ID,
    canonicalUrl: ELDEN_URL,
  });
  for (const value of [
    `https://example.com/en-us/product/${ELDEN_ID}`,
    `${ELDEN_URL}?tracking=1`,
    'https://store.playstation.com/en-us/concept/10000333',
    'https://store.playstation.com/en-us/product/not-an-id',
  ]) assert.throws(() => parseManualPsnProductUrl(value));

  const result = validatePsnManualInput(readyInput(), { catalog: catalogFor(), now: NOW });
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0].productId, ELDEN_ID);
});

test('manual input rejects duplicate ids, unknown slugs, title drift and future attestations', () => {
  const duplicate = readyInput();
  duplicate.entries[1].productUrl = ELDEN_URL;
  duplicate.entries[1].selectedAt = duplicate.entries[0].selectedAt;
  assert.throws(() => validatePsnManualInput(duplicate, { catalog: catalogFor(), now: NOW }), /duplicate manual PSN product id/);

  const unknown = structuredClone(template);
  unknown.entries[0].slug = 'not-in-catalog';
  assert.throws(() => validatePsnManualInput(unknown, { catalog: catalogFor(), now: NOW }), /absent from catalog/);

  const wrongTitle = structuredClone(template);
  wrongTitle.entries[0].title = 'Elden Ring Deluxe';
  assert.throws(() => validatePsnManualInput(wrongTitle, { catalog: catalogFor(), now: NOW }), /title mismatch/);

  const future = readyInput();
  future.entries[0].selectedAt = '2026-07-19T00:00:00.000Z';
  assert.throws(() => validatePsnManualInput(future, { catalog: catalogFor(), now: NOW }), /future/);
});

test('verified candidate binds title, product, platforms, public price, digest and seven-day TTL', () => {
  const entry = validatePsnManualInput(readyInput(), { catalog: catalogFor(), now: NOW }).ready[0];
  const candidate = buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: new Date(NOW),
    finalUrl: ELDEN_URL,
  });
  assert.equal(candidate.candidateId, `psn:${ELDEN_ID}`);
  assert.equal(candidate.catalogAction, 'add_platform_mapping');
  assert.deepEqual(candidate.platforms, ['ps4', 'ps5']);
  assert.equal(candidate.evidence.publicUsOffer.amount, 59.99);
  assert.equal(Date.parse(candidate.evidence.expiresAt) - Date.parse(candidate.evidence.observedAt), PSN_MAPPING_EVIDENCE_TTL_MS);
  assert.equal(validatePsnMappingCandidate(candidate, { now: NOW }), candidate);

  const tampered = structuredClone(candidate);
  tampered.evidence.publicUsOffer.amount = 0.01;
  assert.throws(() => validatePsnMappingCandidate(tampered, { now: NOW }), /digest mismatch/);
  assert.throws(() => validatePsnMappingCandidate(candidate, {
    now: Date.parse(candidate.evidence.expiresAt),
  }), /expired/);
});

test('authorized official-search candidates bind the locator page and exact result card', () => {
  const entry = validatePsnManualInput(readyInput(), { catalog: catalogFor(), now: NOW }).ready[0];
  const searchUrl = 'https://store.playstation.com/en-us/search/elden%20ring';
  const candidate = buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: NOW,
    finalUrl: ELDEN_URL,
    discovery: {
      kind: 'psn-official-search-result',
      sourceUrl: searchUrl,
      finalUrl: searchUrl,
      queryTitle: 'Elden Ring',
      matchedTitle: 'ELDEN RING PS4 & PS5',
      productId: ELDEN_ID,
      rank: 0,
      pageDigest: `sha256:${'a'.repeat(64)}`,
    },
  });
  assert.equal(candidate.evidence.discovery.productId, ELDEN_ID);
  assert.equal(validatePsnMappingCandidate(candidate, { now: NOW }), candidate);

  const tampered = structuredClone(candidate);
  tampered.evidence.discovery.finalUrl = 'https://store.playstation.com/en-us/search/different';
  assert.throws(() => validatePsnMappingCandidate(tampered, { now: NOW }), /digest mismatch|discovery evidence/);
});

test('candidate creation rejects wrong title, wrong final URL and overlong evidence TTL', () => {
  const entry = validatePsnManualInput(readyInput(), { catalog: catalogFor(), now: NOW }).ready[0];
  assert.throws(() => buildPsnMappingCandidate(entry, {
    ...parsedElden(), matchedTitle: 'Elden Ring Digital Deluxe',
  }, { observedAt: NOW, finalUrl: ELDEN_URL }), /title/);
  assert.throws(() => buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: NOW,
    finalUrl: 'https://store.playstation.com/en-us/product/UP9000-PPSA21564_00-0000000000000000',
  }), /final URL/);

  const overlong = buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: NOW,
    finalUrl: ELDEN_URL,
    evidenceTtlMs: PSN_MAPPING_EVIDENCE_TTL_MS + 1,
  });
  assert.throws(() => validatePsnMappingCandidate(overlong, { now: NOW }), /TTL/);
});

test('suggestion document is day-1-only, sealed, and contains no catalog mutation', () => {
  const entry = validatePsnManualInput(readyInput(), { catalog: catalogFor(), now: NOW }).ready[0];
  const candidate = buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: NOW,
    finalUrl: ELDEN_URL,
  });
  const document = createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [candidate],
    pending: ['baldurs-gate-3'],
    failures: [],
  });
  assert.equal(document.stabilityStatus, 'day-1-only');
  assert.equal(document.discoveryMode, 'manual-official-url');
  assert.equal('catalog' in document, false);
  assert.equal(validatePsnSuggestionDocument(document, { now: NOW }), document);

  const tampered = structuredClone(document);
  tampered.pending.push('invented');
  assert.throws(() => validatePsnSuggestionDocument(tampered, { now: NOW }), /documentDigest mismatch/);

  const automated = createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [],
    pending: [],
    failures: [],
    discoveryMode: 'official-search-v1',
  });
  assert.equal(validatePsnSuggestionDocument(automated, { now: NOW }), automated);

  assert.throws(() => createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [candidate],
    pending: [],
    failures: [],
    discoveryMode: 'official-search-v1',
  }), /lacks discovery evidence/);

  const searchUrl = 'https://store.playstation.com/en-us/search/elden%20ring';
  const discovered = buildPsnMappingCandidate(entry, parsedElden(), {
    observedAt: NOW,
    finalUrl: ELDEN_URL,
    discovery: {
      kind: 'psn-official-search-result',
      sourceUrl: searchUrl,
      finalUrl: searchUrl,
      queryTitle: 'Elden Ring',
      matchedTitle: 'ELDEN RING PS4 & PS5',
      productId: ELDEN_ID,
      rank: 0,
      pageDigest: `sha256:${'a'.repeat(64)}`,
    },
  });
  const discoveredDocument = createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [discovered],
    pending: [],
    failures: [],
    discoveryMode: 'official-search-v1',
  });
  assert.equal(validatePsnSuggestionDocument(discoveredDocument, { now: NOW }), discoveredDocument);
  assert.throws(() => createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [discovered],
    pending: [],
    failures: [],
  }), /must not contain automated discovery evidence/);

  assert.throws(() => createPsnSuggestionDocument({
    generatedAt: NOW,
    candidates: [candidate, structuredClone(candidate)],
    pending: [],
    failures: [],
  }), /duplicate PSN suggestion/);
});
