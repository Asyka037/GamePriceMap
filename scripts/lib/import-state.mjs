import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  candidateIdFor,
  evidenceDigestFor,
  humanDecisionDigestFor,
  normalizeHumanDecision,
} from './library-workbook.mjs';

export const IMPORT_STATE_SCHEMA_VERSION = 1;
export const VERIFY_STATUS = Object.freeze({
  PENDING: 'pending',
  PASSED: 'passed',
  EXCEPTION: 'exception',
});
export const APPLY_STATUS = Object.freeze({
  NOT_APPLIED: 'not_applied',
  STAGED: 'staged',
  APPLIED: 'applied',
  FAILED: 'failed',
});

const VERIFY_VALUES = new Set(Object.values(VERIFY_STATUS));
const APPLY_VALUES = new Set(Object.values(APPLY_STATUS));
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const STATE_KEYS = new Set(['schemaVersion', 'updatedAt', 'candidates']);
const RECORD_KEYS = new Set([
  'candidateId', 'evidenceDigest', 'humanDecisionDigest',
  'verifyStatus', 'applyStatus', 'verifiedAt', 'appliedAt',
  'verifyReason', 'applyReason', 'slug',
]);

export function createEmptyImportState() {
  return {
    schemaVersion: IMPORT_STATE_SCHEMA_VERSION,
    updatedAt: null,
    candidates: {},
  };
}

function validIso(value) {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

export function validateImportState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('state 必须是对象');
  const unknownStateKeys = Object.keys(state).filter((key) => !STATE_KEYS.has(key));
  if (unknownStateKeys.length > 0) throw new Error(`state 含未知字段: ${unknownStateKeys.join(', ')}`);
  if (state.schemaVersion !== IMPORT_STATE_SCHEMA_VERSION) {
    throw new Error(`state schemaVersion 不支持: ${state.schemaVersion}`);
  }
  if (!validIso(state.updatedAt ?? null)) throw new Error('state.updatedAt 必须是 ISO 时间或 null');
  if (!state.candidates || typeof state.candidates !== 'object' || Array.isArray(state.candidates)) {
    throw new Error('state.candidates 必须是对象');
  }

  for (const [key, record] of Object.entries(state.candidates)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`state candidate 无效: ${key}`);
    if ('humanDecision' in record || 'sourceHumanDecision' in record) {
      throw new Error(`机器 state 禁止存储 humanDecision: ${key}`);
    }
    const unknownRecordKeys = Object.keys(record).filter((field) => !RECORD_KEYS.has(field));
    if (unknownRecordKeys.length > 0) throw new Error(`state candidate 含未知字段 ${key}: ${unknownRecordKeys.join(', ')}`);
    if (record.candidateId !== key || candidateIdFor(record) !== key) throw new Error(`state candidateId/key 不一致: ${key}`);
    if (!DIGEST_RE.test(record.evidenceDigest ?? '')) throw new Error(`state evidenceDigest 无效: ${key}`);
    if (!DIGEST_RE.test(record.humanDecisionDigest ?? '')) throw new Error(`state humanDecisionDigest 无效: ${key}`);
    if (!VERIFY_VALUES.has(record.verifyStatus)) throw new Error(`state verifyStatus 无效: ${key}`);
    if (!APPLY_VALUES.has(record.applyStatus)) throw new Error(`state applyStatus 无效: ${key}`);
    if (!validIso(record.verifiedAt ?? null)) throw new Error(`state verifiedAt 无效: ${key}`);
    if (!validIso(record.appliedAt ?? null)) throw new Error(`state appliedAt 无效: ${key}`);
    if (record.applyStatus === APPLY_STATUS.APPLIED && record.verifyStatus !== VERIFY_STATUS.PASSED) {
      throw new Error(`已应用候选必须先核验通过: ${key}`);
    }
  }
  return state;
}

export function readImportState(filePath) {
  try {
    return validateImportState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptyImportState();
    throw error;
  }
}

function machineDefaults() {
  return {
    verifyStatus: VERIFY_STATUS.PENDING,
    applyStatus: APPLY_STATUS.NOT_APPLIED,
    verifiedAt: null,
    appliedAt: null,
    verifyReason: null,
    applyReason: null,
    slug: null,
  };
}

