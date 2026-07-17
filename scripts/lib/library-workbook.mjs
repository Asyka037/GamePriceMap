import crypto from 'node:crypto';
import fs from 'node:fs';
import * as XLSX from 'xlsx';

export const LIBRARY_SHEET_NAME = '游戏库';
export const LIBRARY_HEADER_ROW = 4;
export const HUMAN_DECISIONS = Object.freeze(['待定', '批准', '淘汰']);

const HEADER_ALIASES = Object.freeze({
  slug: ['GamePriceMap ID', 'slug'],
  title: ['游戏名(EN)', '游戏名（EN）', 'title'],
  titleCn: ['游戏名(CN)', '游戏名（CN）', 'titleCn'],
  lifecycleStatus: ['状态', 'lifecycleStatus'],
  platformsText: ['端', '平台', 'platforms'],
  primaryPriceSource: ['主区域价源', 'primaryPriceSource'],
  steamAppId: ['Steam AppID', 'steamAppId'],
  nsuidAm: ['NSUID AM', 'nsuidAM', 'nsuidAm'],
  nsuidEu: ['NSUID EU', 'nsuidEU', 'nsuidEu'],
  nsuidJp: ['NSUID JP', 'nsuidJP', 'nsuidJp'],
  xboxBigId: ['Xbox BigID', 'xboxBigId'],
  sourceRank: ['来源排名', 'sourceRank'],
  notes: ['备注 / 异常说明', '备注/异常说明', 'notes'],
  addedAt: ['加入日期', 'addedAt'],
  sourceUrl: ['来源链接', 'sourceUrl'],
  steamMapped: ['Steam映射'],
  nsMapped: ['NS映射'],
  xboxMapped: ['Xbox映射'],
  humanDecision: ['humanDecision', '人工决定', '人工决策', '审批决定'],
  candidateId: ['candidateId', '候选 ID'],
  reviewedEvidenceDigest: ['evidenceDigest', '证据摘要'],
});

const APPROVED_VALUES = new Set(['批准', '已批准', '可上线', '已上线', 'approved']);
const REJECTED_VALUES = new Set(['淘汰', '已淘汰', '忽略', '已忽略', '拒绝', '已拒绝', 'rejected']);
const PENDING_VALUES = new Set(['', '待定', '待审', '待审核', '待批准', '未决定', 'pending']);
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const CANDIDATE_ID_RE = /^(?:steam:[1-9]\d*|ns:\d{10,16})$/;

function stringCell(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizedHeader(value) {
  return stringCell(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function aliasIndex(row) {
  const byHeader = new Map();
  row.forEach((value, index) => {
    const key = normalizedHeader(value);
    if (key && !byHeader.has(key)) byHeader.set(key, index);
  });

  const indexes = {};
  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      const index = byHeader.get(normalizedHeader(alias));
      if (index !== undefined) {
        indexes[field] = index;
        break;
      }
    }
  }
  return indexes;
}

function gridForSheet(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  });
}

function normalizeExternalId(value, { label, pattern }) {
  const text = stringCell(value).replace(/\.0$/u, '');
  if (!text) return null;
  if (!pattern.test(text)) throw new Error(`${label} 格式无效: ${text}`);
  return text;
}

export function normalizeHumanDecision(value) {
  const text = stringCell(value);
  const normalized = text.toLowerCase();
  if (APPROVED_VALUES.has(text) || APPROVED_VALUES.has(normalized)) return '批准';
  if (REJECTED_VALUES.has(text) || REJECTED_VALUES.has(normalized)) return '淘汰';
  if (PENDING_VALUES.has(text) || PENDING_VALUES.has(normalized)) return '待定';
  throw new Error(`humanDecision 值无效: ${text}`);
}

