import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConsoleCalendar } from '../merge-console-calendar.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = new Date('2026-07-22T12:00:00.000Z');
const XBOX_URL = 'https://www.microsoft.com/en-us/p/_/9p3j32ctxlrz';
const XBOX_IMAGE = 'https://store-images.s-microsoft.com/image/apps.1/shared-game';
const PSN_ID = 'UP0001-PPSA00001_00-ABCDEFGHIJKLMNOP';
const PSN_URL = `https://store.playstation.com/en-us/product/${PSN_ID}`;
const PSN_IMAGE = 'https://image.api.playstation.com/vulcan/ap/rnd/ps-future.png';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'console-calendar-merge-'));
  writeJson(path.join(root, 'data', 'catalog.json'), { games: [] });
  writeJson(path.join(root, 'data', 'feeds', 'calendar.json'), {
    updatedAt: '2026-07-21T09:00:00.000Z',
    months: {
      '2026-08': [
        {
          title: 'Shared Game',
          date: '2026-08-05',
          month: '2026-08',
          platforms: ['pc', 'switch', 'xbox'],
          urls: {
            pc: 'https://store.steampowered.com/app/1/',
            switch: 'https://www.nintendo.example/shared-game',
            xbox: 'https://www.microsoft.com/en-us/p/_/9aaaaaaaaaaa',
          },
          image: 'https://old.example/shared.jpg',
          slugIfTracked: null,
        },
        {
          title: 'Base Pair',
          date: '2026-08-10',
          month: '2026-08',
          platforms: ['pc', 'switch'],
          urls: {
            pc: 'https://store.steampowered.com/app/2/',
            switch: 'https://www.nintendo.example/base-pair',
          },
          image: 'https://base.example/pair.jpg',
          slugIfTracked: null,
        },
      ],
    },
  });
  writeJson(path.join(root, 'data', 'feeds', 'releases-xbox.json'), {
    schemaVersion: 1,
    source: 'calendar-xbox-us',
    updatedAt: '2026-07-22T10:00:00.000Z',
    items: [{
      title: 'Shared Game',
      date: '2026-08-05',
      month: '2026-08',
      platform: 'xbox',
      url: XBOX_URL,
      image: XBOX_IMAGE,
      slugIfTracked: null,
    }],
  });
  writeJson(path.join(root, 'data', 'feeds', 'releases-psn.json'), {
    schemaVersion: 1,
    source: 'calendar-psn-us',
    updatedAt: '2026-07-22T11:00:00.000Z',
    items: [{
      title: 'PS Future',
      date: '2026-08-08',
      month: '2026-08',
      platform: 'psn',
      url: PSN_URL,
      image: PSN_IMAGE,
      slugIfTracked: null,
    }],
  });
  return root;
}

test('zero-network merge replaces console rows while preserving split PC/Switch URLs', (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = mergeConsoleCalendar({ root, now: NOW });
  assert.equal(result.changed, true);
  assert.equal(result.entries, 3);
  const calendar = JSON.parse(fs.readFileSync(path.join(root, 'data', 'feeds', 'calendar.json'), 'utf8'));
  assert.equal(calendar.updatedAt, NOW.toISOString());
  const shared = calendar.months['2026-08'].find((entry) => entry.title === 'Shared Game');
  assert.deepEqual(shared.platforms, ['pc', 'switch', 'xbox']);
  assert.deepEqual(shared.urls, {
    xbox: XBOX_URL,
    pc: 'https://store.steampowered.com/app/1/',
    switch: 'https://www.nintendo.example/shared-game',
  });
  assert.equal(shared.image, XBOX_IMAGE, 'fresh sealed console cache keeps source priority');
  const basePair = calendar.months['2026-08'].find((entry) => entry.title === 'Base Pair');
  assert.deepEqual(basePair.platforms, ['pc', 'switch']);
  assert.deepEqual(basePair.urls, {
    pc: 'https://store.steampowered.com/app/2/',
    switch: 'https://www.nintendo.example/base-pair',
  });
  const psn = calendar.months['2026-08'].find((entry) => entry.title === 'PS Future');
  assert.deepEqual(psn.platforms, ['psn']);
  assert.equal(psn.urls.psn, PSN_URL);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data', 'feeds')).filter((name) => name.endsWith('.tmp')), []);
});

