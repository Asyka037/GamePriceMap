#!/usr/bin/env node
/**
 * Seal a reviewed, untrusted Nintendo seed draft into the immutable A2 input
 * schema. This command never performs network requests and never writes the
 * source draft or catalog.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createNintendoSeedDocument,
  sealDatedEvidence,
  sealManualUsEvidence,
} from './lib/ns-candidates.mjs';

const DRAFT_KIND = 'nintendo-candidate-seed-draft';

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sealOptional(value, seal) {
  if (value == null) return null;
  if (!plainObject(value)) throw new Error('optional evidence must be an object or null');
  return seal(value);
}

export function sealNintendoSeedDraft(draft) {
  if (!plainObject(draft) || draft.schemaVersion !== 1 || draft.kind !== DRAFT_KIND) {
    throw new Error(`input must be a schemaVersion 1 ${DRAFT_KIND} document`);
  }
  if (Object.hasOwn(draft, 'documentDigest')) throw new Error('draft must not carry a documentDigest');
  if (!Array.isArray(draft.candidates) || draft.candidates.length === 0) {
    throw new Error('draft candidates must be a non-empty array');
  }
  const candidates = draft.candidates.map((candidate, index) => {
    if (!plainObject(candidate)) throw new Error(`candidate ${index + 1} must be an object`);
    const sealed = {
      ...structuredClone(candidate),
      manualUsEvidence: sealOptional(candidate.manualUsEvidence, sealManualUsEvidence),
      seedEvidence: (candidate.seedEvidence ?? []).map((evidence) => sealDatedEvidence(evidence)),
      exclusivityEvidence: sealOptional(candidate.exclusivityEvidence, sealDatedEvidence),
      steamMatchEvidence: sealOptional(candidate.steamMatchEvidence, sealDatedEvidence),
      popularityEvidence: (candidate.popularityEvidence ?? []).map((evidence) => sealDatedEvidence(evidence)),
    };
    return sealed;
  });
  return createNintendoSeedDocument({ generatedAt: draft.generatedAt, candidates });
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function sealNintendoSeedFile({ inputPath, outputPath }) {
  const input = path.resolve(inputPath);
  const output = path.resolve(outputPath);
  if (input === output) throw new Error('output must not replace the reviewed draft');
  if (output.endsWith(`${path.sep}data${path.sep}catalog.json`)) throw new Error('output must not be catalog.json');
  const before = fs.readFileSync(input);
  const document = sealNintendoSeedDraft(JSON.parse(before.toString('utf8')));
  atomicWrite(output, `${JSON.stringify(document, null, 2)}\n`);
  if (!fs.readFileSync(input).equals(before)) throw new Error('source draft changed during sealing');
  return { document, inputPath: input, outputPath: output };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split('=', 2);
    if (!['--input', '--output'].includes(flag)) throw new Error(`unknown argument: ${args[index]}`);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (options[flag]) throw new Error(`${flag} may only be provided once`);
    options[flag] = value;
  }
  if (!options['--input'] || !options['--output']) throw new Error('--input and --output are required');
  return { inputPath: options['--input'], outputPath: options['--output'] };
}

function main() {
  const result = sealNintendoSeedFile(parseArgs(process.argv.slice(2)));
  console.log(`sealed ${result.document.candidates.length} Nintendo candidate seed(s)`);
  console.log(`wrote ${result.outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  }
}
