#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCandidateSourceDocument } from './lib/candidate-source.mjs';
import { verifyApprovedCandidates } from './lib/candidate-verifier.mjs';
import { assertRepositoryReady } from './lib/import-git.mjs';
import {
  abortImportRun,
  importRunStatus,
  resumeImportRun,
  startImportRun,
} from './lib/import-orchestrator.mjs';
import { readJsonFile, validateBatchPlan } from './lib/import-run.mjs';
import {
  DEFAULT_VERIFICATION_TTL_MS,
  buildFrozenBatchPlan,
  transitionBatchApplyState,
} from './lib/import-selection.mjs';
import {
  APPLY_STATUS,
  joinCandidatesWithState,
  readImportState,
  writeImportState,
} from './lib/import-state.mjs';
import {
  mergeCandidatesWithWorkbook,
  readLibraryWorkbook,
} from './lib/library-workbook.mjs';
import {
  fetchJson,
  requestBudgetFor,
  setRequestBudget,
  sleep,
} from './lib/http.mjs';
import { exportReviewArtifacts } from './export-candidate-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{5,95}$/u;
const MODE_FLAGS = new Set(['--verify', '--apply', '--resume', '--abort', '--status']);
const VALUE_FLAGS = new Set([
  '--candidate-source',
  '--workbook',
  '--state',
  '--out-dir',
  '--max-requests',
  '--sleep-ms',
  '--batch',
  '--batch-id',
  '--run-id',
]);
const MODE_ALLOWED = Object.freeze({
  verify: new Set(['candidateSource', 'workbook', 'state', 'outDir', 'maxRequests', 'sleepMs']),
  apply: new Set(['candidateSource', 'batch', 'batchId', 'runId']),
  resume: new Set(['runId']),
  abort: new Set(['runId']),
  status: new Set(['runId']),
});
const OPTION_NAMES = Object.freeze({
  '--candidate-source': 'candidateSource',
  '--workbook': 'workbook',
  '--state': 'state',
  '--out-dir': 'outDir',
  '--max-requests': 'maxRequests',
  '--sleep-ms': 'sleepMs',
  '--batch': 'batch',
  '--batch-id': 'batchId',
  '--run-id': 'runId',
});

function integerOption(value, flag, { min, max }) {
  if (!/^\d+$/u.test(value ?? '')) throw new Error(`${flag} requires an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be ${min}..${max}`);
  }
  return parsed;
}

function optionValue(args, index, inline, flag) {
  if (inline !== undefined) {
    if (!inline) throw new Error(`${flag} requires a value`);
    return { value: inline, nextIndex: index };
  }
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return { value, nextIndex: index + 1 };
}