test('semantic no-op keeps calendar bytes and timestamp unchanged', (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  mergeConsoleCalendar({ root, now: NOW });
  const calendarPath = path.join(root, 'data', 'feeds', 'calendar.json');
  const before = fs.readFileSync(calendarPath, 'utf8');

  const result = mergeConsoleCalendar({ root, now: new Date('2026-07-22T13:00:00.000Z') });
  assert.equal(result.changed, false);
  assert.equal(fs.readFileSync(calendarPath, 'utf8'), before);
  assert.equal(JSON.parse(before).updatedAt, NOW.toISOString());
});

test('existing console rows require their corresponding sealed cache', (t) => {
  for (const { platform, cache } of [
    { platform: 'xbox', cache: 'releases-xbox.json' },
    { platform: 'psn', cache: 'releases-psn.json' },
  ]) {
    const root = fixtureRoot();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const calendarPath = path.join(root, 'data', 'feeds', 'calendar.json');
    if (platform === 'psn') {
      const calendar = JSON.parse(fs.readFileSync(calendarPath, 'utf8'));
      calendar.months['2026-08'].push({
        title: 'Existing PSN',
        date: '2026-08-09',
        month: '2026-08',
        platforms: ['psn'],
        urls: { psn: PSN_URL },
        image: PSN_IMAGE,
        slugIfTracked: null,
      });
      writeJson(calendarPath, calendar);
    }
    fs.unlinkSync(path.join(root, 'data', 'feeds', cache));
    const before = fs.readFileSync(calendarPath, 'utf8');
    assert.throws(
      () => mergeConsoleCalendar({ root, now: NOW }),
      new RegExp(`contains ${platform}, but ${cache} is missing`, 'u'),
    );
    assert.equal(fs.readFileSync(calendarPath, 'utf8'), before, 'failure must not touch calendar.json');
  }
});

test('invalid release cache fails before the atomic output write', (t) => {
  const root = fixtureRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calendarPath = path.join(root, 'data', 'feeds', 'calendar.json');
  const cachePath = path.join(root, 'data', 'feeds', 'releases-xbox.json');
  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  cache.source = 'calendar-psn-us';
  writeJson(cachePath, cache);
  const before = fs.readFileSync(calendarPath, 'utf8');

  assert.throws(() => mergeConsoleCalendar({ root, now: NOW }), /not a sealed calendar-xbox-us cache/u);
  assert.equal(fs.readFileSync(calendarPath, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(calendarPath)).filter((name) => name.endsWith('.tmp')), []);
});

test('both console workflows merge after scraping and before validation', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['merge:console-calendar'], 'node scripts/merge-console-calendar.mjs');
  for (const { file, scrape } of [
    { file: 'weekly.yml', scrape: 'npm run scrape:xbox-calendar' },
    { file: 'psn-calendar-weekly.yml', scrape: 'npm run scrape:psn-calendar' },
  ]) {
    const workflow = fs.readFileSync(path.join(PROJECT_ROOT, '.github', 'workflows', file), 'utf8');
    const scrapeIndex = workflow.indexOf(scrape);
    const mergeIndex = workflow.indexOf('npm run merge:console-calendar');
    const validateIndex = workflow.indexOf('npm run validate');
    assert.ok(scrapeIndex >= 0 && mergeIndex > scrapeIndex && validateIndex > mergeIndex, `${file} has safe merge ordering`);
  }
  const psn = fs.readFileSync(path.join(PROJECT_ROOT, '.github', 'workflows', 'psn-calendar-weekly.yml'), 'utf8');
  assert.match(psn, /git add data\/feeds\/calendar\.json data\/source-health\.json/u);
});
