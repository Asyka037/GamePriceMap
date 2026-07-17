import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { sha256Digest } from '../lib/candidate-evidence.mjs';
import { validateNintendoSeedDocument } from '../lib/ns-candidates.mjs';
import {
  sealNintendoSeedDraft,
  sealNintendoSeedFile,
} from '../seal-ns-candidate-seeds.mjs';

const raw = JSON.parse(readFileSync(new URL('./fixtures/ns-candidate-seed.json', import.meta.url), 'utf8'));

function withoutEvidenceDigests(value) {
  if (Array.isArray(value)) return value.map(withoutEvidenceDigests);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'evidenceDigest')
    .map(([key, entry]) => [key, withoutEvidenceDigests(entry)]));
}

function draft() {
  return {
    schemaVersion: 1,
    kind: 'nintendo-candidate-seed-draft',
    generatedAt: '2026-07-17T00:00:00.000Z',
    candidates: [withoutEvidenceDigests(raw)],
  };
}

test('seed sealing CLI library binds every nested evidence object and validates the final document', () => {
  const document = sealNintendoSeedDraft(draft());
  validateNintendoSeedDocument(document);
  const candidate = document.candidates[0];
  assert.match(candidate.manualUsEvidence.evidenceDigest, /^sha256:/u);
  assert.match(candidate.popularityEvidence[0].evidenceDigest, /^sha256:/u);
  assert.equal(candidate.popularityEvidence[0].sourceDigest, sha256Digest({ fixture: 'nintendo-rank' }));
});

test('seed sealing writes a separate file and leaves the reviewed draft byte-for-byte unchanged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpm-ns-seed-seal-'));
  const inputPath = path.join(directory, 'draft.json');
  const outputPath = path.join(directory, 'sealed.json');
  const bytes = `${JSON.stringify(draft(), null, 2)}\n`;
  fs.writeFileSync(inputPath, bytes);
  const result = sealNintendoSeedFile({ inputPath, outputPath });
  assert.equal(result.document.candidates.length, 1);
  assert.equal(fs.readFileSync(inputPath, 'utf8'), bytes);
  validateNintendoSeedDocument(JSON.parse(fs.readFileSync(outputPath, 'utf8')));
  assert.throws(() => sealNintendoSeedFile({ inputPath, outputPath: inputPath }), /must not replace/u);
});
