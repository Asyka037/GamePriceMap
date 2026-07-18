import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ESHOP_REGIONS } from '../lib/eshop.mjs';
import { STEAM_REGIONS } from '../lib/steam.mjs';
import { validateImportArtifacts } from '../lib/import-artifacts.mjs';

function writeJson(root, rel, value) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`);
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-artifacts-'));
  const item = {
    key: 'steam:222',
    catalogAction: 'new_game',
    slug: 'new-game',
    title: 'New Game',
    steamAppId: 222,
    nsuids: { americas: '70010000000001', europe: '70010000000002' },
    nintendoUsSlug: 'new-game',
    platforms: ['pc', 'switch'],
  };
  writeJson(root, 'data/catalog.json', { games: [{
    slug: item.slug,
    title: item.title,
    steamAppId: 222,
    nsuids: item.nsuids,
    nintendoUsSlug: item.nintendoUsSlug,
    platforms: item.platforms,
  }] });
  writeJson(root, `data/snapshots/steam/${item.slug}.json`, {
    slug: item.slug,
    regions: STEAM_REGIONS.map((cc) => ({ cc: cc.toUpperCase(), currency: 'USD', amount: 10 })),
  });
  writeJson(root, `data/snapshots/eshop/${item.slug}.json`, {
    slug: item.slug,
    regions: ESHOP_REGIONS.filter(({ group }) => item.nsuids[group]).map(({ cc }) => ({ cc, currency: 'USD', amount: 10 })),
  });
  writeJson(root, `data/meta/${item.slug}.json`, { slug: item.slug, name: 'New Game', headerImage: 'https://example.com/cover.jpg' });
  writeJson(root, `data/history/${item.slug}.json`, {
    slug: item.slug,
    events: [{ d: '2026-07-17', ch: 'steam', cc: 'US', usd: 10 }, { d: '2026-07-17', ch: 'eshop', cc: 'US', usd: 10 }],
    atl: {},
  });
  return { root, plan: { items: [item] }, item };
}

test('import artifacts require broad applicable coverage, native US and channel history events', () => {
  const { root, plan, item } = setup();
  const report = validateImportArtifacts(root, plan);
  assert.deepEqual(report.items[0].channels, ['steam', 'eshop']);

  const steamFile = path.join(root, `data/snapshots/steam/${item.slug}.json`);
  const steam = JSON.parse(fs.readFileSync(steamFile));
  steam.regions = steam.regions.slice(0, 1);
  writeJson(root, `data/snapshots/steam/${item.slug}.json`, steam);
  assert.throws(() => validateImportArtifacts(root, plan), /coverage 1\/18/);
});

test('import artifacts reject a missing first event even when validate-shaped files exist', () => {
  const { root, plan, item } = setup();
  writeJson(root, `data/history/${item.slug}.json`, { slug: item.slug, events: [{ d: '2026-07-17', ch: 'steam', cc: 'US', usd: 10 }], atl: {} });
  assert.throws(() => validateImportArtifacts(root, plan), /missing first eshop/);
});

test('import artifacts bind the reviewed Nintendo US slug and platform generation', () => {
  const { root, plan } = setup();
  const catalogFile = path.join(root, 'data', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  catalog.games[0].nintendoUsSlug = 'different-product';
  writeJson(root, 'data/catalog.json', catalog);
  assert.throws(() => validateImportArtifacts(root, plan), /US product slug drifted/);
  catalog.games[0].nintendoUsSlug = 'new-game';
  catalog.games[0].platforms = ['pc', 'switch-2'];
  writeJson(root, 'data/catalog.json', catalog);
  assert.throws(() => validateImportArtifacts(root, plan), /platform generation drifted/);
});

test('mapping-only imports tolerate an established storefront rename without weakening new-game identity', () => {
  const { root, plan, item } = setup();
  writeJson(root, `data/meta/${item.slug}.json`, {
    slug: item.slug,
    name: 'New Game: Sunset Edition',
    headerImage: 'https://example.com/cover.jpg',
  });

  assert.throws(() => validateImportArtifacts(root, plan), /incomplete reviewed metadata/);
  plan.items[0].catalogAction = 'add_platform_mapping';
  assert.doesNotThrow(() => validateImportArtifacts(root, plan));
});

test('PSN import artifacts require the mapped identity, native US snapshot, and isolated history event', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-import-artifacts-psn-'));
  const item = {
    key: 'psn:UP0700-PPSA04610_00-ELDENRING0000000',
    catalogAction: 'add_platform_mapping',
    slug: 'existing-game',
    title: 'Existing Game',
    steamAppId: null,
    nsuids: null,
    psnProductId: 'UP0700-PPSA04610_00-ELDENRING0000000',
    psnConceptId: '10000333',
    psnEdition: 'standard',
    platforms: ['ps5'],
  };
  writeJson(root, 'data/catalog.json', { games: [{ ...item, platforms: ['pc', 'ps5'] }] });
  writeJson(root, 'data/snapshots/psn/existing-game.json', {
    slug: item.slug,
    regions: [{ cc: 'US', currency: 'USD', amount: 59.99 }],
  });
  writeJson(root, 'data/meta/existing-game.json', {
    slug: item.slug, name: item.title, headerImage: 'https://example.com/cover.jpg',
  });
  writeJson(root, 'data/history/existing-game.json', {
    slug: item.slug, events: [{ d: '2026-07-18', ch: 'psn', cc: 'US', usd: 59.99 }], atl: {},
  });
  const plan = { items: [item] };
  assert.deepEqual(validateImportArtifacts(root, plan).items[0].channels, ['psn']);
  writeJson(root, 'data/history/existing-game.json', { slug: item.slug, events: [], atl: {} });
  assert.throws(() => validateImportArtifacts(root, plan), /missing first psn US observation/u);
});
