#!/usr/bin/env node
/**
 * Resume-safe Steam candidate builder. It consumes immutable daily ranking
 * evidence, enriches a bounded number of IDs through official appdetails,
 * and writes only a review candidate document — never data/catalog.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateDailySteamRankingEvidence } from './lib/candidate-evidence.mjs';
import {
  buildSteamCandidateDocument,
  candidateDocumentJson,
  createSteamAppDetailsEvidence,
  validateSteamCandidateDocument,
  validateSteamAppDetailsEvidence,
} from './lib/steam-candidates.mjs';
import {
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  sleep,
} from './lib/http.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer in ${min}..${max}`);
  }
  return parsed;
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

function readRankingEvidence(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) throw new Error(`no ranking evidence in ${directory}`);
  return entries.map((name) => {
    const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    return validateDailySteamRankingEvidence(document);
  });
}

function readAppDetailsCache(directory) {
  if (!fs.existsSync(directory)) return new Map();
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  const result = new Map();
  for (const name of entries) {
    const match = name.match(/^(\d+)\.json$/u);
    if (!match) throw new Error(`unexpected appdetails cache file: ${name}`);
    const appId = Number(match[1]);
    const document = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    validateSteamAppDetailsEvidence(document, { appId });
    result.set(appId, document);
  }
  return result;
}

function appDetailsUrl(appId) {
  const url = new URL('https://store.steampowered.com/api/appdetails');
  url.searchParams.set('appids', String(appId));
  url.searchParams.set('cc', 'us');
  url.searchParams.set('l', 'english');
  return url.toString();
}

export function parseBuilderArgs(args) {
  const options = {
    mode: 'pilot',
    limit: 1000,
    maxRequests: 50,
    waitMs: 1200,
    generatedAt: new Date(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const [flag, inline] = argument.split('=', 2);
    if (!['--evidence-dir', '--cache-dir', '--output', '--catalog', '--mode', '--limit', '--max-requests', '--sleep-ms', '--now'].includes(flag)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--evidence-dir') options.evidenceDir = path.resolve(value);
    if (flag === '--cache-dir') options.cacheDir = path.resolve(value);
    if (flag === '--output') options.outputPath = path.resolve(value);
    if (flag === '--catalog') options.catalogPath = path.resolve(value);
    if (flag === '--mode') options.mode = value;
    if (flag === '--limit') options.limit = integer(value, '--limit', { min: 1, max: 5000 });
    if (flag === '--max-requests') options.maxRequests = integer(value, '--max-requests', { max: 200 });
    if (flag === '--sleep-ms') options.waitMs = integer(value, '--sleep-ms', { max: 5000 });
    if (flag === '--now') options.generatedAt = new Date(value);
  }
  if (!['pilot', 'final'].includes(options.mode)) throw new Error('--mode must be pilot or final');
  if (!Number.isFinite(options.generatedAt.valueOf())) throw new Error('--now is invalid');
  options.evidenceDir ??= path.join(ROOT, 'data', 'suggestions', 'evidence', 'steam', 'ranking');
  options.cacheDir ??= path.join(
    ROOT,
    'private',
    'game-library',
    'candidate-cache',
    'steam',
    'appdetails',
  );
  options.outputPath ??= path.join(ROOT, 'data', 'suggestions', 'steam-candidates.json');
  options.catalogPath ??= path.join(ROOT, 'data', 'catalog.json');
  return options;
}

export async function buildSteamCandidates(options = parseBuilderArgs([])) {
  // A final cohort is an immutable review boundary. The scheduled pilot job
  // may keep collecting dated evidence, but it must never downgrade or
  // silently replace a document that humans have started reviewing.
  if (options.mode === 'pilot' && fs.existsSync(options.outputPath)) {
    const existing = validateSteamCandidateDocument(
      JSON.parse(fs.readFileSync(options.outputPath, 'utf8')),
    );
    if (existing.mode === 'final') {
      return { document: existing, outputPath: options.outputPath, fetched: 0, noOp: true };
    }
  }
  const samples = readRankingEvidence(options.evidenceDir);
  const catalog = JSON.parse(fs.readFileSync(options.catalogPath, 'utf8'));
  const appDetailsById = readAppDetailsCache(options.cacheDir);
  let document = buildSteamCandidateDocument({
    samples,
    appDetailsById,
    catalog,
    mode: options.mode,
    limit: options.limit,
    generatedAt: options.generatedAt,
  });
  const pending = document.pendingCandidates.slice(0, options.maxRequests);
  setRequestBudget(requestBudgetFor(pending.length, 0.25));
  for (let index = 0; index < pending.length; index += 1) {
    const { steamAppId } = pending[index];
    const sourceUrl = appDetailsUrl(steamAppId);
    const payload = await fetchJson(sourceUrl, {
      label: `candidate appdetails ${steamAppId}`,
      attempts: 2,
      timeoutMs: 20_000,
    });
    const evidence = createSteamAppDetailsEvidence({
      appId: steamAppId,
      payload,
      sourceUrl,
      fetchedAt: new Date(),
    });
    atomicWrite(path.join(options.cacheDir, `${steamAppId}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    appDetailsById.set(steamAppId, evidence);
    if (options.waitMs > 0 && index < pending.length - 1) await sleep(options.waitMs);
  }

  if (pending.length > 0) {
    document = buildSteamCandidateDocument({
      samples,
      appDetailsById,
      catalog,
      mode: options.mode,
      limit: options.limit,
      generatedAt: options.generatedAt,
    });
  }
  if (options.mode === 'final' && document.pool.incomplete) {
    throw new Error(`final candidate build is incomplete: ${document.pool.pending} appdetails records remain; rerun to resume`);
  }
  atomicWrite(options.outputPath, candidateDocumentJson(document));
  return { document, outputPath: options.outputPath, fetched: pending.length, noOp: false };
}

async function main() {
  const result = await buildSteamCandidates(parseBuilderArgs(process.argv.slice(2)));
  console.log(result.noOp ? `preserved final cohort ${result.outputPath}` : `wrote ${result.outputPath}`);
  console.log(`mode: ${result.document.mode}${result.document.provisional ? ' (provisional)' : ''}`);
  console.log(`distinct UTC dates: ${result.document.distinctUtcDates.length}`);
  console.log(`candidates: ${result.document.candidates.length}; pending: ${result.document.pool.pending}; fetched: ${result.fetched}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
