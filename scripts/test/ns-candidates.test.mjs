import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertDocumentDigest, sha256Digest } from '../lib/candidate-evidence.mjs';
import {
  NINTENDO_EXCLUSIVITY,
  buildNintendoSuggestion,
  classifyNintendoExclusivity,
  createNintendoSeedDocument,
  createNintendoSuggestionDocument,
  derivePopularity,
  discoverNintendoCandidates,
  guardDuplicateNintendoCandidates,
  parseDiscoverNsuidArgs,
  sealDatedEvidence,
  sealManualUsEvidence,
  sealRegionalDiscoveryEvidence,
  sortNintendoSuggestions,
  stableNintendoCandidateId,
  validateManualUsEvidence,
  validateNintendoSeedCandidate,
  validateNintendoSeedDocument,
  validateNintendoSuggestionDocument,
} from '../lib/ns-candidates.mjs';
import { assertSafeDiscoveryPaths } from '../discover-nsuid.mjs';
import { applyBatchToCatalog, validateCatalogGame } from '../lib/catalog.mjs';
import {
  APPLY_STATUS,
  VERIFY_STATUS,
  createEmptyImportState,
  joinCandidatesWithState,
  projectBatchItem,
  transitionVerify,
} from '../lib/import-state.mjs';
import { createBatchPlan } from '../lib/import-run.mjs';

const rawSeed = JSON.parse(readFileSync(
  new URL('./fixtures/ns-candidate-seed.json', import.meta.url),
  'utf8',
));

function seed(overrides = {}) {
  const candidate = structuredClone({ ...rawSeed, ...overrides });
  if (candidate.manualUsEvidence && !candidate.manualUsEvidence.evidenceDigest) {
    candidate.manualUsEvidence = sealManualUsEvidence(candidate.manualUsEvidence);
  }
  return candidate;
}

function regional(region, nsuid, { generation = 'HAC', title = 'Example Game', ...extra } = {}) {
  const host = region === 'europe' ? 'https://searching.nintendo-europe.com/en/select' : 'https://search.nintendo.jp/nintendo_soft/search.json';
  return sealRegionalDiscoveryEvidence({
    status: 'matched',
    region,
    nsuid,
    matchedTitle: title,
    generation,
    paid: true,
    released: true,
    sourceUrl: host,
    collectedAt: '2026-07-17T00:00:00.000Z',
    sourceDigest: sha256Digest({ region, nsuid }),
    ...extra,
  });
}

function officialEvidence(classification, extra = {}) {
  return sealDatedEvidence({
    kind: 'official_platform_evidence',
    classification,
    title: 'Example Game',
    publisher: 'Example Studio',
    statement: classification === 'first_party' ? undefined : 'Reviewed official platform statement',
    sourceUrl: 'https://www.nintendo.com/us/store/products/example-game-switch/',
    observedAt: '2026-07-17T00:00:00.000Z',
    ...extra,
  });
}

function steamEvidence(status, extra = {}) {
  return sealDatedEvidence({
    kind: 'steam_match',
    status,
    sourceUrl: 'https://store.steampowered.com/app/42/',
    observedAt: '2026-07-17T00:00:00.000Z',
    ...extra,
  });
}

test('strict CLI accepts --input and catalog compatibility, rejects ambiguous/unknown args', () => {
  assert.deepEqual(parseDiscoverNsuidArgs(['--apply', '--input', 'seeds.json', '--output=out.json']), {
    apply: true,
    inputPath: 'seeds.json',
    outputPath: 'out.json',
    slugs: [],
  });
  assert.deepEqual(parseDiscoverNsuidArgs(['zelda-botw']), {
    apply: false,
    inputPath: null,
    outputPath: null,
    slugs: ['zelda-botw'],
  });
  assert.throws(() => parseDiscoverNsuidArgs(['--input', 'a.json', 'slug']), { code: 'input_slug_conflict' });
  assert.throws(() => parseDiscoverNsuidArgs(['--wat']), { code: 'unknown_cli_option' });
  assert.throws(() => parseDiscoverNsuidArgs(['--output', 'x.json']), { code: 'output_requires_apply' });
  assert.throws(
    () => assertSafeDiscoveryPaths({ outputPath: 'data/catalog.json' }),
    { code: 'catalog_output_forbidden' },
  );
  assert.throws(
    () => assertSafeDiscoveryPaths({ inputPath: 'reviewed.json', outputPath: 'reviewed.json' }),
    { code: 'input_output_conflict' },
  );
});

