import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamReleaseDate, isJunkComingSoonName, mergeCalendarEntries } from '../lib/calendar.mjs';

test('steam date formats parse to iso date/month', () => {
  assert.deepEqual(parseSteamReleaseDate('24 Jul, 2026'), { date: '2026-07-24', month: '2026-07' });
  assert.deepEqual(parseSteamReleaseDate('Jul 24, 2026'), { date: '2026-07-24', month: '2026-07' });
  assert.deepEqual(parseSteamReleaseDate('September 2026'), { date: null, month: '2026-09' });
});

test('vague steam dates are rejected, not guessed', () => {
  for (const s of ['Q4 2026', '2026', 'Coming soon', 'To be announced', '', null]) {
    assert.deepEqual(parseSteamReleaseDate(s), { date: null, month: null }, `should reject: ${s}`);
  }
});

test('junk coming-soon names are filtered', () => {
  assert.ok(isJunkComingSoonName('Kings Call 2 Demo'));
  assert.ok(isJunkComingSoonName('Epic Game Original Soundtrack'));
  assert.ok(!isJunkComingSoonName('Silksong 2'));
});

test('merge dedupes by title, unions platforms, prefers concrete dates', () => {
  const months = mergeCalendarEntries([
    { title: 'Pragmata', date: null, month: '2026-07', platform: 'switch', url: 'n', image: null },
    { title: 'PRAGMATA', date: '2026-07-24', month: '2026-07', platform: 'pc', url: 's', image: 'https://cdn.example/pragmata.jpg', slugIfTracked: null },
    { title: 'Undated Thing', date: null, month: null, platform: 'pc', url: 'x' },
    { title: 'August Game', date: '2026-08-02', month: '2026-08', platform: 'pc', url: 'y' },
  ]);
  assert.deepEqual(Object.keys(months), ['2026-07', '2026-08']);
  const prag = months['2026-07'][0];
  assert.equal(prag.date, '2026-07-24');
  assert.equal(prag.image, 'https://cdn.example/pragmata.jpg', 'image enrichment survives a cross-source merge');
  assert.deepEqual(prag.platforms.sort(), ['pc', 'switch']);
  assert.equal(months['2026-07'].length, 1, 'undated entry dropped');
});
