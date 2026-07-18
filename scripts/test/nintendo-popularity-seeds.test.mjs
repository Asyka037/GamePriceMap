import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildNintendoPopularitySeedBatch,
  parseNintendoIrTopSellersHtml,
  sourceBytesDigest,
} from '../lib/nintendo-popularity-seeds.mjs';
import { sealEvidenceDocument, sha256Digest } from '../lib/candidate-evidence.mjs';
import { sealNintendoSeedDraft } from '../seal-ns-candidate-seeds.mjs';
import { validateNintendoSeedDocument } from '../lib/ns-candidates.mjs';
import {
  parseNintendoPopularitySeedArgs,
  runNintendoPopularitySeeds,
} from '../build-nintendo-popularity-seeds.mjs';

const IR_URL = 'https://www.nintendo.co.jp/ir/en/finance/software/switch.html';
const irHtml = fs.readFileSync(new URL('./fixtures/nintendo-ir-top-sellers.html', import.meta.url));

function fileReader(files) {
  return (file) => {
    if (!files.has(file)) {
      const error = new Error(`missing fixture ${file}`);
      error.code = 'ENOENT';
      throw error;
    }
    return files.get(file);
  };
}

function irManifest() {
  return {
    schemaVersion: 1,
    kind: 'nintendo-popularity-source-manifest',
    sources: [{
      kind: 'nintendo_ir_top_sellers_html',
      file: 'ir.html',
      sourceUrl: IR_URL,
      observedAt: '2026-07-18T00:00:00.000Z',
      sourceDigest: sourceBytesDigest(irHtml),
    }],
  };
}

function steamCandidatePayload(candidate) {
  return {
    candidateId: candidate.candidateId,
    steamAppId: candidate.steamAppId,
    slugHint: candidate.slugHint,
    title: candidate.title,
    sourceRank: candidate.sourceRank,
    provisional: candidate.provisional,
    popularityScore: candidate.popularityScore,
    recommendationCount: candidate.recommendationCount,
    signals: candidate.signals,
    paidGate: candidate.paidGate,
    evidence: candidate.evidence,
  };
}

function finalSteamDocument() {
  const candidate = {
    candidateId: 'steam:123',
    catalogAction: 'new_game',
    steamAppId: 123,
    slugHint: 'cross-platform-example',
    title: 'Cross Platform Example',
    platforms: ['pc'],
    sourceUrl: 'https://store.steampowered.com/app/123/',
    humanDecision: '待定',
    provisional: false,
    popularityScore: 123456,
    recommendationCount: 100000,
    signals: {
      topSellersAppearanceCount: 14,
      topSellersRankPoints: 1400,
      bestFeaturedTopSellerRank: null,
      bestMostPlayedRank: null,
      recommendationProxyPoints: 5000,
      auxiliaryPoints: 0,
    },
    paidGate: {
      productType: 'game',
      isFree: false,
      releaseDate: 'Jan 1, 2025',
      usListPrice: 29.99,
      usCurrentPrice: 29.99,
      usDiscountPercent: 0,
      currency: 'USD',
      titleEvidence: 'ranking_exact_match',
    },
    evidence: {
      schemaVersion: 1,
      expectedTitles: ['Cross Platform Example'],
      topSellerRanks: [],
      featuredTopSellerObservations: [],
      mostPlayedObservations: [],
      rankingSampleDigests: [],
      appDetailsEvidenceDigest: `sha256:${'a'.repeat(64)}`,
    },
    sourceRank: 1,
  };
  candidate.evidenceDigest = sha256Digest(steamCandidatePayload(candidate));
  const distinctUtcDates = Array.from({ length: 14 }, (_value, index) => `2026-07-${String(index + 1).padStart(2, '0')}`);
  return sealEvidenceDocument({
    schemaVersion: 1,
    kind: 'steam-candidates',
    generatedAt: '2026-07-18T00:00:00.000Z',
    mode: 'final',
    provisional: false,
    minimumDistinctDatesForFinal: 14,
    distinctUtcDates,
    rankingSampleDigests: distinctUtcDates.map((_date, index) => `sha256:${index.toString(16).padStart(64, '0')}`),
    scorePolicy: {},
    pool: {},
    sourceRejections: [],
    candidates: [candidate],
    rejectedCandidates: [],
    pendingCandidates: [],
  });
}