test('manual US evidence is exact URL/title/NSUID/generation bound and detects drift', () => {
  const candidate = seed();
  const validated = validateManualUsEvidence(candidate.manualUsEvidence, candidate);
  assert.equal(validated.nsuid, '70010000000011');
  assert.equal(validated.manual, true);

  const tampered = { ...candidate.manualUsEvidence, nsuid: '70010000000012' };
  assert.throws(() => validateManualUsEvidence(tampered, candidate), { code: 'evidence_digest_mismatch' });
  const guessed = sealManualUsEvidence({
    ...rawSeed.manualUsEvidence,
    sourceUrl: 'https://www.nintendo.com/us/store/products/guessed-slug/',
  });
  assert.throws(() => validateManualUsEvidence(guessed, candidate), { code: 'manual_us_url_slug_mismatch' });
});

test('seed document requires frozen identity and dated evidence; document drift is rejected', () => {
  const candidate = seed();
  const document = createNintendoSeedDocument({
    generatedAt: '2026-07-17T00:00:00.000Z',
    candidates: [candidate],
  });
  assert.equal(validateNintendoSeedDocument(document), document);
  const drifted = structuredClone(document);
  drifted.candidates[0].title = 'Different Game';
  assert.throws(() => validateNintendoSeedDocument(drifted), /documentDigest mismatch/u);

  const unsupported = { ...candidate, candidateId: null, manualUsEvidence: null, seedEvidence: [] };
  assert.throws(() => validateNintendoSeedCandidate(unsupported), { code: 'missing_candidate_id' });
  assert.throws(
    () => validateNintendoSeedCandidate({ ...unsupported, candidateId: 'ns:70010000000011' }),
    { code: 'seed_evidence_missing' },
  );
});

test('candidateId freezes after first assignment; missing IDs use AM then EU then JP exactly once', () => {
  assert.equal(stableNintendoCandidateId(null, {
    americas: '70010000000011',
    europe: '70010000000012',
    japan: '70010000000013',
  }), 'ns:70010000000011');
  assert.equal(stableNintendoCandidateId(null, {
    americas: null,
    europe: '70010000000012',
    japan: '70010000000013',
  }), 'ns:70010000000012');
  assert.equal(stableNintendoCandidateId('ns:70010000000012', {
    americas: '70010000000011',
    europe: '70010000000012',
    japan: '70010000000013',
  }), 'ns:70010000000012');
});

test('discovery orchestration calls only injected EU/JP sources; Americas comes solely from manual evidence', async () => {
  const calls = [];
  const [result] = await discoverNintendoCandidates([seed()], {
    discoverEurope: async () => {
      calls.push('eu');
      return regional('europe', '70010000000012');
    },
    discoverJapan: async () => {
      calls.push('jp');
      return regional('japan', '70010000000013');
    },
  });
  assert.deepEqual(calls, ['eu', 'jp']);
  assert.equal(result.nsuids.americas, '70010000000011');
  assert.equal(result.nsuidAm, result.nsuids.americas);
  assert.equal(result.nsuidEu, result.nsuids.europe);
  assert.equal(result.nsuidJp, result.nsuids.japan);
  assert.equal(result.sourceUrl, rawSeed.manualUsEvidence.sourceUrl);
  assert.equal(result.catalogAction, 'new_game');
  assert.equal(result.nintendoUsSlug, 'example-game-switch');
  assert.equal(result.primaryRegionalChannel, 'eshop');
  assert.equal(result.humanDecision, '待定');
  assert.equal(result.verifyStatus, 'passed');
  assert.equal(result.manualUsEvidence.manual, true);
  assert.equal(result.manualUsEvidence.sourceEvidence.productSlug, 'example-game-switch');
  assert.equal(
    result.manualUsEvidence.sourceDigest,
    result.manualUsEvidence.sourceEvidence.evidenceDigest,
  );
});

test('a passed suggestion projects into the shared Phase B plan and a valid Nintendo-only catalog row', () => {
  const suggestion = buildNintendoSuggestion(seed(), {
    europe: regional('europe', '70010000000012'),
    japan: regional('japan', '70010000000013'),
  });
  assert.equal(suggestion.verifyStatus, 'passed');

  const approvedSource = { ...suggestion, humanDecision: '批准' };
  const emptyState = createEmptyImportState();
  const [pendingMachine] = joinCandidatesWithState([approvedSource], emptyState);
  const verifiedState = transitionVerify(emptyState, pendingMachine, VERIFY_STATUS.PASSED, {
    at: '2026-07-17T00:00:00.000Z',
  });
  const [verified] = joinCandidatesWithState([approvedSource], verifiedState);
  assert.equal(verified.applyStatus, APPLY_STATUS.NOT_APPLIED);
  const item = projectBatchItem(verified);
  assert.equal(item.catalogAction, 'new_game');
  assert.equal(item.nintendoUsSlug, 'example-game-switch');
  assert.equal(item.primaryRegionalChannel, 'eshop');

  const plan = createBatchPlan({
    batchId: 'ns-0001',
    baseCommit: 'a'.repeat(40),
    branch: 'main',
    addedAt: '2026-07-17',
    items: [item],
  });
  const catalog = applyBatchToCatalog({ games: [] }, plan);
  assert.equal(catalog.games.length, 1);
  assert.equal(validateCatalogGame(catalog.games[0]), catalog.games[0]);
  assert.deepEqual(catalog.games[0], {
    slug: 'example-game',
    title: 'Example Game',
    nintendoUsSlug: 'example-game-switch',
    steamAppId: null,
    nsuids: {
      americas: '70010000000011',
      europe: '70010000000012',
      japan: '70010000000013',
    },
    platforms: ['switch'],
    tier: 'extended',
    addedAt: '2026-07-17',
    primaryRegionalChannel: 'eshop',
  });
});

