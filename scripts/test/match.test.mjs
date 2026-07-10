import test from 'node:test';
import assert from 'node:assert/strict';
import { normTitle, titleMatches } from '../lib/match.mjs';

test('unicode titles keep their letters (review finding: JP titles normalized to empty)', () => {
  assert.notEqual(normTitle('ゼルダの伝説'), '');
  assert.notEqual(normTitle('ゼルダの伝説'), normTitle('モンハン'));
  assert.equal(normTitle('Hollow Knight: Silksong'), 'hollowknightsilksong');
});

test('empty normalizations never match', () => {
  assert.equal(titleMatches('★☆★', '♪♪'), false);
  assert.equal(titleMatches('', ''), false);
});

test('franchise prefix is not a match; edition suffixes are tolerated', () => {
  assert.equal(titleMatches('Hollow Knight: Silksong', 'Hollow Knight'), false);
  assert.equal(titleMatches('HADES II', 'Hades'), false);
  assert.equal(titleMatches('Stardew Valley for Nintendo Switch', 'Stardew Valley'), true);
  assert.equal(titleMatches('Celeste', 'Celeste'), true);
});