test('Nintendo IR HTML parser binds canonical URL, exact generation, rows, and combined-title marker', () => {
  const parsed = parseNintendoIrTopSellersHtml(irHtml, { sourceUrl: IR_URL });
  assert.equal(parsed.platform, 'switch');
  assert.deepEqual(parsed.rows.map(({ title, rank, unitsMillions, combinedTitles }) => ({
    title,
    rank,
    unitsMillions,
    combinedTitles,
  })), [
    { title: 'Example Adventure', rank: 1, unitsMillions: 12.34, combinedTitles: false },
    { title: 'Existing Example', rank: 2, unitsMillions: 5.67, combinedTitles: false },
    { title: 'Version Red/ Version Blue', rank: 3, unitsMillions: 4.56, combinedTitles: true },
    { title: 'Base Game – Nintendo Switch 2 Edition', rank: 4, unitsMillions: 3.21, combinedTitles: false },
  ]);
  assert.throws(
    () => parseNintendoIrTopSellersHtml(irHtml, { sourceUrl: 'https://www.nintendo.co.jp/ir/en/finance/software/index.html' }),
    /canonical URL/u,
  );
});

test('IR evidence produces one schema-valid batch, enriches an exact catalog title, and rejects combined rows', () => {
  const result = buildNintendoPopularitySeedBatch({
    manifest: irManifest(),
    catalog: {
      games: [{
        slug: 'existing-example',
        title: 'Existing Example',
        steamAppId: 456,
        nsuids: null,
        platforms: ['pc'],
      }],
    },
    readSource: fileReader(new Map([['ir.html', irHtml]])),
    generatedAt: '2026-07-18T01:00:00.000Z',
  });
  assert.equal(result.draft.candidates.length, 2);
  assert.equal(result.draft.candidates[0].slug, 'example-adventure');
  assert.equal(result.draft.candidates[0].catalogAction, 'new_game');
  assert.equal(result.draft.candidates[1].slug, 'existing-example');
  assert.equal(result.draft.candidates[1].catalogAction, 'add_platform_mapping');
  assert.deepEqual(result.report.rejected.map((entry) => entry.reason), [
    'combined_title_row_requires_explicit_product_evidence',
    'edition_variant_requires_equivalence_evidence',
  ]);
  assert.equal(result.draft.candidates[0].popularityEvidence[0].sourceDigest, sourceBytesDigest(irHtml));
  validateNintendoSeedDocument(sealNintendoSeedDraft(result.draft));
});

test('IR raw bytes are mandatory and digest mismatch fails closed', () => {
  const manifest = irManifest();
  manifest.sources[0].sourceDigest = `sha256:${'0'.repeat(64)}`;
  assert.throws(() => buildNintendoPopularitySeedBatch({
    manifest,
    catalog: { games: [] },
    readSource: fileReader(new Map([['ir.html', irHtml]])),
  }), /source digest mismatch/u);
  assert.throws(() => buildNintendoPopularitySeedBatch({
    manifest: irManifest(),
    catalog: { games: [] },
    readSource: fileReader(new Map()),
  }), /missing fixture/u);
});

test('reviewed IR table requires explicit one-generation platform and a row locator', () => {
  const bytes = Buffer.from('retained official quarterly PDF bytes');
  const manifest = {
    schemaVersion: 1,
    kind: 'nintendo-popularity-source-manifest',
    sources: [{
      kind: 'nintendo_ir_reviewed_table',
      file: 'quarter.pdf',
      sourceUrl: 'https://www.nintendo.co.jp/ir/pdf/2026/260731_2e.pdf',
      observedAt: '2026-07-31T00:00:00.000Z',
      sourceDigest: sourceBytesDigest(bytes),
      rows: [{
        title: 'Reviewed Table Game',
        slug: 'reviewed-table-game',
        platforms: ['switch-2'],
        rank: 7,
        unitsMillions: 1.25,
        sourceLocator: 'page 13, million-seller table, row 7',
      }],
    }],
  };
  const result = buildNintendoPopularitySeedBatch({
    manifest,
    catalog: { games: [] },
    readSource: fileReader(new Map([['quarter.pdf', bytes]])),
  });
  assert.equal(result.draft.candidates[0].platforms[0], 'switch-2');
  assert.equal(result.draft.candidates[0].popularityEvidence[0].extractionMode, 'reviewed_table');
  validateNintendoSeedDocument(sealNintendoSeedDraft(result.draft));
  manifest.sources[0].rows[0].platforms = ['switch', 'switch-2'];
  assert.throws(() => buildNintendoPopularitySeedBatch({
    manifest,
    catalog: { games: [] },
    readSource: fileReader(new Map([['quarter.pdf', bytes]])),
  }), /exactly one/u);
});

