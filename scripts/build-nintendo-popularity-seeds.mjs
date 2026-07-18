#!/usr/bin/env node
/**
 * Offline Nintendo popularity-pool builder. It reads only retained, digest-
 * bound evidence and emits one <=25 row draft for seal-ns-candidate-seeds.mjs.
 * Default mode is read-only; --apply atomically writes draft + audit report.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildNintendoPopularitySeedBatch,
  NINTENDO_POPULARITY_BATCH_SIZE,
} from './lib/nintendo-popularity-seeds.mjs';
import { atomicWriteFiles } from './lib/import-state.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CATALOG = path.join(ROOT, 'data', 'catalog.json');

function positiveInteger(value, label) {
  if (!/^\d+$/u.test(String(value ?? ''))) throw new Error(`${label} requires an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} requires a positive integer`);
  return number;
}

export function parseNintendoPopularitySeedArgs(args) {
  const options = {
    apply: false,
    manifestPath: null,
    catalogPath: DEFAULT_CATALOG,
    outputPath: null,
    reportPath: null,
    batchSize: NINTENDO_POPULARITY_BATCH_SIZE,
  };
  const fields = new Map([
    ['--manifest', 'manifestPath'],
    ['--catalog', 'catalogPath'],
    ['--output', 'outputPath'],
    ['--report', 'reportPath'],
    ['--batch-size', 'batchSize'],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const [flag, inline] = args[index].split('=', 2);
    if (flag === '--apply') {
      if (inline !== undefined || seen.has(flag)) throw new Error('--apply may only be provided once without a value');
      seen.add(flag);
      options.apply = true;
      continue;
    }
    const field = fields.get(flag);
    if (!field) throw new Error(`unknown argument: ${args[index]}`);
    if (seen.has(flag)) throw new Error(`${flag} may only be provided once`);
    seen.add(flag);
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options[field] = flag === '--batch-size' ? positiveInteger(value, flag) : value;
  }
  if (!options.manifestPath) throw new Error('--manifest is required');
  if (options.apply && (!options.outputPath || !options.reportPath)) {
    throw new Error('--apply requires --output and --report');
  }
  return options;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON: ${error.message}`);
    throw error;
  }
}

function safePaths(options) {
  const paths = Object.fromEntries(['manifestPath', 'catalogPath', 'outputPath', 'reportPath']
    .map((key) => [key, options[key] == null ? null : path.resolve(options[key])]));
  if (paths.outputPath && paths.reportPath && paths.outputPath === paths.reportPath) {
    throw new Error('output and report must be different files');
  }
  if ([paths.outputPath, paths.reportPath].filter(Boolean).includes(paths.catalogPath)) {
    throw new Error('outputs must not replace catalog.json');
  }
  if ([paths.outputPath, paths.reportPath].filter(Boolean).includes(paths.manifestPath)) {
    throw new Error('outputs must not replace the source manifest');
  }
  return paths;
}

export function runNintendoPopularitySeeds({ args = process.argv.slice(2), now = new Date() } = {}) {
  const options = parseNintendoPopularitySeedArgs(args);
  const paths = safePaths(options);
  const manifest = readJson(paths.manifestPath, 'Nintendo popularity manifest');
  const catalog = readJson(paths.catalogPath, 'catalog');
  const manifestDirectory = path.dirname(paths.manifestPath);
  const readSource = (reference) => fs.readFileSync(path.resolve(manifestDirectory, reference));
  const result = buildNintendoPopularitySeedBatch({
    manifest,
    catalog,
    readSource,
    batchSize: options.batchSize,
    generatedAt: now,
  });

  console.log(`sources ${result.report.sourceCount}, evidence rows ${result.report.candidateEvidenceRows}`);
  console.log(`eligible ${result.report.eligible}, selected ${result.report.selected}, remaining ${result.report.remaining}`);
  const rejectionCounts = Object.groupBy(result.report.rejected, (entry) => entry.reason);
  for (const [reason, entries] of Object.entries(rejectionCounts).sort()) {
    console.log(`rejected ${reason}: ${entries.length}`);
  }

  if (options.apply) {
    if (result.draft.candidates.length === 0) {
      const error = new Error('no evidence-backed Nintendo candidates are eligible; no files written');
      error.code = 'no_eligible_candidates';
      throw error;
    }
    atomicWriteFiles([
      { path: paths.outputPath, content: `${JSON.stringify(result.draft, null, 2)}\n` },
      { path: paths.reportPath, content: `${JSON.stringify(result.report, null, 2)}\n` },
    ]);
    console.log(`wrote ${paths.outputPath}`);
    console.log(`wrote ${paths.reportPath}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runNintendoPopularitySeeds();
  } catch (error) {
    console.error(`${error.code ? `${error.code}: ` : ''}${error.message}`);
    process.exitCode = 1;
  }
}
