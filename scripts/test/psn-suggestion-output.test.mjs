import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePsnSuggestionDocument } from '../lib/psn-suggestion-output.mjs';

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'psn-suggestion-output-'));
  fs.mkdirSync(path.join(root, 'data', 'suggestions'), { recursive: true });
  return root;
}

test('both PSN discovery paths atomically replace only the fixed suggestion file', () => {
  const root = fixtureRoot();
  const output = path.join(root, 'data', 'suggestions', 'psn-candidates.json');
  try {
    fs.writeFileSync(output, 'old\n');
    assert.equal(writePsnSuggestionDocument({ sealed: true }, { root }), output);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { sealed: true });
    assert.deepEqual(fs.readdirSync(path.dirname(output)), ['psn-candidates.json']);

    const circular = {};
    circular.self = circular;
    assert.throws(() => writePsnSuggestionDocument(circular, { root }), /circular/iu);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), { sealed: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PSN suggestion writer rejects an existing symlink without touching its target', () => {
  const root = fixtureRoot();
  const output = path.join(root, 'data', 'suggestions', 'psn-candidates.json');
  const victim = path.join(root, 'victim.json');
  try {
    fs.writeFileSync(victim, 'keep\n');
    fs.symlinkSync(victim, output);
    assert.throws(() => writePsnSuggestionDocument({ sealed: true }, { root }), /regular file/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