test('catalog compatibility candidates without manual US evidence stay explicit exceptions', () => {
  const result = buildNintendoSuggestion({
    candidateId: null,
    slug: 'catalog-only-game',
    title: 'Catalog Only Game',
    platforms: ['switch'],
    catalogAction: 'new_game',
    seedEvidence: [],
  }, {
    europe: regional('europe', '70010000000421', { title: 'Catalog Only Game' }),
    japan: regional('japan', '70010000000422', { title: 'Catalog Only Game' }),
  });
  assert.equal(result.verifyStatus, 'exception');
  assert.ok(result.exceptionReasons.includes('manual_us_evidence_missing'));
  assert.ok(result.exceptionReasons.includes('popularity_evidence_missing'));
  assert.equal(result.nintendoUsSlug, null);
});

test('missing dated popularity evidence is an exception, never a machine-passed popular candidate', () => {
  const result = buildNintendoSuggestion(seed({ popularityEvidence: [] }), {
    europe: regional('europe', '70010000000012'),
    japan: regional('japan', '70010000000013'),
  });
  assert.equal(result.popularityUnverified, true);
  assert.equal(result.verifyStatus, 'exception');
  assert.ok(result.exceptionReasons.includes('popularity_evidence_missing'));
});

test('generation conflict, catalog conflicts and cross-candidate duplicates fail closed', () => {
  const generationConflict = buildNintendoSuggestion(seed({ platforms: ['switch', 'switch-2'] }), {
    europe: regional('europe', '70010000000012', { generation: 'BEE' }),
    japan: regional('japan', '70010000000013', { generation: 'HAC' }),
  });
  assert.equal(generationConflict.verifyStatus, 'exception');
  assert.ok(generationConflict.exceptionReasons.includes('generation_fingerprint_conflict'));

  const catalogConflict = buildNintendoSuggestion(seed(), {}, {
    existingNsuids: new Set(['70010000000011']),
  });
  assert.ok(catalogConflict.exceptionReasons.includes('catalog_nsuid_conflict:70010000000011'));

  const first = buildNintendoSuggestion(seed(), { europe: regional('europe', '70010000000999') });
  const secondSeed = seed({
    candidateId: 'ns:70010000000021',
    slug: 'another-game',
    title: 'Another Game',
    manualUsEvidence: sealManualUsEvidence({
      ...rawSeed.manualUsEvidence,
      productSlug: 'another-game-switch',
      sourceUrl: 'https://www.nintendo.com/us/store/products/another-game-switch/',
      nsuid: '70010000000021',
      title: 'Another Game',
    }),
  });
  const second = buildNintendoSuggestion(secondSeed, {
    europe: regional('europe', '70010000000999', { title: 'Another Game' }),
  });
  const guarded = guardDuplicateNintendoCandidates([first, second]);
  assert.ok(guarded.every((candidate) => candidate.verifyStatus === 'exception'));
  assert.ok(guarded.every((candidate) => candidate.exceptionReasons.includes('duplicate_nsuid:70010000000999')));
});

test('exclusivity has exactly three affirmative states; exact title without org overlap stays unverified', () => {
  const official = seed({ exclusivityEvidence: officialEvidence('first_party') });
  assert.equal(classifyNintendoExclusivity(official).classification, NINTENDO_EXCLUSIVITY.OFFICIAL);

  const noSteam = seed({ steamMatchEvidence: steamEvidence('not_found') });
  assert.equal(classifyNintendoExclusivity(noSteam).classification, NINTENDO_EXCLUSIVITY.UNVERIFIED);

  const publisherMismatch = seed({
    steamMatchEvidence: steamEvidence('exact_title', {
      steamAppId: 42,
      title: 'Example Game',
      publisher: 'Different Publisher',
      developer: 'Different Developer',
    }),
  });
  const possible = classifyNintendoExclusivity(publisherMismatch);
  assert.equal(possible.classification, NINTENDO_EXCLUSIVITY.UNVERIFIED);
  assert.equal(possible.possibleCrossPlatform, true);

  const overlap = seed({
    steamMatchEvidence: steamEvidence('exact_title', {
      steamAppId: 42,
      title: 'Example Game',
      publisher: 'Example Studio Ltd.',
    }),
  });
  assert.equal(classifyNintendoExclusivity(overlap).classification, NINTENDO_EXCLUSIVITY.KNOWN_CROSS_PLATFORM);

  assert.throws(
    () => classifyNintendoExclusivity(seed({
      steamMatchEvidence: steamEvidence('official_cross_platform'),
    })),
    { code: 'invalid_steam_match_status' },
  );
  const officialCrossPlatform = seed({
    exclusivityEvidence: officialEvidence('official_cross_platform'),
  });
  assert.equal(
    classifyNintendoExclusivity(officialCrossPlatform).classification,
    NINTENDO_EXCLUSIVITY.KNOWN_CROSS_PLATFORM,
  );
});

