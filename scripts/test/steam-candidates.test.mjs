import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDailySteamRankingEvidence,
  createRawEvidence,
  evidenceJson,
  parseMostPlayedGames,
  parseFeaturedTopSellers,
  parseSteamSearchResults,
  sealEvidenceDocument,
  sha256Digest,
  utcDate,
  validateDailySteamRankingEvidence,
} from '../lib/candidate-evidence.mjs';
import {
  buildSteamCandidateDocument,
  compareSteamCandidates,
  createSteamAppDetailsEvidence,
  gateSteamAppDetails,
  steamCandidateSlugHint,
  validateSteamAppDetailsEvidence,
  validateSteamCandidateDocument,
} from '../lib/steam-candidates.mjs';
import {
  buildTopSellersSearchUrl,
  collectSteamRanking,
  parseCollectorArgs,
} from '../collect-steam-ranking.mjs';
import { buildSteamCandidates, parseBuilderArgs } from '../build-steam-candidates.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
const SEARCH = fixture('steam-search-topsellers-candidates.json');
const FEATURED = fixture('steam-featuredcategories-candidates.json');
const MOST_PLAYED = fixture('steam-most-played-candidates.json');
const APPDETAILS = fixture('steam-appdetails-candidate-gates.json');
const FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories?cc=us&l=english';
const MOST_PLAYED_URL = 'https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/';

function atUtc(date) {
  return `${date}T12:00:00.000Z`;
}

function dailySample(date, { mostPlayed = MOST_PLAYED } = {}) {
  return buildDailySteamRankingEvidence({
    date,
    collectedAt: atUtc(date),
    searchPages: [{
      start: 0,
      count: 100,
      sourceUrl: buildTopSellersSearchUrl({ start: 0, count: 100 }),
      payload: SEARCH,
    }],
    featured: { sourceUrl: FEATURED_URL, payload: FEATURED },
    mostPlayed: { sourceUrl: MOST_PLAYED_URL, payload: mostPlayed },
    freshnessNow: atUtc(date),
  });
}

function dates(count) {
  return Array.from({ length: count }, (_value, index) => `2026-07-${String(index + 1).padStart(2, '0')}`);
}