test('Steam heat accepts only final evidence plus separate digest-bound Nintendo platform identity', () => {
  const steam = finalSteamDocument();
  const steamBytes = Buffer.from(JSON.stringify(steam));
  const platformBytes = Buffer.from('{"official":"Nintendo identity"}');
  const source = {
    kind: 'steam_final_candidates',
    file: 'steam-final.json',
    documentDigest: steam.documentDigest,
    bindings: [{
      steamAppId: 123,
      title: 'Cross Platform Example',
      slug: 'cross-platform-example',
      platforms: ['switch'],
      platformEvidence: {
        file: 'nintendo-identity.json',
        sourceUrl: 'https://searching.nintendo-europe.com/en/select?q=Cross+Platform+Example',
        observedAt: '2026-07-18T00:00:00.000Z',
        sourceDigest: sourceBytesDigest(platformBytes),
        matchedTitle: 'Cross Platform Example',
        platforms: ['switch'],
        sourceLocator: 'response.docs[0].system_names_txt',
      },
    }],
  };
  const result = buildNintendoPopularitySeedBatch({
    manifest: {
      schemaVersion: 1,
      kind: 'nintendo-popularity-source-manifest',
      sources: [source],
    },
    catalog: { games: [] },
    readSource: fileReader(new Map([
      ['steam-final.json', steamBytes],
      ['nintendo-identity.json', platformBytes],
    ])),
  });
  assert.equal(result.draft.candidates.length, 1);
  assert.equal(result.draft.candidates[0].popularityEvidence[0].kind, 'steam_heat');
  assert.equal(result.draft.candidates[0].popularityEvidence[0].sourceDigest, steam.documentDigest);
  assert.deepEqual(result.draft.candidates[0].popularityEvidence[0].distinctUtcDates, steam.distinctUtcDates);
  assert.equal(result.draft.candidates[0].seedEvidence[0].kind, 'nintendo_official_platform_binding');
  validateNintendoSeedDocument(sealNintendoSeedDraft(result.draft));

  const pilot = sealEvidenceDocument({ ...steam, mode: 'pilot', provisional: true });
  source.documentDigest = pilot.documentDigest;
  assert.throws(() => buildNintendoPopularitySeedBatch({
    manifest: { schemaVersion: 1, kind: 'nintendo-popularity-source-manifest', sources: [source] },
    catalog: { games: [] },
    readSource: fileReader(new Map([
      ['steam-final.json', Buffer.from(JSON.stringify(pilot))],
      ['nintendo-identity.json', platformBytes],
    ])),
  }), /provisional flag mismatch|non-provisional final/u);
});