export function joinCandidatesWithState(candidates, state = createEmptyImportState()) {
  validateImportState(state);
  if (!Array.isArray(candidates)) throw new TypeError('candidates 必须是数组');
  const seen = new Set();

  return candidates.map((source) => {
    const candidateId = candidateIdFor(source);
    if (seen.has(candidateId)) throw new Error(`candidateId 重复: ${candidateId}`);
    seen.add(candidateId);
    const evidenceDigest = evidenceDigestFor({ ...source, candidateId });
    const sourceHumanDecision = normalizeHumanDecision(source.sourceHumanDecision ?? source.humanDecision ?? '待定');
    const record = state.candidates[candidateId] ?? null;
    const evidenceChanged = Boolean(record && record.evidenceDigest !== evidenceDigest);
    const workbookEvidenceStale = Boolean(source.workbookEvidenceStale);
    const approvalStale = sourceHumanDecision === '批准' && (evidenceChanged || workbookEvidenceStale);
    const humanDecision = approvalStale ? '待定' : sourceHumanDecision;
    const humanDecisionDigest = humanDecisionDigestFor({ candidateId, evidenceDigest, humanDecision });
    const decisionChanged = Boolean(record && !evidenceChanged && record.humanDecisionDigest !== humanDecisionDigest);
    const machineStateValid = Boolean(record && !evidenceChanged && !decisionChanged && !workbookEvidenceStale);
    const machine = machineStateValid ? record : machineDefaults();
    if (!machineStateValid && record?.applyStatus === APPLY_STATUS.APPLIED) {
      machine.applyStatus = APPLY_STATUS.APPLIED;
      machine.appliedAt = record.appliedAt ?? null;
      machine.applyReason = record.applyReason ?? null;
      machine.slug = record.slug ?? null;
    }

    return {
      ...source,
      candidateId,
      // Once verification freezes a slug, later source regeneration cannot
      // silently rename the catalog key. Evidence/decision changes reset the
      // machine status, but the stable local identifier remains reserved.
      slug: record?.slug ?? source.slug ?? null,
      evidenceDigest,
      sourceHumanDecision,
      humanDecision,
      humanDecisionDigest,
      verifyStatus: machine.verifyStatus,
      applyStatus: machine.applyStatus,
      verifiedAt: machine.verifiedAt ?? null,
      appliedAt: machine.appliedAt ?? null,
      verifyReason: machine.verifyReason ?? null,
      applyReason: machine.applyReason ?? null,
      approvalStale,
      evidenceChanged,
      decisionChanged,
      machineStateValid,
      stateEvidenceDigest: record?.evidenceDigest ?? null,
      stateHumanDecisionDigest: record?.humanDecisionDigest ?? null,
    };
  });
}

function clonedState(state) {
  validateImportState(state);
  return structuredClone(state);
}

function assertJoinedCandidate(candidate) {
  const candidateId = candidateIdFor(candidate);
  const evidenceDigest = evidenceDigestFor({ ...candidate, candidateId });
  const humanDecision = normalizeHumanDecision(candidate.humanDecision);
  const humanDecisionDigest = humanDecisionDigestFor({ candidateId, evidenceDigest, humanDecision });
  if (candidate.humanDecisionDigest && candidate.humanDecisionDigest !== humanDecisionDigest) {
    throw new Error(`humanDecisionDigest 与当前决定不一致: ${candidateId}`);
  }
  return { candidateId, evidenceDigest, humanDecision, humanDecisionDigest };
}

function baseRecord(candidate) {
  const identity = assertJoinedCandidate(candidate);
  return {
    candidateId: identity.candidateId,
    evidenceDigest: identity.evidenceDigest,
    humanDecisionDigest: identity.humanDecisionDigest,
    ...machineDefaults(),
    slug: candidate.slug ?? null,
  };
}

function isoNow(value) {
  const text = value ?? new Date().toISOString();
  if (!validIso(text) || text === null) throw new Error(`无效 ISO 时间: ${text}`);
  return text;
}

