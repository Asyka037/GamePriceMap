import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { sealNintendoSeedDraft } from '../seal-ns-candidate-seeds.mjs';
import { validateNintendoSeedDocument } from '../lib/ns-candidates.mjs';
import {
  cacheEntryForTarget,
  createEmptyNintendoEnrichmentCache,
  createNintendoEnrichmentDraft,
  createNintendoEnrichmentDraftCandidate,
  evaluateNintendoEuropeEnrichment,
  guardNintendoEnrichmentBatchCollisions,
  nintendoEuropeEnrichmentUrl,
  projectNintendoEuropeSolrResponse,
  selectNintendoEnrichmentTargets,
  withNintendoEnrichmentCacheEntry,
} from '../lib/nintendo-enrichment-seeds.mjs';
import {
  parseNintendoEnrichmentArgs,
  runNintendoEnrichmentSeeds,
} from '../build-nintendo-enrichment-seeds.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/nintendo-enrichment-eu-solr.json', import.meta.url),
  'utf8',
));
const NOW = new Date('2026-07-18T00:00:00.000Z');

function game(index, overrides = {}) {
  return {
    slug: `game-${String(index).padStart(2, '0')}`,
    title: `Game ${index}`,
    steamAppId: 1000 + index,
    platforms: ['pc'],
    nsuids: null,
    ...overrides,
  };
}

function exactBody(title, nsuid = '70010000012345', generation = 'HAC') {
  return {
    response: {
      docs: [{
        title,
        nsuid_txt: [nsuid],
        type: 'GAME',
        playable_on_txt: [generation],
        system_names_txt: [generation === 'BEE' ? 'Nintendo Switch 2' : 'Nintendo Switch'],
        digital_version_b: true,
        eshop_removed_b: false,
        date_from: '2025-01-01T00:00:00Z',
        price_regular_f: 49.99,
        publisher: 'Publisher',
      }],
    },
  };
}

test('target selection only includes Steam games without Switch identity and uses a stable cursor', () => {
  const games = Array.from({ length: 30 }, (_, index) => game(index + 1));
  games.push(game(31, { platforms: ['pc', 'switch'] }));
  games.push(game(32, { nsuids: { europe: '70010000099999' } }));
  games.push(game(33, { steamAppId: null }));
  const first = selectNintendoEnrichmentTargets({ games }, { batchSize: 25 });
  assert.equal(first.targets.length, 25);
  assert.equal(first.nextCursor, 'game-25');
  assert.equal(first.complete, false);
  const second = selectNintendoEnrichmentTargets({ games }, {
    batchSize: 25,
    startAfter: first.nextCursor,
  });
  assert.deepEqual(second.targets.map((target) => target.slug), [
    'game-26', 'game-27', 'game-28', 'game-29', 'game-30',
  ]);
  assert.equal(second.complete, true);
  assert.throws(() => selectNintendoEnrichmentTargets({ games }, { batchSize: 24 }), /25\.\.50/u);
});

test('Solr projection drops hits and scores, then selects one paid released 7001 exact match', () => {
  const payload = projectNintendoEuropeSolrResponse(fixture);
  assert.equal(payload.docs[0].hits_i, undefined);
  assert.equal(payload.docs[0].score, undefined);
  const evaluated = evaluateNintendoEuropeEnrichment(payload, {
    slug: 'example-game',
    title: 'Example Game',
  }, { now: NOW });
  assert.equal(evaluated.status, 'matched');
  assert.equal(evaluated.candidate.nsuid, '70010000012345');
  assert.equal(evaluated.candidate.generation, 'HAC');
  assert.equal(evaluated.candidate.paidPrice.amount, 19.99);
});

test('EU enrichment fails closed on future, zero-price, DLC-shaped, and generation-conflict rows', () => {
  const payload = projectNintendoEuropeSolrResponse(fixture);
  const reasons = new Map([
    ['Future Game', 'no_exact_paid_released_base_generation_match'],
    ['Zero Price Game', 'no_exact_paid_released_base_generation_match'],
    ['DLC-shaped Game', 'no_exact_paid_released_base_generation_match'],
    ['Conflict Game', 'no_exact_paid_released_base_generation_match'],
  ]);
  for (const [title, reason] of reasons) {
    assert.equal(evaluateNintendoEuropeEnrichment(payload, {
      slug: 'target',
      title,
    }, { now: NOW }).reason, reason);
  }
  assert.equal(
    evaluateNintendoEuropeEnrichment(payload, { slug: 'missing', title: 'Missing' }, { now: NOW }).reason,
    'no_exact_title_match',
  );
});

test('positive official price can retain a first-party row despite digital_version_b=false', () => {
  const evaluated = evaluateNintendoEuropeEnrichment(
    projectNintendoEuropeSolrResponse(fixture),
    { slug: 'switch-2-game', title: 'Switch 2 Game' },
    { now: NOW },
  );
  assert.equal(evaluated.status, 'matched');
  assert.equal(evaluated.candidate.generation, 'BEE');
});

test('ambiguous exact identities, catalog ownership, and batch collisions are rejected', () => {
  const target = { slug: 'example-game', title: 'Example Game' };
  const ambiguous = projectNintendoEuropeSolrResponse({
    response: {
      docs: [
        exactBody('Example Game', '70010000011111').response.docs[0],
        exactBody('Example Game', '70010000022222').response.docs[0],
      ],
    },
  });
  assert.equal(evaluateNintendoEuropeEnrichment(ambiguous, target, { now: NOW }).reason, 'ambiguous_exact_matches');

  const one = projectNintendoEuropeSolrResponse(exactBody('Example Game'));
  assert.equal(evaluateNintendoEuropeEnrichment(one, target, {
    now: NOW,
    existingNsuids: new Map([['70010000012345', 'other-game']]),
  }).reason, 'catalog_nsuid_owned_by_other_slug');

  const matched = evaluateNintendoEuropeEnrichment(one, target, { now: NOW });
  const guarded = guardNintendoEnrichmentBatchCollisions([
    { target, evaluation: matched },
    { target: { slug: 'other-game', title: 'Example Game' }, evaluation: matched },
  ]);
  assert.deepEqual(guarded.map((result) => result.evaluation.reason), [
    'batch_nsuid_collision', 'batch_nsuid_collision',
  ]);
});

