import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHistoryArgs } from '../lib/history-cli.mjs';

test('history flags are parsed separately from targeted slugs', () => {
  assert.deepEqual(parseHistoryArgs([]), {
    observationsOnly: false,
    maxLookups: 150,
    onlySlugs: [],
  });
  assert.deepEqual(parseHistoryArgs(['--max-lookups=25', 'hades-ii', '--observations-only']), {
    observationsOnly: true,
    maxLookups: 25,
    onlySlugs: ['hades-ii'],
  });
});

test('history rejects malformed limits and unknown flags', () => {
  assert.throws(() => parseHistoryArgs(['--max-lookups=oops']), /bad --max-lookups/);
  assert.throws(() => parseHistoryArgs(['--max-lookups=-1']), /bad --max-lookups/);
  assert.throws(() => parseHistoryArgs(['--typo']), /unknown option/);
});