export function transitionVerify(state, candidate, verifyStatus, { reason = null, at } = {}) {
  if (![VERIFY_STATUS.PASSED, VERIFY_STATUS.EXCEPTION].includes(verifyStatus)) {
    throw new Error(`非法 verify 目标状态: ${verifyStatus}`);
  }
  const identity = assertJoinedCandidate(candidate);
  if (identity.humanDecision !== '批准') throw new Error(`未经人工批准，不得机器核验: ${identity.candidateId}`);
  if (candidate.approvalStale) throw new Error(`旧批准已因证据变化失效: ${identity.candidateId}`);

  const next = clonedState(state);
  const previous = next.candidates[identity.candidateId];
  if (previous?.applyStatus === APPLY_STATUS.APPLIED && verifyStatus !== VERIFY_STATUS.PASSED) {
    throw new Error(`已应用候选不能直接改为核验异常: ${identity.candidateId}`);
  }
  const record = previous
    && previous.evidenceDigest === identity.evidenceDigest
    && previous.humanDecisionDigest === identity.humanDecisionDigest
    ? { ...previous }
    : baseRecord(candidate);
  const timestamp = isoNow(at);
  record.verifyStatus = verifyStatus;
  record.verifiedAt = timestamp;
  record.verifyReason = reason === null ? null : String(reason);
  if (verifyStatus === VERIFY_STATUS.EXCEPTION) {
    record.applyStatus = APPLY_STATUS.NOT_APPLIED;
    record.appliedAt = null;
    record.applyReason = null;
  }
  next.candidates[identity.candidateId] = record;
  next.updatedAt = timestamp;
  return validateImportState(next);
}

export function transitionApply(state, candidate, applyStatus, { reason = null, at } = {}) {
  if (![APPLY_STATUS.STAGED, APPLY_STATUS.APPLIED, APPLY_STATUS.FAILED].includes(applyStatus)) {
    throw new Error(`非法 apply 目标状态: ${applyStatus}`);
  }
  const identity = assertJoinedCandidate(candidate);
  if (identity.humanDecision !== '批准') throw new Error(`未经人工批准，不得应用: ${identity.candidateId}`);
  const next = clonedState(state);
  const previous = next.candidates[identity.candidateId];
  if (!previous
    || previous.evidenceDigest !== identity.evidenceDigest
    || previous.humanDecisionDigest !== identity.humanDecisionDigest
    || previous.verifyStatus !== VERIFY_STATUS.PASSED) {
    throw new Error(`候选未在当前证据/批准下核验通过: ${identity.candidateId}`);
  }
  if (previous.applyStatus === APPLY_STATUS.APPLIED && applyStatus === APPLY_STATUS.APPLIED) {
    return state;
  }

  const allowed = {
    [APPLY_STATUS.NOT_APPLIED]: new Set([APPLY_STATUS.STAGED, APPLY_STATUS.FAILED]),
    [APPLY_STATUS.STAGED]: new Set([APPLY_STATUS.APPLIED, APPLY_STATUS.FAILED]),
    [APPLY_STATUS.FAILED]: new Set([APPLY_STATUS.STAGED, APPLY_STATUS.FAILED]),
    [APPLY_STATUS.APPLIED]: new Set([APPLY_STATUS.APPLIED]),
  };
  if (!allowed[previous.applyStatus]?.has(applyStatus)) {
    throw new Error(`非法 apply 状态转移: ${previous.applyStatus} -> ${applyStatus}`);
  }
  const timestamp = isoNow(at);
  const record = { ...previous, applyStatus, applyReason: reason === null ? null : String(reason) };
  if (applyStatus === APPLY_STATUS.APPLIED) record.appliedAt = timestamp;
  next.candidates[identity.candidateId] = record;
  next.updatedAt = timestamp;
  return validateImportState(next);
}

export function eligibleForBatch(candidate, { now = Date.now(), maxVerifiedAgeMs = null } = {}) {
  try {
    if (normalizeHumanDecision(candidate?.humanDecision) !== '批准') return false;
    if (candidate?.approvalStale || candidate?.workbookEvidenceStale || !candidate?.machineStateValid) return false;
    if (candidate?.verifyStatus !== VERIFY_STATUS.PASSED) return false;
    // A failed/aborted staging attempt did not alter the formal catalog and
    // may be retried after its cause is corrected. `staged` is reserved for
    // resume, while `applied` is terminal.
    if (![APPLY_STATUS.NOT_APPLIED, APPLY_STATUS.FAILED].includes(candidate?.applyStatus)) return false;
    const verifiedAt = Date.parse(candidate?.verifiedAt ?? '');
    if (!Number.isFinite(verifiedAt)) return false;
    if (maxVerifiedAgeMs !== null) {
      if (!(Number.isFinite(maxVerifiedAgeMs) && maxVerifiedAgeMs >= 0)) return false;
      const nowMs = now instanceof Date ? now.getTime() : Number(now);
      if (!Number.isFinite(nowMs) || nowMs - verifiedAt > maxVerifiedAgeMs) return false;
    }
    const identity = assertJoinedCandidate(candidate);
    return identity.humanDecisionDigest === candidate.humanDecisionDigest;
  } catch {
    return false;
  }
}

