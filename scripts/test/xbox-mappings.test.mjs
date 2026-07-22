import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sealEvidenceDocument, sha256Digest } from '../lib/candidate-evidence.mjs';
import {
  buildXboxMappingCandidate,
  createXboxStabilityLedger,
  createXboxSuggestionDocument,
  validateXboxMappingCandidate,
  validateXboxStabilityLedger,
  validateXboxSuggestionDocument,
  XBOX_MAPPING_EVIDENCE_TTL_MS,
  XBOX_MAPPING_SUGGESTIONS_KIND,
} from '../lib/xbox-mappings.mjs';
import { parseXboxProduct, parseXboxSuggestion, xboxProductsUrl, xboxSuggestUrl } from '../lib/xbox.mjs';

const suggestFixture = JSON.parse(readFileSync(new URL('./fixtures/xbox-autosuggest.json', import.meta.url)));
const productFixture = JSON.parse(readFileSync(new URL('./fixtures/xbox-product.json', import.meta.url)));
const NOW = new Date('2026-07-22T12:00:00.000Z');

function stability(overrides = {}) {
  return createXboxStabilityLedger({
    generatedAt: NOW,
    successes: [
      { lastSuccessAt: '2026-07-12T03:05:22.573Z', expected: 14, changed: 14, unchanged: 0, failedProducts: 0, failedRequests: 0 },
      { lastSuccessAt: '2026-07-20T09:02:00.000Z', expected: 14, changed: 0, unchanged: 14, failedProducts: 0, failedRequests: 0 },
    ],
    ...overrides,
  });
}

function verifiedProduct() {
  const fixture = structuredClone(productFixture);
  fixture.Products[0].DisplaySkuAvailabilities[0].Availabilities[0].Conditions.EndDate = '2026-08-20T00:00:00Z';
  return fixture;
}

function candidate() {
  const productsResponse = verifiedProduct();
  const suggestion = parseXboxSuggestion(suggestFixture, 'Elden Ring');
  const product = parseXboxProduct(productsResponse, {
    bigId: suggestion.bigId,
    expectedTitle: 'Elden Ring',
    edition: 'standard',
  }, NOW.valueOf());
  return buildXboxMappingCandidate({
    entry: { slug: 'elden-ring', title: 'Elden Ring' },
    suggestion,
    product,
    autosuggestUrl: xboxSuggestUrl('Elden Ring'),
    autosuggestResponse: suggestFixture,
    productsUrl: xboxProductsUrl([suggestion.bigId]),
    productsResponse,
    observedAt: NOW,
  });
}

test('Xbox stability ledger requires two complete natural-week runs at least six days apart', () => {
  const ledger = stability();
  assert.equal(validateXboxStabilityLedger(ledger, { now: NOW.valueOf() }).successes.length, 2);
  assert.throws(() => createXboxStabilityLedger({
    generatedAt: NOW,
    successes: [
      { lastSuccessAt: '2026-07-12T00:00:00Z', expected: 14, changed: 14, unchanged: 0, failedProducts: 0, failedRequests: 0 },
      { lastSuccessAt: '2026-07-13T00:00:00Z', expected: 14, changed: 0, unchanged: 14, failedProducts: 0, failedRequests: 0 },
    ],
  }), /only one success per UTC week|at least 6 days/u);
  assert.throws(() => createXboxStabilityLedger({
    generatedAt: NOW,
    successes: [
      { lastSuccessAt: '2026-07-12T00:00:00Z', expected: 14, changed: 14, unchanged: 0, failedProducts: 0, failedRequests: 0 },
      { lastSuccessAt: '2026-07-20T00:00:00Z', expected: 14, changed: 0, unchanged: 13, failedProducts: 1, failedRequests: 0 },
    ],
  }), /zero-failure/u);
});

test('Xbox mapping candidate seals autosuggest, products, standard SKU, public US offer and seven-day TTL evidence', () => {
  const mapping = candidate();
  assert.equal(mapping.candidateId, 'xbox:9P3J32CTXLRZ');
  assert.deepEqual(mapping.platforms, ['xbox']);
  assert.equal(mapping.evidence.gates.purchaseActionRequired, true);
  assert.equal(mapping.evidence.publicUsOffer.currency, 'USD');
  assert.equal(Date.parse(mapping.evidence.expiresAt) - Date.parse(mapping.evidence.observedAt), XBOX_MAPPING_EVIDENCE_TTL_MS);
  assert.equal(validateXboxMappingCandidate(mapping, { now: NOW.valueOf() }), mapping);

  const tampered = structuredClone(mapping);
  tampered.evidence.gates.isTrial = true;
  assert.throws(() => validateXboxMappingCandidate(tampered, { now: NOW.valueOf() }), /digest|gates/u);
  const wrongPlatform = structuredClone(mapping);
  wrongPlatform.platforms = ['pc', 'xbox'];
  assert.throws(() => validateXboxMappingCandidate(wrongPlatform, { now: NOW.valueOf() }), /identity/u);
  assert.throws(() => validateXboxMappingCandidate(mapping, {
    now: Date.parse(mapping.evidence.expiresAt),
  }), /expired/u);
});