test('generated enrichment draft is consumable by the existing seal and discovery seed schema', () => {
  const target = { slug: 'example-game', title: 'Example Game', steamAppId: 123 };
  const sourceUrl = nintendoEuropeEnrichmentUrl(target.title);
  const payload = projectNintendoEuropeSolrResponse(exactBody(target.title));
  const cache = withNintendoEnrichmentCacheEntry(createEmptyNintendoEnrichmentCache(), target, {
    sourceUrl,
    collectedAt: NOW,
    payload,
  });
  const match = evaluateNintendoEuropeEnrichment(payload, target, { now: NOW }).candidate;
  const candidate = createNintendoEnrichmentDraftCandidate(target, match, {
    sourceUrl,
    sourceDigest: cache.entries[target.slug].sourceDigest,
    observedAt: NOW,
  });
  assert.equal(candidate.catalogAction, 'add_platform_mapping');
  assert.deepEqual(candidate.popularityEvidence, []);
  assert.equal(candidate.steamMatchEvidence, null);
  const sealed = sealNintendoSeedDraft(createNintendoEnrichmentDraft({
    generatedAt: NOW,
    candidates: [candidate],
  }));
  assert.doesNotThrow(() => validateNintendoSeedDocument(sealed));
  assert.equal(sealed.candidates[0].candidateId, 'ns:70010000012345');
});

test('cache is digest-bound, title/URL-bound, and expires after seven days', () => {
  const target = { slug: 'example-game', title: 'Example Game' };
  const cache = withNintendoEnrichmentCacheEntry(createEmptyNintendoEnrichmentCache(), target, {
    sourceUrl: nintendoEuropeEnrichmentUrl(target.title),
    collectedAt: NOW,
    payload: projectNintendoEuropeSolrResponse(exactBody(target.title)),
  });
  assert.ok(cacheEntryForTarget(cache, target, { now: new Date('2026-07-24T00:00:00Z') }));
  assert.equal(cacheEntryForTarget(cache, target, { now: new Date('2026-07-26T00:00:00Z') }), null);
  assert.equal(cacheEntryForTarget(cache, { ...target, title: 'Renamed' }, { now: NOW }), null);
  const tampered = structuredClone(cache);
  tampered.entries[target.slug].payload.docs[0].title = 'Tampered';
  assert.throws(() => cacheEntryForTarget(tampered, target, { now: NOW }), /digest mismatch/u);
});

test('CLI defaults to dry-run with no writes; --apply atomically writes draft/report/cache, never catalog', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-ns-enrichment-'));
  const catalogPath = path.join(directory, 'catalog.json');
  const outputPath = path.join(directory, 'draft.json');
  const reportPath = path.join(directory, 'report.json');
  const cachePath = path.join(directory, 'cache.json');
  const catalog = { games: Array.from({ length: 25 }, (_, index) => game(index + 1)) };
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`);
  const before = fs.readFileSync(catalogPath);
  let calls = 0;
  const fetchJsonImpl = async (_url, options) => {
    calls += 1;
    const slug = options.label.split(' ').at(-1);
    const target = catalog.games.find((entry) => entry.slug === slug);
    return exactBody(target.title, `70010000${String(100000 + calls).padStart(6, '0')}`);
  };
  const common = [
    '--catalog', catalogPath,
    '--output', outputPath,
    '--report', reportPath,
    '--cache', cachePath,
  ];
  const dry = await runNintendoEnrichmentSeeds({
    args: common,
    now: NOW,
    fetchJsonImpl,
    sleepImpl: async () => {},
    setRequestBudgetImpl: () => {},
  });
  assert.equal(dry.draft.candidates.length, 25);
  assert.deepEqual(dry.writtenPaths, []);
  assert.equal(fs.existsSync(outputPath), false);
  assert.equal(fs.existsSync(reportPath), false);
  assert.equal(fs.existsSync(cachePath), false);
  assert.ok(fs.readFileSync(catalogPath).equals(before));

  calls = 0;
  const applied = await runNintendoEnrichmentSeeds({
    args: [...common, '--apply'],
    now: NOW,
    fetchJsonImpl,
    sleepImpl: async () => {},
    setRequestBudgetImpl: () => {},
  });
  assert.equal(applied.writtenPaths.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(outputPath)).kind, 'nintendo-candidate-seed-draft');
  assert.equal(JSON.parse(fs.readFileSync(reportPath)).kind, 'nintendo-enrichment-seed-report');
  assert.equal(JSON.parse(fs.readFileSync(cachePath)).kind, 'nintendo-europe-enrichment-cache');
  assert.ok(fs.readFileSync(catalogPath).equals(before));
});

test('CLI argument parser is strict and keeps the 25-item default', () => {
  assert.equal(parseNintendoEnrichmentArgs([]).batchSize, 25);
  assert.equal(parseNintendoEnrichmentArgs(['--batch-size=50', '--start-after', 'abc']).batchSize, 50);
  assert.throws(() => parseNintendoEnrichmentArgs(['--apply=true']), /without a value/u);
  assert.throws(() => parseNintendoEnrichmentArgs(['--unknown']), /unknown argument/u);
});