function projectedNsuids(candidate) {
  const values = {
    americas: candidate?.nsuids?.americas ?? candidate?.nsuidAm ?? candidate?.nsuidAM ?? null,
    europe: candidate?.nsuids?.europe ?? candidate?.nsuidEu ?? candidate?.nsuidEU ?? null,
    japan: candidate?.nsuids?.japan ?? candidate?.nsuidJp ?? candidate?.nsuidJP ?? null,
  };
  const present = Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([group, value]) => [group, String(value).trim()]);
  return present.length > 0 ? Object.fromEntries(present) : null;
}

export function projectBatchItem(candidate) {
  if (!eligibleForBatch(candidate)) throw new Error(`候选不符合批次进入条件: ${candidate?.candidateId ?? '<unknown>'}`);
  const candidateId = candidateIdFor(candidate);
  const steamText = candidate?.steamAppId === null || candidate?.steamAppId === undefined
    ? ''
    : String(candidate.steamAppId).trim();
  const steamAppId = steamText ? Number(steamText) : null;
  if (steamText && !(Number.isSafeInteger(steamAppId) && steamAppId > 0)) {
    throw new Error(`Steam AppID 无法投影为安全整数: ${steamText}`);
  }
  if (!(typeof candidate.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate.slug))) {
    throw new Error(`批次候选缺少已冻结 slug: ${candidateId}`);
  }
  if (!(typeof candidate.title === 'string' && candidate.title.trim())) throw new Error(`批次候选缺少 title: ${candidateId}`);
  if (!Array.isArray(candidate.platforms) || candidate.platforms.length === 0) {
    throw new Error(`批次候选缺少 platforms: ${candidateId}`);
  }
  const nsuids = projectedNsuids(candidate);
  if (!steamAppId && !nsuids) throw new Error(`批次候选缺少平台商品 ID: ${candidateId}`);
  const item = {
    key: candidateId,
    catalogAction: candidate.catalogAction ?? 'new_game',
    slug: candidate.slug,
    title: candidate.title.trim(),
    platforms: [...candidate.platforms],
    steamAppId,
    nsuids,
    evidenceDigest: candidate.evidenceDigest,
    humanDecisionDigest: candidate.humanDecisionDigest,
    verifiedAt: candidate.verifiedAt,
  };
  if (candidate.nintendoUsSlug) item.nintendoUsSlug = candidate.nintendoUsSlug;
  if (candidate.primaryRegionalChannel) item.primaryRegionalChannel = candidate.primaryRegionalChannel;
  return item;
}

export function projectEligibleBatch(candidates, { limit = 25, ...eligibilityOptions } = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates 必须是数组');
  if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) throw new Error('limit 必须是 1..100 整数');
  const seen = new Set();
  const items = [];
  for (const candidate of candidates) {
    if (!eligibleForBatch(candidate, eligibilityOptions)) continue;
    const item = projectBatchItem(candidate);
    if (seen.has(item.key)) throw new Error(`批次 candidateId 重复: ${item.key}`);
    seen.add(item.key);
    items.push(item);
    if (items.length === limit) break;
  }
  return items;
}

function writeTempFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    return tempPath;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

export function atomicWriteFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('没有待写入文件');
  const destinations = new Set();
  const staged = [];
  try {
    for (const file of files) {
      const destination = path.resolve(file.path);
      if (destinations.has(destination)) throw new Error(`重复输出路径: ${destination}`);
      destinations.add(destination);
      staged.push({ destination, tempPath: writeTempFile(destination, String(file.content)) });
    }
    for (const file of staged) fs.renameSync(file.tempPath, file.destination);
    for (const directory of new Set(staged.map((file) => path.dirname(file.destination)))) {
      let fd;
      try {
        fd = fs.openSync(directory, 'r');
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
  } catch (error) {
    for (const file of staged) {
      try { fs.unlinkSync(file.tempPath); } catch {}
    }
    throw error;
  }
}

export function atomicWriteJson(filePath, value) {
  atomicWriteFiles([{ path: filePath, content: `${JSON.stringify(value, null, 2)}\n` }]);
}

export function writeImportState(filePath, state) {
  validateImportState(state);
  atomicWriteJson(filePath, state);
}