/** Strict parser: no positional arguments, aliases, implicit plans, or unknown flags. */
export function parseImportArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array');
  let mode = null;
  const options = {};
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== 'string' || !argument.startsWith('--')) {
      throw new Error(`unexpected positional import argument: ${argument}`);
    }
    const equal = argument.indexOf('=');
    const flag = equal >= 0 ? argument.slice(0, equal) : argument;
    const inline = equal >= 0 ? argument.slice(equal + 1) : undefined;

    if (MODE_FLAGS.has(flag)) {
      if (mode !== null) throw new Error('choose exactly one import mode');
      if (['--verify', '--apply'].includes(flag)) {
        if (inline !== undefined) throw new Error(`${flag} does not accept a value`);
        mode = flag.slice(2);
        continue;
      }
      const parsed = optionValue(args, index, inline, flag);
      mode = flag.slice(2);
      options.runId = parsed.value;
      index = parsed.nextIndex;
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown import argument: ${argument}`);
    if (seen.has(flag)) throw new Error(`duplicate import argument: ${flag}`);
    seen.add(flag);
    const parsed = optionValue(args, index, inline, flag);
    options[OPTION_NAMES[flag]] = parsed.value;
    index = parsed.nextIndex;
  }
  if (mode === null) throw new Error('choose exactly one mode: --verify, --apply, --resume, --abort, or --status');
  const allowed = MODE_ALLOWED[mode];
  if (mode !== 'apply' && seen.has('--run-id')) {
    throw new Error(`--run-id is not valid for --${mode}`);
  }
  const disallowed = Object.keys(options).filter((name) => !allowed.has(name));
  if (disallowed.length > 0) throw new Error(`option is not valid for --${mode}: ${disallowed[0]}`);

  if (['verify', 'apply'].includes(mode) && !options.candidateSource) {
    throw new Error(`--${mode} requires --candidate-source FILE`);
  }
  if (mode === 'apply' && options.batch === undefined) throw new Error('--apply requires --batch 1..100');
  if (mode === 'verify') {
    options.maxRequests = integerOption(options.maxRequests ?? '50', '--max-requests', { min: 1, max: 200 });
    options.sleepMs = integerOption(options.sleepMs ?? '1200', '--sleep-ms', { min: 0, max: 5000 });
  }
  if (mode === 'apply') options.batch = integerOption(options.batch, '--batch', { min: 1, max: 100 });
  if (['resume', 'abort', 'status'].includes(mode) && !options.runId) throw new Error(`--${mode} requires RUN_ID`);
  if (options.runId && !RUN_ID_RE.test(options.runId)) throw new Error('invalid runId');
  return { mode, ...options };
}

export { validateCandidateSourceDocument };

function candidateSourceDocument(filePath) {
  const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  validateCandidateSourceDocument(document);
  return document;
}

function defaultPaths(root) {
  const importDir = path.join(root, 'private', 'game-library', 'import');
  return {
    workbookPath: path.join(root, 'private', 'game-library', 'GamePriceMap-game-library.xlsx'),
    statePath: path.join(importDir, 'state.json'),
    outputDir: importDir,
    catalogPath: path.join(root, 'data', 'catalog.json'),
    stateRoot: importDir,
  };
}

function loadCurrentContext({ candidateSourcePath, workbookPath, statePath }) {
  const source = candidateSourceDocument(candidateSourcePath);
  const library = readLibraryWorkbook(workbookPath);
  const state = readImportState(statePath);
  const merged = mergeCandidatesWithWorkbook(source.candidates, library.rows, library.decisionRows);
  return {
    source,
    library,
    state,
    candidates: joinCandidatesWithState(merged, state),
  };
}

function runPlanPath(stateRoot, runId) {
  if (!RUN_ID_RE.test(runId ?? '')) throw new Error('invalid runId');
  return path.join(stateRoot, 'runs', runId, 'plan.json');
}

function readTrustedRunPlan(stateRoot, runId) {
  return validateBatchPlan(readJsonFile(runPlanPath(stateRoot, runId)));
}

function appDetailsUrl(appId) {
  const url = new URL('https://store.steampowered.com/api/appdetails');
  url.searchParams.set('appids', String(appId));
  url.searchParams.set('cc', 'us');
  url.searchParams.set('l', 'english');
  return url.toString();
}

function clockValue(clock) {
  const value = typeof clock === 'function' ? clock() : clock;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.valueOf())) throw new Error('invalid CLI clock');
  return date;
}

function resolveCliPath(value) {
  return path.resolve(process.cwd(), value);
}

function productionDependencies(overrides = {}) {
  const root = path.resolve(overrides.root ?? ROOT);
  const paths = { ...defaultPaths(root), ...(overrides.paths ?? {}) };
  return {
    root,
    paths,
    clock: overrides.clock ?? (() => new Date()),
    loadContext: overrides.loadContext ?? loadCurrentContext,
    readCatalog: overrides.readCatalog ?? ((file) => JSON.parse(fs.readFileSync(file, 'utf8'))),
    writeState: overrides.writeState ?? writeImportState,
    readState: overrides.readState ?? readImportState,
    exportReports: overrides.exportReports ?? exportReviewArtifacts,
    configureRequestBudget: overrides.configureRequestBudget ?? ((limit) => setRequestBudget(requestBudgetFor(limit, 0.25))),
    fetchSteamAppDetails: overrides.fetchSteamAppDetails ?? (async (appId) => fetchJson(appDetailsUrl(appId), {
      label: `verify candidate appdetails ${appId}`,
      attempts: 2,
      timeoutMs: 20_000,
    })),
    wait: overrides.wait ?? sleep,
    verifyNintendo: overrides.verifyNintendo ?? null,
    verifyApproved: overrides.verifyApproved ?? verifyApprovedCandidates,
    repositoryIdentity: overrides.repositoryIdentity ?? ((repo) => {
      const ready = assertRepositoryReady(repo);
      return { branch: ready.branch, baseCommit: ready.head };
    }),
    buildBatchPlan: overrides.buildBatchPlan ?? buildFrozenBatchPlan,
    transitionBatchState: overrides.transitionBatchState ?? transitionBatchApplyState,
    startRun: overrides.startRun ?? startImportRun,
    resumeRun: overrides.resumeRun ?? resumeImportRun,
    abortRun: overrides.abortRun ?? abortImportRun,
    runStatus: overrides.runStatus ?? importRunStatus,
    loadRunPlan: overrides.loadRunPlan ?? readTrustedRunPlan,
    verificationTtlMs: overrides.verificationTtlMs ?? DEFAULT_VERIFICATION_TTL_MS,
    orchestratorOptions: overrides.orchestratorOptions ?? {},
  };
}

function contextOptions(parsed, deps) {
  return {
    candidateSourcePath: resolveCliPath(parsed.candidateSource),
    workbookPath: parsed.workbook ? resolveCliPath(parsed.workbook) : deps.paths.workbookPath,
    statePath: parsed.state ? resolveCliPath(parsed.state) : deps.paths.statePath,
  };
}

function assertSourceReadyForApply(source) {
  if (!source || typeof source !== 'object') throw new Error('apply requires the current sealed candidate source context');
  if (source.kind === 'steam-candidates'
    && (source.mode !== 'final' || source.provisional !== false || (source.distinctUtcDates?.length ?? 0) < 14)) {
    const error = new Error('provisional Steam candidates cannot be applied; final evidence needs at least 14 distinct UTC dates');
    error.code = 'PROVISIONAL_CANDIDATES';
    throw error;
  }
}

async function verifyCommand(parsed, deps) {
  const paths = contextOptions(parsed, deps);
  const outputDir = parsed.outDir ? resolveCliPath(parsed.outDir) : deps.paths.outputDir;
  const context = deps.loadContext(paths);
  const catalog = deps.readCatalog(deps.paths.catalogPath);
  const now = clockValue(deps.clock);
  deps.configureRequestBudget(parsed.maxRequests);
  const verification = await deps.verifyApproved(context.candidates, context.state, {
    catalog,
    fetchSteamAppDetails: deps.fetchSteamAppDetails,
    verifyNintendo: deps.verifyNintendo,
    persist: (state) => deps.writeState(paths.statePath, state),
    now,
    verificationTtlMs: deps.verificationTtlMs,
    limit: parsed.maxRequests,
    wait: () => deps.wait(parsed.sleepMs),
  });
  const reports = deps.exportReports({
    workbookPath: paths.workbookPath,
    statePath: paths.statePath,
    outputDir,
    candidateSourcePath: paths.candidateSourcePath,
    generatedAt: clockValue(deps.clock).toISOString(),
  });
  return {
    mode: 'verify',
    processed: verification.processed,
    passed: verification.results.filter((result) => result.passed).length,
    exceptions: verification.results.filter((result) => !result.passed).length,
    results: verification.results,
    statePath: paths.statePath,
    reports: reports.outputPaths,
  };
}

function manifestState(result) {
  if (result?.state) return result.state;
  if (result?.noOp) return 'applied';
  return null;
}

function stateAfterRunResult(state, plan, result, deps, now) {
  const status = manifestState(result);
  if (status === 'applied') {
    return deps.transitionBatchState(state, plan, APPLY_STATUS.APPLIED, { at: now.toISOString() });
  }
  if (['failed', 'stale_base', 'aborted'].includes(status)) {
    return deps.transitionBatchState(state, plan, APPLY_STATUS.FAILED, {
      at: now.toISOString(),
      reason: result?.error?.message ?? status,
    });
  }
  return state;
}

function requireCompletedRun(operation, result, expected) {
  const state = manifestState(result);
  if (state !== expected) {
    const error = new Error(`${operation} did not complete: run state is ${state ?? 'unknown'}`);
    error.code = state === 'paused' ? 'IMPORT_PAUSED' : 'IMPORT_INCOMPLETE';
    throw error;
  }
  return state;
}

function statusAfterFailure(deps, runId) {
  try {
    return deps.runStatus(deps.root, runId, deps.orchestratorOptions);
  } catch {
    return null;
  }
}

async function applyCommand(parsed, deps) {
  const paths = contextOptions(parsed, deps);
  const context = deps.loadContext(paths);
  assertSourceReadyForApply(context.source);
  const catalog = deps.readCatalog(deps.paths.catalogPath);
  const now = clockValue(deps.clock);
  const identity = deps.repositoryIdentity(deps.root);
  const frozenCandidates = context.candidates;
  const plan = deps.buildBatchPlan(frozenCandidates, {
    limit: parsed.batch,
    branch: identity.branch,
    baseCommit: identity.baseCommit,
    addedAt: now.toISOString().slice(0, 10),
    batchId: parsed.batchId ?? null,
    now,
    maxVerifiedAgeMs: deps.verificationTtlMs,
    catalog,
  });
  const runId = parsed.runId ?? `${plan.batchId}-${now.getTime().toString(36)}`;
  if (!RUN_ID_RE.test(runId)) throw new Error('invalid runId');

  let state = deps.transitionBatchState(context.state, plan, APPLY_STATUS.STAGED, {
    at: now.toISOString(),
    reason: `run ${runId}`,
  });
  deps.writeState(paths.statePath, state);
  let result;
  try {
    result = await deps.startRun(deps.root, plan, {
      ...deps.orchestratorOptions,
      runId,
    });
  } catch (error) {
    const status = statusAfterFailure(deps, runId);
    if (status?.state === 'applied') {
      state = deps.transitionBatchState(state, plan, APPLY_STATUS.APPLIED, {
        at: clockValue(deps.clock).toISOString(),
      });
      deps.writeState(paths.statePath, state);
      result = status;
    } else if (status && status.state !== 'paused') {
      state = deps.transitionBatchState(state, plan, APPLY_STATUS.FAILED, {
        at: clockValue(deps.clock).toISOString(),
        reason: error.message,
      });
      deps.writeState(paths.statePath, state);
    } else if (!status) {
      state = deps.transitionBatchState(state, plan, APPLY_STATUS.FAILED, {
        at: clockValue(deps.clock).toISOString(),
        reason: `start failed: ${error.message}`,
      });
      deps.writeState(paths.statePath, state);
    }
    if (!result) throw error;
  }

  const nextState = stateAfterRunResult(state, plan, result, deps, clockValue(deps.clock));
  if (nextState !== state) deps.writeState(paths.statePath, nextState);
  const completedState = requireCompletedRun('apply', result, 'applied');
  return {
    mode: 'apply',
    runId,
    batchId: plan.batchId,
    batchDigest: plan.batchDigest,
    items: plan.items.map((item) => item.key),
    state: completedState,
    noOp: Boolean(result?.noOp),
  };
}

function syncRunState(parsed, deps, operation) {
  const plan = deps.loadRunPlan(deps.paths.stateRoot, parsed.runId);
  const state = deps.readState(deps.paths.statePath);
  const now = clockValue(deps.clock);
  let result;
  try {
    result = operation();
  } catch (error) {
    const status = statusAfterFailure(deps, parsed.runId);
    if (status?.state === 'applied') {
      const applied = deps.transitionBatchState(state, plan, APPLY_STATUS.APPLIED, {
        at: clockValue(deps.clock).toISOString(),
      });
      deps.writeState(deps.paths.statePath, applied);
      result = status;
    } else if (status && ['failed', 'stale_base', 'aborted'].includes(status.state)) {
      const failed = deps.transitionBatchState(state, plan, APPLY_STATUS.FAILED, {
        at: now.toISOString(),
        reason: error.message,
      });
      deps.writeState(deps.paths.statePath, failed);
    }
    if (!result) throw error;
  }
  const nextState = stateAfterRunResult(state, plan, result, deps, clockValue(deps.clock));
  if (nextState !== state) deps.writeState(deps.paths.statePath, nextState);
  return { plan, result };
}

function resumeCommand(parsed, deps) {
  const { plan, result } = syncRunState(parsed, deps, () => deps.resumeRun(
    deps.root,
    parsed.runId,
    deps.orchestratorOptions,
  ));
  const completedState = requireCompletedRun('resume', result, 'applied');
  return {
    mode: 'resume',
    runId: parsed.runId,
    batchId: plan.batchId,
    state: completedState,
    noOp: Boolean(result?.noOp),
  };
}

function abortCommand(parsed, deps) {
  const plan = deps.loadRunPlan(deps.paths.stateRoot, parsed.runId);
  const state = deps.readState(deps.paths.statePath);
  let result;
  try {
    result = deps.abortRun(deps.root, parsed.runId, deps.orchestratorOptions);
  } catch (error) {
    const status = statusAfterFailure(deps, parsed.runId);
    if (status?.state === 'applied') {
      const applied = deps.transitionBatchState(state, plan, APPLY_STATUS.APPLIED, {
        at: clockValue(deps.clock).toISOString(),
      });
      if (applied !== state) deps.writeState(deps.paths.statePath, applied);
    }
    throw error;
  }
  if (manifestState(result) === 'applied') {
    const applied = deps.transitionBatchState(state, plan, APPLY_STATUS.APPLIED, {
      at: clockValue(deps.clock).toISOString(),
    });
    if (applied !== state) deps.writeState(deps.paths.statePath, applied);
    throw new Error('an applied import cannot be aborted');
  }
  requireCompletedRun('abort', result, 'aborted');
  const failed = deps.transitionBatchState(state, plan, APPLY_STATUS.FAILED, {
    at: clockValue(deps.clock).toISOString(),
    reason: 'aborted',
  });
  deps.writeState(deps.paths.statePath, failed);
  return {
    mode: 'abort',
    runId: parsed.runId,
    batchId: plan.batchId,
    state: result.state,
    noOp: Boolean(result.noOp),
  };
}

function statusCommand(parsed, deps) {
  const result = deps.runStatus(deps.root, parsed.runId, deps.orchestratorOptions);
  return { mode: 'status', runId: parsed.runId, manifest: result };
}

export async function executeImportCommand(parsed, overrides = {}) {
  const deps = productionDependencies(overrides);
  if (parsed.mode === 'verify') return verifyCommand(parsed, deps);
  if (parsed.mode === 'apply') return applyCommand(parsed, deps);
  if (parsed.mode === 'resume') return resumeCommand(parsed, deps);
  if (parsed.mode === 'abort') return abortCommand(parsed, deps);
  if (parsed.mode === 'status') return statusCommand(parsed, deps);
  throw new Error(`unsupported import mode: ${parsed.mode}`);
}

export async function runImportCli(args, overrides = {}) {
  const parsed = parseImportArgs(args);
  const result = await executeImportCommand(parsed, overrides);
  const envelope = { ok: true, ...result };
  const write = overrides.stdout ?? ((text) => process.stdout.write(text));
  write(`${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

async function main() {
  try {
    await runImportCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: {
        name: error.name,
        code: error.code ?? null,
        message: error.message,
      },
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
