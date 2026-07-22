import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeXboxSuggestionDocument } from '../lib/xbox-suggestion-output.mjs';

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xbox-suggestion-output-'));
  fs.mkdirSync(path.join(root, 'data', 'suggestions'), { recursive: true });
  return root;
}

test('Xbox writer atomically replaces only the fixed suggestion path', () => {
  const root = fixtureRoot();
  const output = path.join(root, 'data', 'suggestions', 'xbox-candidates.json');
  try {
    fs.writeFileSync(output, 'old\n');
    assert.equal(writeXboxSuggestionDocument({ sealed: true }, { root }), output);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { sealed: true });
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['xbox-candidates.json']);

    const circular = {};
    circular.self = circular;
    assert.throws(() => writeXboxSuggestionDocument(circular, { root }), /circular/iu);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { sealed: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test('Xbox writer rejects symlink destinations without touching their target', () => {
  const root = fixtureRoot();
  const output = path.join(root, 'data', 'suggestions', 'xbox-candidates.json');
  const victim = path.join(root, 'victim.json');
  try {
    fs.writeFileSync(victim, 'keep\n');
    fs.symlinkSync(victim, output);
    assert.throws(() => writeXboxSuggestionDocument({ sealed: true }, { root }), /regular file/u);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