export function canonicalJson(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const fields = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${fields.join(',')}}`;
}

export function sha256Digest(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function validateCandidateId(value) {
  const candidateId = stringCell(value).toLowerCase();
  if (!CANDIDATE_ID_RE.test(candidateId)) throw new Error(`candidateId 格式无效: ${value}`);
  return candidateId;
}

/**
 * A candidate ID is frozen as soon as it is first exported. Callers must pass
 * that explicit ID back on later runs. The fallback order avoids changing an
 * NS-only candidate merely because EU/JP mappings are discovered later.
 */
export function candidateIdFor(candidate) {
  if (stringCell(candidate?.candidateId)) {
    const candidateId = validateCandidateId(candidate.candidateId);
    const steamAppId = normalizeExternalId(candidate?.steamAppId, { label: 'Steam AppID', pattern: /^[1-9]\d*$/ });
    if (candidateId.startsWith('steam:') && steamAppId && candidateId !== `steam:${steamAppId}`) {
      throw new Error(`candidateId 与 Steam AppID 不一致: ${candidateId} / ${steamAppId}`);
    }
    const nsuids = [candidate?.nsuidAm, candidate?.nsuidAM, candidate?.nsuidEu, candidate?.nsuidEU, candidate?.nsuidJp, candidate?.nsuidJP]
      .map((value) => normalizeExternalId(value, { label: 'NSUID', pattern: /^\d{10,16}$/ }))
      .filter(Boolean);
    if (candidateId.startsWith('ns:') && nsuids.length > 0 && !nsuids.includes(candidateId.slice(3))) {
      throw new Error(`candidateId 与 NSUID 不一致: ${candidateId}`);
    }
    return candidateId;
  }

  const steamAppId = normalizeExternalId(candidate?.steamAppId, {
    label: 'Steam AppID',
    pattern: /^[1-9]\d*$/,
  });
  if (steamAppId) return `steam:${steamAppId}`;

  const nsuid = [candidate?.nsuidAm, candidate?.nsuidAM, candidate?.nsuidEu, candidate?.nsuidEU, candidate?.nsuidJp, candidate?.nsuidJP]
    .map((value) => normalizeExternalId(value, { label: 'NSUID', pattern: /^\d{10,16}$/ }))
    .find(Boolean);
  if (nsuid) return `ns:${nsuid}`;

  throw new Error(`候选项缺少可用的 Steam AppID/NSUID: ${stringCell(candidate?.title) || '<untitled>'}`);
}

export function evidenceDigestFor(candidate) {
  const supplied = stringCell(candidate?.evidenceDigest);
  if (supplied) {
    if (!DIGEST_RE.test(supplied)) throw new Error(`evidenceDigest 格式无效: ${supplied}`);
    return supplied;
  }

  return sha256Digest({
    candidateId: candidateIdFor(candidate),
    title: stringCell(candidate?.title ?? candidate?.name),
    steamAppId: normalizeExternalId(candidate?.steamAppId, { label: 'Steam AppID', pattern: /^[1-9]\d*$/ }),
    nsuids: {
      am: normalizeExternalId(candidate?.nsuidAm ?? candidate?.nsuidAM, { label: 'NSUID AM', pattern: /^\d{10,16}$/ }),
      eu: normalizeExternalId(candidate?.nsuidEu ?? candidate?.nsuidEU, { label: 'NSUID EU', pattern: /^\d{10,16}$/ }),
      jp: normalizeExternalId(candidate?.nsuidJp ?? candidate?.nsuidJP, { label: 'NSUID JP', pattern: /^\d{10,16}$/ }),
    },
    xboxBigId: stringCell(candidate?.xboxBigId) || null,
    sourceRank: candidate?.sourceRank ?? null,
    sourceUrl: stringCell(candidate?.sourceUrl) || null,
    sources: candidate?.sources ?? null,
    evidence: candidate?.evidence ?? null,
  });
}

export function humanDecisionDigestFor({ candidateId, evidenceDigest, humanDecision }) {
  return sha256Digest({
    candidateId: validateCandidateId(candidateId),
    evidenceDigest: evidenceDigestFor({ candidateId, evidenceDigest }),
    humanDecision: normalizeHumanDecision(humanDecision),
  });
}

function parsePlatforms(text) {
  return stringCell(text)
    .split(/\s*\/\s*|\s*,\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseLibraryGrid(grid, { sheetName = LIBRARY_SHEET_NAME, headerRow = LIBRARY_HEADER_ROW } = {}) {
  if (!Array.isArray(grid)) throw new TypeError('工作表数据必须是二维数组');
  const header = grid[headerRow - 1];
  if (!Array.isArray(header)) throw new Error(`${sheetName} 缺少第 ${headerRow} 行表头`);
  const indexes = aliasIndex(header);
  for (const field of ['slug', 'title', 'lifecycleStatus', 'steamAppId', 'nsuidAm', 'nsuidEu', 'nsuidJp']) {
    if (indexes[field] === undefined) throw new Error(`${sheetName} 第 ${headerRow} 行缺少必需表头: ${HEADER_ALIASES[field][0]}`);
  }

  const explicitHumanDecision = indexes.humanDecision !== undefined;
  const valueAt = (row, field) => indexes[field] === undefined ? '' : row[indexes[field]];
  const rows = [];

  for (let index = headerRow; index < grid.length; index += 1) {
    const row = Array.isArray(grid[index]) ? grid[index] : [];
    if (row.every((cell) => stringCell(cell) === '')) continue;

    const steamAppId = normalizeExternalId(valueAt(row, 'steamAppId'), { label: 'Steam AppID', pattern: /^[1-9]\d*$/ });
    const nsuidAm = normalizeExternalId(valueAt(row, 'nsuidAm'), { label: 'NSUID AM', pattern: /^\d{10,16}$/ });
    const nsuidEu = normalizeExternalId(valueAt(row, 'nsuidEu'), { label: 'NSUID EU', pattern: /^\d{10,16}$/ });
    const nsuidJp = normalizeExternalId(valueAt(row, 'nsuidJp'), { label: 'NSUID JP', pattern: /^\d{10,16}$/ });
    const lifecycleStatus = stringCell(valueAt(row, 'lifecycleStatus'));
    const sourceHumanDecision = normalizeHumanDecision(
      explicitHumanDecision ? valueAt(row, 'humanDecision') : lifecycleStatus,
    );
    const candidate = {
      candidateId: stringCell(valueAt(row, 'candidateId')) || undefined,
      slug: stringCell(valueAt(row, 'slug')),
      title: stringCell(valueAt(row, 'title')),
      titleCn: stringCell(valueAt(row, 'titleCn')) || null,
      lifecycleStatus,
      platformsText: stringCell(valueAt(row, 'platformsText')),
      platforms: parsePlatforms(valueAt(row, 'platformsText')),
      primaryPriceSource: stringCell(valueAt(row, 'primaryPriceSource')) || null,
      steamAppId,
      nsuidAm,
      nsuidEu,
      nsuidJp,
      xboxBigId: stringCell(valueAt(row, 'xboxBigId')) || null,
      sourceRank: stringCell(valueAt(row, 'sourceRank')) || null,
      notes: stringCell(valueAt(row, 'notes')) || null,
      addedAt: stringCell(valueAt(row, 'addedAt')) || null,
      sourceUrl: stringCell(valueAt(row, 'sourceUrl')) || null,
      sourceHumanDecision,
      humanDecision: sourceHumanDecision,
      humanDecisionSource: explicitHumanDecision ? 'humanDecision' : '状态',
      workbookRowNumber: index + 1,
    };

    try {
      candidate.candidateId = candidateIdFor(candidate);
    } catch (error) {
      throw new Error(`${sheetName}!${index + 1}: ${error.message}`, { cause: error });
    }

    const reviewedEvidenceDigest = stringCell(valueAt(row, 'reviewedEvidenceDigest'));
    if (reviewedEvidenceDigest && !DIGEST_RE.test(reviewedEvidenceDigest)) {
      throw new Error(`${sheetName}!${index + 1}: evidenceDigest 格式无效`);
    }
    candidate.reviewedEvidenceDigest = reviewedEvidenceDigest || null;
    candidate.evidenceDigest = reviewedEvidenceDigest || evidenceDigestFor(candidate);
    rows.push(candidate);
  }

  return {
    sheetName,
    headerRow,
    explicitHumanDecision,
    rows,
  };
}

/**
 * Scan explicit review sheets without assuming a fixed sheet name or header
 * row. A review decision is only trustworthy when it is bound to both a
 * frozen candidateId and the exact evidenceDigest the user reviewed.
 */
export function parseDecisionSheets(sheetGrids, { maxHeaderRows = 20 } = {}) {
  const entries = sheetGrids instanceof Map ? [...sheetGrids.entries()] : Object.entries(sheetGrids ?? {});
  const rows = [];
  const sheets = [];
  const seen = new Map();

  for (const [sheetName, grid] of entries) {
    if (!Array.isArray(grid)) continue;
    let headerRowIndex = -1;
    let indexes = null;
    const searchLimit = Math.min(grid.length, maxHeaderRows);
    for (let index = 0; index < searchLimit; index += 1) {
      if (!Array.isArray(grid[index])) continue;
      const candidate = aliasIndex(grid[index]);
      if (candidate.candidateId !== undefined
        && candidate.humanDecision !== undefined
        && candidate.reviewedEvidenceDigest !== undefined) {
        headerRowIndex = index;
        indexes = candidate;
        break;
      }
    }
    if (headerRowIndex < 0) continue;

    const valueAt = (row, field) => indexes[field] === undefined ? '' : row[indexes[field]];
    let count = 0;
    for (let index = headerRowIndex + 1; index < grid.length; index += 1) {
      const row = Array.isArray(grid[index]) ? grid[index] : [];
      if (row.every((cell) => stringCell(cell) === '')) continue;
      const rawCandidateId = stringCell(valueAt(row, 'candidateId'));
      const rawEvidenceDigest = stringCell(valueAt(row, 'reviewedEvidenceDigest'));
      const rawDecision = valueAt(row, 'humanDecision');
      if (!rawCandidateId && !rawEvidenceDigest && stringCell(rawDecision) === '') continue;
      if (!rawCandidateId || !rawEvidenceDigest) {
        throw new Error(`${sheetName}!${index + 1}: 显式决策行缺少 candidateId/evidenceDigest`);
      }
      const decision = {
        candidateId: validateCandidateId(rawCandidateId),
        reviewedEvidenceDigest: rawEvidenceDigest,
        sourceHumanDecision: normalizeHumanDecision(rawDecision),
        humanDecision: normalizeHumanDecision(rawDecision),
        humanDecisionSource: 'decision-sheet',
        decisionSheetName: sheetName,
        workbookRowNumber: index + 1,
        title: stringCell(valueAt(row, 'title')) || null,
        steamAppId: normalizeExternalId(valueAt(row, 'steamAppId'), { label: 'Steam AppID', pattern: /^[1-9]\d*$/ }),
        nsuidAm: normalizeExternalId(valueAt(row, 'nsuidAm'), { label: 'NSUID AM', pattern: /^\d{10,16}$/ }),
        nsuidEu: normalizeExternalId(valueAt(row, 'nsuidEu'), { label: 'NSUID EU', pattern: /^\d{10,16}$/ }),
        nsuidJp: normalizeExternalId(valueAt(row, 'nsuidJp'), { label: 'NSUID JP', pattern: /^\d{10,16}$/ }),
      };
      if (!DIGEST_RE.test(decision.reviewedEvidenceDigest)) {
        throw new Error(`${sheetName}!${index + 1}: evidenceDigest 格式无效`);
      }
      // If optional IDs are present, they must agree with the frozen key.
      candidateIdFor(decision);
      const previous = seen.get(decision.candidateId);
      if (previous) {
        throw new Error(
          `显式决策 candidateId 重复: ${decision.candidateId} (${previous.decisionSheetName}!${previous.workbookRowNumber}, ${sheetName}!${index + 1})`,
        );
      }
      seen.set(decision.candidateId, decision);
      rows.push(decision);
      count += 1;
    }
    sheets.push({ sheetName, headerRow: headerRowIndex + 1, decisions: count });
  }
  return { rows, sheets };
}

/** Read-only by construction: bytes are read once and SheetJS receives a buffer. */
export function readLibraryWorkbook(filePath, { sheetName = LIBRARY_SHEET_NAME, headerRow = LIBRARY_HEADER_ROW } = {}) {
  const before = fs.statSync(filePath);
  const bytes = fs.readFileSync(filePath);
  const workbook = XLSX.read(bytes, {
    type: 'buffer',
    cellDates: false,
    cellFormula: true,
    cellStyles: false,
  });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`工作簿缺少工作表: ${sheetName}`);
  const sheetGrids = new Map(workbook.SheetNames.map((name) => [name, gridForSheet(workbook.Sheets[name])]));
  const grid = sheetGrids.get(sheetName);
  const parsed = parseLibraryGrid(grid, { sheetName, headerRow });
  const decisions = parseDecisionSheets(new Map([...sheetGrids].filter(([name]) => name !== sheetName)));
  const after = fs.statSync(filePath);
  if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) {
    throw new Error('主工作簿在只读期间发生变化，已拒绝使用读取结果');
  }

  return {
    ...parsed,
    decisionRows: decisions.rows,
    decisionSheets: decisions.sheets,
    workbook: {
      path: filePath,
      size: before.size,
      mtimeMs: before.mtimeMs,
      sha256: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
    },
  };
}

/**
 * Machine discovery fields remain authoritative. The workbook contributes
 * only the user's decision and row provenance; it cannot replace IDs/evidence.
 */
export function mergeCandidatesWithWorkbook(candidates, workbookRows, decisionRows = []) {
  if (!Array.isArray(candidates) || !Array.isArray(workbookRows) || !Array.isArray(decisionRows)) {
    throw new TypeError('candidates、workbookRows 与 decisionRows 必须是数组');
  }
  const workbookById = new Map();
  for (const row of workbookRows) {
    const candidateId = candidateIdFor(row);
    if (workbookById.has(candidateId)) throw new Error(`主工作簿 candidateId 重复: ${candidateId}`);
    workbookById.set(candidateId, row);
  }
  const decisionsById = new Map();
  const explicitRows = [
    ...workbookRows.filter((row) => row.humanDecisionSource === 'humanDecision' && row.reviewedEvidenceDigest),
    ...decisionRows,
  ];
  for (const row of explicitRows) {
    const candidateId = candidateIdFor(row);
    if (decisionsById.has(candidateId)) throw new Error(`显式决策 candidateId 重复: ${candidateId}`);
    decisionsById.set(candidateId, row);
  }

  const seen = new Set();
  return candidates.map((source) => {
    const candidateId = candidateIdFor(source);
    if (seen.has(candidateId)) throw new Error(`候选 candidateId 重复: ${candidateId}`);
    seen.add(candidateId);
    const evidenceDigest = evidenceDigestFor({ ...source, candidateId });
    const workbookRow = workbookById.get(candidateId);
    const decisionRow = decisionsById.get(candidateId);
    // Lifecycle "状态" is intentionally ignored here. A machine candidate is
    // pending until a user supplies an explicit, digest-bound decision row.
    const sourceHumanDecision = decisionRow?.sourceHumanDecision ?? decisionRow?.humanDecision ?? '待定';
    const reviewedDigest = decisionRow?.reviewedEvidenceDigest ?? null;
    const workbookEvidenceStale = Boolean(reviewedDigest && reviewedDigest !== evidenceDigest);
    return {
      ...source,
      candidateId,
      evidenceDigest,
      sourceHumanDecision: normalizeHumanDecision(sourceHumanDecision),
      humanDecision: workbookEvidenceStale ? '待定' : normalizeHumanDecision(sourceHumanDecision),
      workbookEvidenceStale,
      workbookRowNumber: decisionRow?.workbookRowNumber ?? workbookRow?.workbookRowNumber ?? null,
      humanDecisionSource: decisionRow?.humanDecisionSource ?? null,
      decisionSheetName: decisionRow?.decisionSheetName ?? null,
    };
  });
}