test('conflicting identities for one normalized title reject the entire source group, never first-wins', () => {
  const bytesA = Buffer.from('official IR table A');
  const bytesB = Buffer.from('official IR table B');
  const source = (file, bytes, slug, platform, rank) => ({
    kind: 'nintendo_ir_reviewed_table',
    file,
    sourceUrl: `https://www.nintendo.co.jp/ir/pdf/2026/${file}.pdf`,
    observedAt: '2026-07-31T00:00:00.000Z',
    sourceDigest: sourceBytesDigest(bytes),
    rows: [{
      title: 'Identity Conflict Game',
      slug,
      platforms: [platform],
      rank,
      unitsMillions: 1,
      sourceLocator: `page 1 row ${rank}`,
    }],
  });
  const result = buildNintendoPopularitySeedBatch({
    manifest: {
      schemaVersion: 1,
      kind: 'nintendo-popularity-source-manifest',
      sources: [
        source('a', bytesA, 'identity-conflict-game', 'switch', 1),
        source('b', bytesB, 'identity-conflict-game-switch-2', 'switch-2', 2),
      ],
    },
    catalog: { games: [] },
    readSource: fileReader(new Map([['a', bytesA], ['b', bytesB]])),
  });
  assert.equal(result.draft.candidates.length, 0);
  assert.equal(result.report.eligible, 0);
  assert.deepEqual(
    result.report.rejected.map((entry) => entry.reason),
    ['source_identity_conflict', 'source_identity_conflict'],
  );
  assert.equal(new Set(result.report.rejected.map((entry) => entry.sourceKey)).size, 2);
});

test('batch size is hard-capped at 25 and output mode is atomic/read-only by default', () => {
  assert.throws(() => buildNintendoPopularitySeedBatch({
    manifest: irManifest(),
    catalog: { games: [] },
    readSource: fileReader(new Map([['ir.html', irHtml]])),
    batchSize: 26,
  }), /1\.\.25/u);
  assert.throws(() => parseNintendoPopularitySeedArgs([]), /--manifest is required/u);
  assert.throws(
    () => parseNintendoPopularitySeedArgs(['--manifest', 'manifest.json', '--apply', '--output', 'draft.json']),
    /requires --output and --report/u,
  );

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-nintendo-popularity-'));
  fs.writeFileSync(path.join(directory, 'ir.html'), irHtml);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(irManifest()));
  fs.writeFileSync(path.join(directory, 'catalog.json'), JSON.stringify({ games: [] }));
  const output = path.join(directory, 'draft.json');
  const report = path.join(directory, 'report.json');
  runNintendoPopularitySeeds({
    args: [
      '--manifest', path.join(directory, 'manifest.json'),
      '--catalog', path.join(directory, 'catalog.json'),
      '--output', output,
      '--report', report,
    ],
    now: '2026-07-18T00:00:00.000Z',
  });
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(report), false);
  runNintendoPopularitySeeds({
    args: [
      '--manifest', path.join(directory, 'manifest.json'),
      '--catalog', path.join(directory, 'catalog.json'),
      '--output', output,
      '--report', report,
      '--apply',
    ],
    now: '2026-07-18T00:00:00.000Z',
  });
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).candidates.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).selected, 2);
});

test('a frozen evidence pool emits exactly 25 rows and reports the deterministic remainder', () => {
  const bytes = Buffer.from('official quarterly Nintendo IR evidence');
  const rows = Array.from({ length: 30 }, (_value, index) => ({
    title: `Quarterly Game ${String(index + 1).padStart(2, '0')}`,
    slug: `quarterly-game-${String(index + 1).padStart(2, '0')}`,
    platforms: ['switch'],
    rank: index + 1,
    unitsMillions: 30 - index,
    sourceLocator: `page 10 row ${index + 1}`,
  }));
  const result = buildNintendoPopularitySeedBatch({
    manifest: {
      schemaVersion: 1,
      kind: 'nintendo-popularity-source-manifest',
      sources: [{
        kind: 'nintendo_ir_reviewed_table',
        file: 'quarter.pdf',
        sourceUrl: 'https://www.nintendo.co.jp/ir/pdf/2026/quarter.pdf',
        observedAt: '2026-07-31T00:00:00.000Z',
        sourceDigest: sourceBytesDigest(bytes),
        rows,
      }],
    },
    catalog: { games: [] },
    readSource: fileReader(new Map([['quarter.pdf', bytes]])),
  });
  assert.equal(result.draft.candidates.length, 25);
  assert.equal(result.report.selected, 25);
  assert.equal(result.report.remaining, 5);
  assert.equal(result.draft.candidates[0].slug, 'quarterly-game-01');
  assert.equal(result.draft.candidates.at(-1).slug, 'quarterly-game-25');
  validateNintendoSeedDocument(sealNintendoSeedDraft(result.draft));
});
