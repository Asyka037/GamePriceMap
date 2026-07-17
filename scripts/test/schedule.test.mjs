import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shardOf, sourceKeyFor, gamesForRun, memberShards, pickOverdueShard, coveredHealthKeys, coveredMetaKeys, CORE_GAME_LIMIT, EXTENDED_SHARDS, META_SHARDS } from '../lib/schedule.mjs';

test('shard assignment is stable across runs and processes (pinned values)', () => {
  // These pins must never change: a game moving shards would silently break
  // its freshness lookup. If the hash changes, that is a data migration.
  const pinned = ['hades-ii', 'elden-ring', 'stardew-valley', 'baldurs-gate-3'].map((s) => shardOf(s));
  assert.deepEqual(pinned, [2, 4, 6, 1], 'changing these values requires a health-ledger migration');
  assert.equal(CORE_GAME_LIMIT, 300);
});

test('shards spread the real catalog roughly evenly', () => {
  const catalog = JSON.parse(readFileSync(new URL('../../data/catalog.json', import.meta.url)));
  const counts = new Array(EXTENDED_SHARDS).fill(0);
  for (const g of catalog.games) counts[shardOf(g.slug)]++;
  const expected = catalog.games.length / EXTENDED_SHARDS;
  for (const c of counts) {
    assert.ok(c > expected * 0.4 && c < expected * 1.8, `unbalanced shard: ${counts.join(',')}`);
  }
});

test('sourceKeyFor: only extended-tier Steam games get shard keys', () => {
  const core = { slug: 'hades-ii', tier: 'core' };
  const ext = { slug: 'hades-ii', tier: 'extended' };
  assert.equal(sourceKeyFor('steam', core), 'steam-regional');
  assert.equal(sourceKeyFor('steam', ext), `steam-regional:extended-${shardOf('hades-ii')}`);
  assert.equal(sourceKeyFor('eshop', ext), 'eshop-regional', 'eShop stays daily-full');
  assert.equal(sourceKeyFor('xbox', ext), 'xbox-us', 'Xbox stays weekly-full');
  assert.equal(sourceKeyFor('nope', ext), null);
});

test('gamesForRun filters by tier and shard; missing tier defaults to core', () => {
  const games = [
    { slug: 'a', tier: 'core' },
    { slug: 'b' },
    { slug: 'c', tier: 'extended' },
    { slug: 'd', tier: 'extended' },
  ];
  assert.deepEqual(gamesForRun(games, { tier: 'core' }).map((g) => g.slug), ['a', 'b']);
  const inShard = gamesForRun(games, { tier: 'extended', shard: shardOf('c') }).map((g) => g.slug);
  assert.ok(inShard.includes('c'));
  assert.ok(!inShard.includes('a'));
  assert.equal(gamesForRun(games, {}).length, 4, 'no selection = full sweep');
});

test('pickOverdueShard prefers never-run shards, then the oldest success', () => {
  const never = { sources: {} };
  assert.equal(pickOverdueShard(never, 'steam-regional'), 0, 'all missing: lowest index');
  const sources = {};
  for (let i = 0; i < EXTENDED_SHARDS; i++) {
    sources[`steam-regional:extended-${i}`] = { lastSuccessAt: `2026-07-${10 + i}T00:00:00Z` };
  }
  assert.equal(pickOverdueShard({ sources }, 'steam-regional'), 0, 'oldest stamp wins');
  sources['steam-regional:extended-0'].lastSuccessAt = '2026-07-20T00:00:00Z';
  assert.equal(pickOverdueShard({ sources }, 'steam-regional'), 1, 'catch-up follows the new oldest');
  delete sources['steam-regional:extended-4'].lastSuccessAt;
  assert.equal(pickOverdueShard({ sources }, 'steam-regional'), 4, 'a failed shard (no success) jumps the queue');
});

test('auto selection ignores empty shards instead of starving populated shards', () => {
  const onlyGame = { slug: 'hades-ii', tier: 'extended' };
  const members = memberShards([onlyGame]);
  assert.deepEqual(members, [2]);
  assert.equal(pickOverdueShard({ sources: {} }, 'steam-regional', EXTENDED_SHARDS, 'extended', members), 2);
  assert.equal(pickOverdueShard({ sources: {} }, 'steam-regional', EXTENDED_SHARDS, 'extended', []), null);
});

test('coveredHealthKeys: full sweep stamps core plus every populated shard', () => {
  const games = [
    { slug: 'a', tier: 'core' },
    { slug: 'c', tier: 'extended' },
  ];
  assert.deepEqual(coveredHealthKeys(games, 'steam-regional', { tier: 'core' }), ['steam-regional']);
  assert.deepEqual(
    coveredHealthKeys(games, 'steam-regional', { tier: 'extended', shard: 3 }),
    ['steam-regional:extended-3'],
  );
  const full = coveredHealthKeys(games, 'steam-regional', {});
  assert.deepEqual(full, ['steam-regional', `steam-regional:extended-${shardOf('c')}`]);
  assert.deepEqual(coveredHealthKeys([{ slug: 'a', tier: 'core' }], 'steam-regional', {}), ['steam-regional'], 'no extended games: core key only');
});

test('meta shards: 14-way rotation with its own key namespace and catch-up', () => {
  const keys = coveredMetaKeys({});
  assert.equal(keys.length, 1 + META_SHARDS, 'full sweep stamps base + every shard');
  assert.equal(keys[0], 'meta');
  assert.equal(keys.at(-1), `meta:shard-${META_SHARDS - 1}`);
  assert.deepEqual(coveredMetaKeys({ shard: 5 }), ['meta:shard-5']);

  const sources = {};
  for (let i = 0; i < META_SHARDS; i++) {
    sources[`meta:shard-${i}`] = { lastSuccessAt: `2026-07-${String(1 + i).padStart(2, '0')}T00:00:00Z` };
  }
  assert.equal(pickOverdueShard({ sources }, 'meta', META_SHARDS, 'shard'), 0);
  sources['meta:shard-0'].lastSuccessAt = '2026-07-30T00:00:00Z';
  assert.equal(pickOverdueShard({ sources }, 'meta', META_SHARDS, 'shard'), 1);
});