test('sorting is official > unverified > known; EU hits_i and JP score never become popularity', () => {
  const official = buildNintendoSuggestion(seed({
    slug: 'z-official',
    popularityEvidence: [],
    exclusivityEvidence: officialEvidence('official_exclusive'),
  }), { europe: regional('europe', '70010000000012', { hits_i: 999999 }) });
  const unverified = buildNintendoSuggestion(seed({ slug: 'a-unverified', popularityEvidence: [] }), {
    japan: regional('japan', '70010000000013', { score: 999999 }),
  });
  const known = buildNintendoSuggestion(seed({
    slug: 'm-known',
    popularityEvidence: [],
    steamMatchEvidence: steamEvidence('exact_title', {
      steamAppId: 42,
      title: 'Example Game',
      publisher: 'Example Studio',
    }),
  }));
  assert.equal(official.popularityUnverified, true);
  assert.equal(unverified.popularityUnverified, true);
  assert.deepEqual(
    sortNintendoSuggestions([known, unverified, official]).map((candidate) => candidate.slug),
    ['z-official', 'a-unverified', 'm-known'],
  );
});

test('only dated official rank or digest-bound A1 Steam heat can drive popularity', () => {
  const steamHeat = sealDatedEvidence({
    kind: 'steam_heat',
    sourceUrl: 'https://store.steampowered.com/app/42/',
    observedAt: '2026-07-17T00:00:00.000Z',
    sourceDigest: sha256Digest({ a1: 'candidate-ranking' }),
    score: 1234,
  });
  const popularity = derivePopularity(seed({ popularityEvidence: [steamHeat] }));
  assert.equal(popularity.popularityUnverified, false);
  assert.equal(popularity.score, 1234);
  assert.equal(derivePopularity(seed({ popularityEvidence: [] })).popularityUnverified, true);

  const tampered = { ...steamHeat, score: 9999 };
  assert.throws(() => derivePopularity(seed({ popularityEvidence: [tampered] })), { code: 'evidence_digest_mismatch' });
});

test('candidate and suggestion digests detect evidence drift', () => {
  const first = buildNintendoSuggestion(seed(), { europe: regional('europe', '70010000000012') });
  const changed = buildNintendoSuggestion(seed(), { europe: regional('europe', '70010000000014') });
  assert.notEqual(first.evidenceDigest, changed.evidenceDigest);
  const document = createNintendoSuggestionDocument({
    generatedAt: '2026-07-17T00:00:00.000Z',
    inputDigest: sha256Digest({ input: 1 }),
    candidates: [first],
  });
  assert.equal(validateNintendoSuggestionDocument(document), document);
  const drifted = structuredClone(document);
  drifted.candidates[0].title = 'Drift';
  assert.throws(() => assertDocumentDigest(drifted), /documentDigest mismatch/u);

  const semanticallyTampered = structuredClone(document);
  semanticallyTampered.candidates[0].nsuids.europe = '70010000000015';
  semanticallyTampered.candidates[0].nsuidEu = '70010000000015';
  const { evidenceDigest: _candidateDigest, ...candidatePayload } = semanticallyTampered.candidates[0];
  semanticallyTampered.candidates[0].evidenceDigest = sha256Digest(candidatePayload);
  const { documentDigest: _documentDigest, ...documentPayload } = semanticallyTampered;
  semanticallyTampered.documentDigest = sha256Digest(documentPayload);
  assert.throws(
    () => validateNintendoSuggestionDocument(semanticallyTampered),
    { code: 'suggestion_nsuid_evidence_mismatch' },
  );
});

test('candidate discovery source contains no raw fetch or automatic Nintendo US page path', () => {
  const source = readFileSync(new URL('../discover-nsuid.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /discoverAmericas|extractUsProductNsuid/u);
  assert.match(source, /manualUsEvidence/u);
});