test('Xbox public offer ignores entitlement and member-conditioned Purchase prices', () => {
  const productsResponse = verifiedProduct();
  const availabilities = productsResponse.Products[0].DisplaySkuAvailabilities[0].Availabilities;
  const publicOffer = availabilities[0];

  const entitlementOffer = structuredClone(publicOffer);
  entitlementOffer.OrderManagementData.Price.ListPrice = 4.99;
  entitlementOffer.OrderManagementData.GrantedEntitlementKeys = ['XboxGamePassUltimate'];
  availabilities.push(entitlementOffer);

  for (const signal of ['GamePass', 'RequiresSubscription', 'MembershipTier', 'XboxLiveGold']) {
    const memberOffer = structuredClone(publicOffer);
    memberOffer.OrderManagementData.Price.ListPrice = 3.99;
    memberOffer.Conditions.ClientConditions = { eligibility: signal };
    availabilities.push(memberOffer);
  }

  const parsed = parseXboxProduct(productsResponse, {
    bigId: '9P3J32CTXLRZ', expectedTitle: 'Elden Ring', edition: 'standard',
  }, NOW.valueOf());
  assert.equal(parsed.row.amount, 41.99, 'only the unrestricted public Purchase price may win');
});

test('Xbox public offer deduplicates an identical response but rejects distinct public prices', () => {
  const duplicateResponse = verifiedProduct();
  const duplicateAvailabilities = duplicateResponse.Products[0].DisplaySkuAvailabilities[0].Availabilities;
  duplicateAvailabilities.push(structuredClone(duplicateAvailabilities[0]));
  assert.equal(parseXboxProduct(duplicateResponse, {
    bigId: '9P3J32CTXLRZ', expectedTitle: 'Elden Ring', edition: 'standard',
  }, NOW.valueOf()).row.amount, 41.99);

  const ambiguousResponse = verifiedProduct();
  const ambiguousAvailabilities = ambiguousResponse.Products[0].DisplaySkuAvailabilities[0].Availabilities;
  const otherPublicOffer = structuredClone(ambiguousAvailabilities[0]);
  otherPublicOffer.OrderManagementData.Price.ListPrice = 49.99;
  ambiguousAvailabilities.push(otherPublicOffer);
  assert.equal(parseXboxProduct(ambiguousResponse, {
    bigId: '9P3J32CTXLRZ', expectedTitle: 'Elden Ring', edition: 'standard',
  }, NOW.valueOf()), null, 'different unrestricted Purchase prices are ambiguous');
});

test('Xbox suggestion document binds the full stability ledger and rejects duplicate BigIDs', () => {
  const mapping = candidate();
  const document = createXboxSuggestionDocument({
    generatedAt: NOW,
    stabilityEvidence: stability(),
    candidates: [mapping],
    failures: [],
  });
  assert.equal(document.kind, XBOX_MAPPING_SUGGESTIONS_KIND);
  assert.equal(document.stabilityEvidence.documentDigest, stability().documentDigest);
  assert.equal(validateXboxSuggestionDocument(document, { now: NOW.valueOf() }), document);

  const duplicate = structuredClone(mapping);
  duplicate.slug = 'other-game';
  duplicate.title = 'Other Game';
  duplicate.evidence.discovery.queryTitle = 'Other Game';
  duplicate.evidence.discovery.matchedTitle = 'Other Game';
  duplicate.evidence.product.matchedTitle = 'Other Game';
  duplicate.evidence.product.skuTitle = 'Other Game';
  const evidencePayload = { ...duplicate.evidence };
  delete evidencePayload.evidenceDigest;
  duplicate.evidence.evidenceDigest = sha256Digest(evidencePayload);
  duplicate.evidenceDigest = duplicate.evidence.evidenceDigest;
  const payload = {
    schemaVersion: 1,
    kind: XBOX_MAPPING_SUGGESTIONS_KIND,
    discoveryMode: 'official-autosuggest-v1',
    generatedAt: NOW.toISOString(),
    stabilityEvidence: stability(),
    candidates: [mapping, duplicate],
    failures: [],
  };
  const sealed = sealEvidenceDocument(payload);
  assert.throws(() => validateXboxSuggestionDocument(sealed, { now: NOW.valueOf() }), /URL does not match|duplicate/u);
});
