import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteamReleaseDate, isJunkComingSoonName, mergeCalendarEntries } from '../lib/calendar.mjs';
import { releaseCalendarCliExitCode } from '../lib/release-calendar-run.mjs';

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

test('merge dedupes by exact title/day identity and unions unambiguous platforms', () => {
  const months = mergeCalendarEntries([
    { title: 'Pragmata', date: '2026-07-24', month: '2026-07', platform: 'switch', url: 'https://n.example/pragmata', image: null },
    { title: 'PRAGMATA', date: '2026-07-24', month: '2026-07', platform: 'pc', url: 'https://s.example/pragmata', image: 'https://cdn.example/pragmata.jpg', slugIfTracked: null },
    { title: 'Undated Thing', date: null, month: null, platform: 'pc', url: 'x' },
    { title: 'August Game', date: '2026-08-02', month: '2026-08', platform: 'pc', url: 'https://s.example/august' },
  ]);
  assert.deepEqual(Object.keys(months), ['2026-07', '2026-08']);
  const prag = months['2026-07'][0];
  assert.equal(prag.date, '2026-07-24');
  assert.equal(prag.image, 'https://cdn.example/pragmata.jpg', 'image enrichment survives a cross-source merge');
  assert.deepEqual(prag.platforms.sort(), ['pc', 'switch']);
  assert.deepEqual(prag.urls, {
    pc: 'https://s.example/pragmata',
    switch: 'https://n.example/pragmata',
  });
  assert.equal(months['2026-07'].length, 1, 'undated entry dropped');
});

test('different port dates and same-platform product ambiguity stay as separate rows', () => {
  const months = mergeCalendarEntries([
    { title: 'Port Day', date: '2026-08-02', month: '2026-08', platform: 'pc', url: 'https://s.example/port' },
    { title: 'Port Day', date: '2026-08-04', month: '2026-08', platform: 'xbox', url: 'https://x.example/port' },
  ]);
  assert.equal(months['2026-08'].length, 2);
  assert.deepEqual(months['2026-08'].map((entry) => entry.platforms), [['pc'], ['xbox']]);
  const conflicts = mergeCalendarEntries([
    { title: 'Conflict', date: '2026-08-02', month: '2026-08', platform: 'pc', url: 'https://one.example' },
    { title: 'Conflict', date: '2026-08-02', month: '2026-08', platform: 'pc', url: 'https://two.example' },
  ]);
  assert.equal(conflicts['2026-08'].length, 2);
  assert.deepEqual(conflicts['2026-08'].map((entry) => entry.urls.pc), [
    'https://one.example',
    'https://two.example',
  ]);
});

test('release refresh fails visibly only when no sealed cache exists yet', () => {
  assert.equal(releaseCalendarCliExitCode({ complete: true, hadPreviousCache: false }), 0);
  assert.equal(releaseCalendarCliExitCode({ complete: false, hadPreviousCache: true }), 0);
  assert.equal(releaseCalendarCliExitCode({ complete: false, hadPreviousCache: false }), 1);
  assert.throws(() => releaseCalendarCliExitCode({ complete: false }), /booleans/u);
});