function appDetailsEvidence(ids = Object.keys(APPDETAILS).map(Number)) {
  return new Map(ids.map((appId) => {
    const payload = { [appId]: APPDETAILS[String(appId)] };
    const sourceUrl = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=us&l=english`;
    return [appId, createSteamAppDetailsEvidence({
      appId,
      payload,
      sourceUrl,
      fetchedAt: '2026-07-17T00:00:00.000Z',
    })];
  }));
}

test('canonical digest is key-order independent and sealed evidence detects tampering', () => {
  assert.equal(sha256Digest({ b: 2, a: 1 }), sha256Digest({ a: 1, b: 2 }));
  const sealed = sealEvidenceDocument({ schemaVersion: 1, kind: 'fixture', value: 1 });
  assert.match(sealed.documentDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.throws(
    () => validateDailySteamRankingEvidence({ ...dailySample('2026-07-01'), date: '2026-07-02' }),
    /documentDigest/u,
  );
});

test('Steam search JSON safely parses ranked app IDs/titles and fails closed on structure drift', () => {
  const parsed = parseSteamSearchResults(SEARCH, { start: 0 });
  assert.equal(parsed.items.length, 8);
  assert.deepEqual(parsed.items[0], { appId: 1001, rank: 1, title: 'Paid & Hit' });
  assert.throws(
    () => parseSteamSearchResults({ success: 1, total_count: 5, start: 0 }, { start: 0 }),
    /results_html/u,
  );
  assert.throws(
    () => parseSteamSearchResults({ success: 1, total_count: 5, start: 0, results_html: '<div>changed</div>' }, { start: 0 }),
    /structure drift/u,
  );
});

test('featuredcategories keeps the first/best duplicate rank and rejects conflicting duplicate titles', () => {
  const parsed = parseFeaturedTopSellers(FEATURED);
  assert.deepEqual(parsed.items.map((item) => [item.appId, item.rank]), [[1001, 1], [1006, 2]]);
  assert.deepEqual(parsed.rejectedItems, [{
    rank: 3,
    appId: 1001,
    reason: 'duplicate_featured_appid',
    keptRank: 1,
  }]);
  const conflict = structuredClone(FEATURED);
  conflict.top_sellers.items[2].name = 'Different Game';
  assert.throws(() => parseFeaturedTopSellers(conflict), /title conflict/u);
});

test('final mode requires 14 distinct UTC dates; a duplicate day never counts twice', () => {
  const thirteen = dates(13).map((date) => dailySample(date));
  assert.throws(() => buildSteamCandidateDocument({
    samples: [...thirteen, thirteen[0]],
    appDetailsById: appDetailsEvidence(),
    catalog: { games: [] },
    mode: 'final',
    generatedAt: '2026-07-17T00:00:00.000Z',
  }), /14 distinct UTC dates; found 13/u);

  const fourteen = dates(14).map((date) => dailySample(date));
  const document = buildSteamCandidateDocument({
    samples: fourteen,
    appDetailsById: appDetailsEvidence(),
    catalog: { games: [{ steamAppId: 1999 }] },
    mode: 'final',
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  validateSteamCandidateDocument(document);
  assert.equal(document.provisional, false);
  assert.equal(document.distinctUtcDates.length, 14);
  assert.equal(document.candidates.some((candidate) => candidate.steamAppId === 1999), false);
  assert.ok(document.rejectedCandidates.some((item) => item.steamAppId === 1999 && item.reason === 'already_in_catalog'));
  assert.equal(document.candidates.some((candidate) => Object.hasOwn(candidate, 'reviewCount')), false);
});

test('pilot output is explicitly provisional and may use fewer than 14 samples', () => {
  const document = buildSteamCandidateDocument({
    samples: [dailySample('2026-07-01')],
    appDetailsById: appDetailsEvidence(),
    catalog: { games: [] },
    mode: 'pilot',
    generatedAt: '2026-07-02T00:00:00.000Z',
  });
  assert.equal(document.provisional, true);
  assert.ok(document.candidates.every((candidate) => candidate.provisional));
  const paid = document.candidates.find((candidate) => candidate.steamAppId === 1001);
  assert.equal(paid.slugHint, 'paid-and-hit');
  assert.equal(steamCandidateSlugHint('Paid & Hit', 1001), paid.slugHint);
  assert.equal(steamCandidateSlugHint('游戏', 1001), 'steam-1001');
});

test('paid gate accepts temporary 100% discount, rejects free/DLC/unreleased/missing-price products', () => {
  const accepted = gateSteamAppDetails(1001, { 1001: APPDETAILS['1001'] }, {
    expectedTitles: ['Paid & Hit'],
    now: '2026-07-17T00:00:00.000Z',
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.usListPrice, 29.99);
  assert.equal(accepted.usCurrentPrice, 0);
  assert.equal(accepted.usDiscountPercent, 100);
  assert.equal(accepted.recommendationCount, 50000);

  const reasons = new Map([1002, 1003, 1004, 1005].map((appId) => {
    const result = gateSteamAppDetails(appId, { [appId]: APPDETAILS[String(appId)] }, {
      expectedTitles: [APPDETAILS[String(appId)].data.name],
      now: '2026-07-17T00:00:00.000Z',
    });
    return [appId, result.reason];
  }));
  assert.equal(reasons.get(1002), 'free_game');
  assert.equal(reasons.get(1003), 'excluded_title_noise');
  assert.equal(reasons.get(1004), 'unreleased');
  assert.equal(reasons.get(1005), 'missing_us_price');
});

test('appdetails evidence drops descriptions and media while retaining every gate input', () => {
  const raw = structuredClone(APPDETAILS['1001']);
  raw.data.about_the_game = 'large irrelevant description';
  raw.data.screenshots = [{ path_full: 'https://cdn.example/large.jpg' }];
  const evidence = createSteamAppDetailsEvidence({
    appId: 1001,
    payload: { 1001: raw },
    sourceUrl: 'https://store.steampowered.com/api/appdetails?appids=1001&cc=us&l=english',
    fetchedAt: '2026-07-17T00:00:00.000Z',
  });
  validateSteamAppDetailsEvidence(evidence, { appId: 1001 });
  assert.equal(evidence.payload['1001'].data.about_the_game, undefined);
  assert.equal(evidence.payload['1001'].data.screenshots, undefined);
  assert.equal(evidence.payload['1001'].data.price_overview.initial, 2999);
  assert.equal(evidence.payload['1001'].data.recommendations.total, 50000);
});

test('identity/title anomalies fail closed', () => {
  const wrongTitle = gateSteamAppDetails(1001, { 1001: APPDETAILS['1001'] }, {
    expectedTitles: ['Different Game'],
    now: '2026-07-17T00:00:00.000Z',
  });
  assert.equal(wrongTitle.reason, 'title_mismatch');
  const wrongKey = gateSteamAppDetails(1001, { 9999: APPDETAILS['1001'] });
  assert.equal(wrongKey.reason, 'appid_response_mismatch');
  assert.throws(() => gateSteamAppDetails(1001, { 1001: { data: {} } }), /success marker/u);
});

test('stale GetMostPlayedGames is recorded as rejected and cannot alter the main ranking', () => {
  const stalePayload = structuredClone(MOST_PLAYED);
  stalePayload.response.rollup_date = 1778457600; // 2026-05-11 UTC
  const parsed = parseMostPlayedGames(stalePayload, { now: '2026-07-17T00:00:00.000Z' });
  assert.equal(parsed.accepted, false);
  assert.equal(parsed.rejectedReason, 'stale_rollup_date');

  const sample = dailySample('2026-07-17', { mostPlayed: stalePayload });
  const document = buildSteamCandidateDocument({
    samples: [sample],
    appDetailsById: appDetailsEvidence(),
    catalog: { games: [] },
    mode: 'pilot',
    generatedAt: '2026-07-17T13:00:00.000Z',
  });
  assert.deepEqual(document.sourceRejections.map((item) => item.reason), ['stale_rollup_date']);
  const candidate = document.candidates.find((item) => item.steamAppId === 1006);
  assert.equal(candidate.signals.bestMostPlayedRank, null);
  assert.ok(candidate.signals.topSellersAppearanceCount > 0);
});

test('deterministic tie-break falls back to ascending AppID', () => {
  const base = {
    popularityScore: 123,
    recommendationCount: 10,
    signals: { topSellersAppearanceCount: 2, topSellersRankPoints: 20 },
  };
  const sorted = [
    { ...base, steamAppId: 1007 },
    { ...base, steamAppId: 1006 },
  ].sort(compareSteamCandidates);
  assert.deepEqual(sorted.map((item) => item.steamAppId), [1006, 1007]);
});

test('same UTC-day collector rerun validates and preserves the existing sample byte-for-byte', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ranking-idempotent-'));
  const outputPath = path.join(directory, '2026-07-01.json');
  const sample = dailySample('2026-07-01');
  fs.writeFileSync(outputPath, evidenceJson(sample));
  const before = fs.readFileSync(outputPath);
  const beforeStat = fs.statSync(outputPath);
  const result = await collectSteamRanking({
    date: '2026-07-01',
    pages: 1,
    pageSize: 100,
    waitMs: 0,
    outputPath,
    cacheDir: path.join(directory, 'cache'),
  });
  const after = fs.readFileSync(outputPath);
  const afterStat = fs.statSync(outputPath);
  assert.equal(result.noOp, true);
  assert.deepEqual(after, before);
  assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs);
});

test('same-day rerun rejects a different page-coverage policy instead of locking a short sample', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ranking-policy-'));
  const outputPath = path.join(directory, '2026-07-01.json');
  fs.writeFileSync(outputPath, evidenceJson(dailySample('2026-07-01')));
  const before = fs.readFileSync(outputPath);
  await assert.rejects(() => collectSteamRanking({
    date: '2026-07-01',
    pages: 2,
    pageSize: 100,
    waitMs: 0,
    outputPath,
    cacheDir: path.join(directory, 'cache'),
  }), /collection policy mismatch/u);
  assert.deepEqual(fs.readFileSync(outputPath), before);
});

test('raw caches default to ignored private storage and cannot cross UTC-day boundaries', async () => {
  const collectorDefaults = parseCollectorArgs([], { now: '2026-07-17T00:00:00.000Z' });
  const builderDefaults = parseBuilderArgs([]);
  assert.match(collectorDefaults.cacheDir, /private\/game-library\/candidate-cache\/steam\/raw\/2026-07-17$/u);
  assert.match(builderDefaults.cacheDir, /private\/game-library\/candidate-cache\/steam\/appdetails$/u);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-ranking-cross-day-'));
  const today = utcDate(new Date());
  const yesterday = new Date(`${today}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const cacheDir = path.join(directory, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sourceUrl = buildTopSellersSearchUrl({ start: 0, count: 100 });
  const staleRaw = createRawEvidence({
    sourceUrl,
    sourceKind: 'steam-search-topsellers',
    collectedAt: `${utcDate(yesterday)}T12:00:00.000Z`,
    payload: SEARCH,
  });
  fs.writeFileSync(path.join(cacheDir, 'search-000000.json'), evidenceJson(staleRaw));
  await assert.rejects(() => collectSteamRanking({
    date: today,
    pages: 1,
    pageSize: 100,
    waitMs: 0,
    outputPath: path.join(directory, `${today}.json`),
    cacheDir,
  }), /raw cache UTC date mismatch/u);
});

test('offline builder consumes resume cache, writes only explicit candidate output, and leaves catalog unchanged', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-candidate-builder-'));
  const evidenceDir = path.join(directory, 'ranking');
  const cacheDir = path.join(directory, 'appdetails');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, '2026-07-01.json'), evidenceJson(dailySample('2026-07-01')));
  for (const [appId, evidence] of appDetailsEvidence()) {
    fs.writeFileSync(path.join(cacheDir, `${appId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const catalogPath = path.join(directory, 'catalog.json');
  const catalogBytes = `${JSON.stringify({ games: [{ steamAppId: 1999 }] }, null, 2)}\n`;
  fs.writeFileSync(catalogPath, catalogBytes);
  const outputPath = path.join(directory, 'steam-candidates.json');
  const result = await buildSteamCandidates({
    evidenceDir,
    cacheDir,
    outputPath,
    catalogPath,
    mode: 'pilot',
    limit: 100,
    maxRequests: 0,
    waitMs: 0,
    generatedAt: new Date('2026-07-17T00:00:00.000Z'),
  });
  assert.equal(result.fetched, 0);
  assert.equal(result.document.pool.pending, 0);
  assert.equal(fs.readFileSync(catalogPath, 'utf8'), catalogBytes);
  validateSteamCandidateDocument(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
});

test('scheduled pilot builder never downgrades an existing final review cohort', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steam-candidate-final-freeze-'));
  const outputPath = path.join(directory, 'steam-candidates.json');
  const finalDocument = buildSteamCandidateDocument({
    samples: dates(14).map((date) => dailySample(date)),
    appDetailsById: appDetailsEvidence(),
    catalog: { games: [] },
    mode: 'final',
    limit: 100,
    generatedAt: '2026-07-17T00:00:00.000Z',
  });
  const bytes = `${JSON.stringify(finalDocument, null, 2)}\n`;
  fs.writeFileSync(outputPath, bytes);

  const result = await buildSteamCandidates({
    evidenceDir: path.join(directory, 'missing-ranking-is-not-read'),
    cacheDir: path.join(directory, 'missing-cache-is-not-read'),
    outputPath,
    catalogPath: path.join(directory, 'missing-catalog-is-not-read.json'),
    mode: 'pilot',
    limit: 1000,
    maxRequests: 200,
    waitMs: 0,
    generatedAt: new Date('2026-07-18T00:00:00.000Z'),
  });
  assert.equal(result.noOp, true);
  assert.equal(result.document.mode, 'final');
  assert.equal(result.fetched, 0);
  assert.equal(fs.readFileSync(outputPath, 'utf8'), bytes);
});
