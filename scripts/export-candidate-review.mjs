#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  evidenceDigestFor,
  mergeCandidatesWithWorkbook,
  readLibraryWorkbook,
} from './lib/library-workbook.mjs';
import {
  atomicWriteFiles,
  joinCandidatesWithState,
  readImportState,
} from './lib/import-state.mjs';
import { validateCandidateSourceDocument } from './lib/candidate-source.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WORKBOOK = path.join(ROOT, 'private', 'game-library', 'GamePriceMap-game-library.xlsx');
const DEFAULT_STATE = path.join(ROOT, 'private', 'game-library', 'import', 'state.json');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'private', 'game-library', 'import');

const VERIFY_LABELS = Object.freeze({ pending: '待核验', passed: '通过', exception: '异常' });
const APPLY_LABELS = Object.freeze({ not_applied: '未应用', staged: '已进入 staging', applied: '已应用', failed: '失败' });

function protectSpreadsheetFormula(value) {
  const text = String(value ?? '');
  return /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
}

export function csvCell(value) {
  const text = protectSpreadsheetFormula(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(headers, rows, { bom = true } = {}) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) throw new TypeError('headers/rows 必须是数组');
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row?.[header] ?? '')).join(','));
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}\r\n`;
}

export function buildVerifyReportRows(candidates) {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    title: candidate.title ?? candidate.name ?? '',
    humanDecision: candidate.humanDecision,
    humanDecisionDigest: candidate.humanDecisionDigest,
    verifyStatus: candidate.verifyStatus,
    verifyStatusLabel: VERIFY_LABELS[candidate.verifyStatus] ?? candidate.verifyStatus,
    verifyReason: candidate.verifyReason ?? '',
    applyStatus: candidate.applyStatus,
    applyStatusLabel: APPLY_LABELS[candidate.applyStatus] ?? candidate.applyStatus,
    verifiedAt: candidate.verifiedAt ?? '',
    appliedAt: candidate.appliedAt ?? '',
    evidenceDigest: candidate.evidenceDigest,
    approvalStale: candidate.approvalStale ? '是' : '否',
  }));
}

export function buildReviewRows(candidates) {
  return candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    '游戏名(EN)': candidate.title ?? candidate.name ?? '',
    'Steam AppID': candidate.steamAppId ?? '',
    'NSUID AM': candidate.nsuidAm ?? candidate.nsuidAM ?? '',
    'NSUID EU': candidate.nsuidEu ?? candidate.nsuidEU ?? '',
    'NSUID JP': candidate.nsuidJp ?? candidate.nsuidJP ?? '',
    '来源排名': candidate.sourceRank ?? '',
    '来源链接': candidate.sourceUrl ?? '',
    evidenceDigest: candidate.evidenceDigest,
    humanDecision: candidate.humanDecision,
    verifyStatus: VERIFY_LABELS[candidate.verifyStatus] ?? candidate.verifyStatus,
    applyStatus: APPLY_LABELS[candidate.applyStatus] ?? candidate.applyStatus,
    '异常原因': candidate.verifyReason ?? candidate.applyReason ?? (candidate.approvalStale ? '证据已变更，需重新人工批准' : ''),
  }));
}

function parseCandidateDocument(document) {
  return validateCandidateSourceDocument(document).candidates;
}

export function exportReviewArtifacts({
  workbookPath = DEFAULT_WORKBOOK,
  statePath = DEFAULT_STATE,
  outputDir = DEFAULT_OUTPUT_DIR,
  candidateSourcePath = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const library = readLibraryWorkbook(workbookPath);
  const state = readImportState(statePath);
  let candidates;
  if (candidateSourcePath) {
    const document = JSON.parse(fs.readFileSync(candidateSourcePath, 'utf8'));
    candidates = mergeCandidatesWithWorkbook(parseCandidateDocument(document), library.rows, library.decisionRows);
  } else {
    candidates = library.rows.map((candidate) => ({
      ...candidate,
      evidenceDigest: evidenceDigestFor(candidate),
    }));
  }
  const joined = joinCandidatesWithState(candidates, state);
  const verifyRows = buildVerifyReportRows(joined);
  const reviewRows = buildReviewRows(joined);
  const candidatesDocument = {
    schemaVersion: 1,
    generatedAt,
    workbook: {
      file: path.basename(workbookPath),
      size: library.workbook.size,
      mtimeMs: library.workbook.mtimeMs,
      sha256: library.workbook.sha256,
    },
    candidates: joined,
  };

  const verifyHeaders = [
    'candidateId', 'title', 'humanDecision', 'humanDecisionDigest',
    'verifyStatus', 'verifyStatusLabel', 'verifyReason', 'applyStatus',
    'applyStatusLabel', 'verifiedAt', 'appliedAt', 'evidenceDigest', 'approvalStale',
  ];
  const reviewHeaders = [
    'candidateId', '游戏名(EN)', 'Steam AppID', 'NSUID AM', 'NSUID EU', 'NSUID JP',
    '来源排名', '来源链接', 'evidenceDigest', 'humanDecision', 'verifyStatus',
    'applyStatus', '异常原因',
  ];
  const outputPaths = {
    candidates: path.join(outputDir, 'candidates.json'),
    verifyReport: path.join(outputDir, 'verify-report.csv'),
    review: path.join(outputDir, 'candidate-review.csv'),
  };
  const beforeWrite = fs.statSync(workbookPath);
  if (beforeWrite.mtimeMs !== library.workbook.mtimeMs || beforeWrite.size !== library.workbook.size) {
    throw new Error('导出前主工作簿已变更，已拒绝写入过期报告');
  }
  atomicWriteFiles([
    { path: outputPaths.candidates, content: `${JSON.stringify(candidatesDocument, null, 2)}\n` },
    { path: outputPaths.verifyReport, content: rowsToCsv(verifyHeaders, verifyRows) },
    { path: outputPaths.review, content: rowsToCsv(reviewHeaders, reviewRows) },
  ]);

  const after = fs.statSync(workbookPath);
  if (after.mtimeMs !== library.workbook.mtimeMs || after.size !== library.workbook.size) {
    throw new Error('导出期间主工作簿发生变化');
  }
  return { candidates: joined, outputPaths, workbook: candidatesDocument.workbook };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inline] = arg.split('=', 2);
    if (!['--workbook', '--state', '--out-dir', '--candidate-source'].includes(flag)) {
      throw new Error(`未知参数: ${arg}`);
    }
    const value = inline ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    if (flag === '--workbook') options.workbookPath = path.resolve(value);
    if (flag === '--state') options.statePath = path.resolve(value);
    if (flag === '--out-dir') options.outputDir = path.resolve(value);
    if (flag === '--candidate-source') options.candidateSourcePath = path.resolve(value);
  }
  return options;
}

function main() {
  const result = exportReviewArtifacts(parseArgs(process.argv.slice(2)));
  console.log(`candidates: ${result.candidates.length}`);
  console.log(`main workbook unchanged: ${result.workbook.sha256}`);
  console.log(`wrote ${result.outputPaths.candidates}`);
  console.log(`wrote ${result.outputPaths.verifyReport}`);
  console.log(`wrote ${result.outputPaths.review}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
