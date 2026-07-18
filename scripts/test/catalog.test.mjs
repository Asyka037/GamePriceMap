import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PSN_POC_GAME_LIMIT,
  applyBatchToCatalog,
  catalogIndexes,
  expectedImportArtifacts,
  validateCatalogGame,
} from '../lib/catalog.mjs';
import { createBatchPlan, sha256 } from '../lib/import-run.mjs';

function baseGame(overrides = {}) {
  return {
    slug: 'existing-game',
    title: 'Existing Game',
    steamAppId: 111,
    nsuids: null,
    platforms: ['pc'],
    tier: 'core',
    addedAt: '2026-07-08',
    ...overrides,
  };
}

function plan(items) {
  return createBatchPlan({
    batchId: 'steam-0001',
    baseCommit: 'a'.repeat(40),
    branch: 'main',
    addedAt: '2026-07-17',
    items: items.map((item) => ({
      evidenceDigest: sha256(`evidence:${item.key}`),
      humanDecisionDigest: sha256(`approved:${item.key}`),
      verifiedAt: '2026-07-17T00:00:00Z',
      ...item,
    })),
  });
}

test('new imports are appended as extended and expose an exact artifact set', () => {
  const batch = plan([{
    key: 'steam:222',
    catalogAction: 'new_game',
    slug: 'new-game',
    title: 'New Game',
    steamAppId: 222,
    nsuids: null,
    platforms: ['pc', 'ps5'],
  }]);
  const next = applyBatchToCatalog({ games: [baseGame()] }, batch);
  assert.deepEqual(next.games[1], {
    slug: 'new-game',
    title: 'New Game',
    steamAppId: 222,
    nsuids: null,
    platforms: ['pc', 'ps5'],
    tier: 'extended',
    addedAt: '2026-07-17',
  });
  assert.deepEqual(expectedImportArtifacts(batch), [
    'data/catalog.json',
    'data/history/new-game.json',
    'data/imports/steam-0001.json',
    'data/meta/new-game.json',
    'data/snapshots/steam/new-game.json',
  ]);
});

test('platform mapping merges into one logical game and refuses to replace IDs', () => {
  const addSwitch = plan([{
    key: 'ns:70010000000001',
    catalogAction: 'add_platform_mapping',
    slug: 'existing-game',
    title: 'Existing Game',
    steamAppId: null,
    nintendoUsSlug: 'existing-game-switch',
    nsuids: { americas: '70010000000001', europe: '70010000000002' },
    platforms: ['switch'],
  }]);
  const next = applyBatchToCatalog({ games: [baseGame()] }, addSwitch);
  assert.deepEqual(next.games[0].platforms, ['pc', 'switch']);
  assert.equal(next.games[0].nsuids.americas, '70010000000001');
  assert.throws(() => applyBatchToCatalog({ games: [baseGame({ steamAppId: 999 })] }, plan([{
    key: 'steam:222', catalogAction: 'add_platform_mapping', slug: 'existing-game', title: 'Existing Game', steamAppId: 222, nsuids: null, platforms: ['pc'],
  }])), /replace existing Steam/);
  assert.throws(() => applyBatchToCatalog({ games: [baseGame()] }, plan([{
    ...addSwitch.items[0],
    title: 'Existing Game for Nintendo Switch',
  }])), /exactly match/);
  assert.throws(() => applyBatchToCatalog({ games: [baseGame({
    nintendoUsSlug: 'different-us-product',
    nsuids: { americas: '70010000000001' },
    platforms: ['pc', 'switch'],
  })] }, addSwitch), /replace existing Nintendo US product slug/);
  assert.throws(() => applyBatchToCatalog({ games: [baseGame({
    nintendoUsSlug: 'existing-game-switch',
    nsuids: { americas: '70010000000001' },
    platforms: ['pc', 'switch-2'],
  })] }, addSwitch), /generation conflicts/);
});

test('catalog schema rejects ID/platform mismatches and duplicate external IDs', () => {
  assert.throws(() => validateCatalogGame(baseGame({ platforms: ['ps5'] })), /requires pc/);
  assert.throws(() => validateCatalogGame(baseGame({ steamAppId: null })), /no supported store/);
  assert.throws(() => catalogIndexes({ games: [baseGame(), baseGame({ slug: 'other' })] }), /duplicate Steam AppID/);
});

test('PSN POC mappings pin one standard product SKU and a PlayStation platform', () => {
  const mapping = {
    psnProductId: 'UP9000-PPSA08329_00-GOWRAGNAROK00000',
    psnConceptId: '10001850',
    psnEdition: 'standard',
    platforms: ['pc', 'ps5'],
  };
  assert.doesNotThrow(() => validateCatalogGame(baseGame(mapping)));
  assert.throws(() => validateCatalogGame(baseGame({ ...mapping, psnEdition: 'deluxe' })), /requires psnEdition/);
  assert.throws(() => validateCatalogGame(baseGame({ ...mapping, platforms: ['pc'] })), /requires a PlayStation platform/);
  assert.throws(() => validateCatalogGame(baseGame({ ...mapping, psnProductId: '10001850' })), /bad psnProductId/);
  assert.throws(() => validateCatalogGame(baseGame({ psnConceptId: '10001850' })), /requires psnProductId/);
  assert.throws(() => catalogIndexes({ games: [
    baseGame(mapping),
    baseGame({ ...mapping, slug: 'other', steamAppId: 222, psnConceptId: '10009999' }),
  ] }), /duplicate PSN product ID/);
});

test('PSN POC cannot grow past 20 mappings before the two-week stability milestone', () => {
  const psnGame = (index) => baseGame({
    slug: `psn-game-${index}`,
    title: `PSN Game ${index}`,
    steamAppId: 1000 + index,
    psnProductId: `UP9000-PPSA${String(index).padStart(5, '0')}_00-${String(index).padStart(16, '0')}`,
    psnEdition: 'standard',
    platforms: ['pc', 'ps5'],
  });
  assert.equal(PSN_POC_GAME_LIMIT, 20);
  assert.doesNotThrow(() => catalogIndexes({
    games: Array.from({ length: PSN_POC_GAME_LIMIT }, (_, index) => psnGame(index + 1)),
  }));
  assert.throws(() => catalogIndexes({
    games: Array.from({ length: PSN_POC_GAME_LIMIT + 1 }, (_, index) => psnGame(index + 1)),
  }), /PSN POC has 21 games \(limit 20/u);
});
