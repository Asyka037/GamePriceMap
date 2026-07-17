import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateIdFor,
  evidenceDigestFor,
  mergeCandidatesWithWorkbook,
  parseDecisionSheets,
  parseLibraryGrid,
} from '../lib/library-workbook.mjs';

const BASE_HEADERS = [
  'GamePriceMap ID', '游戏名(EN)', '游戏名(CN)', '状态', '端', '主区域价源',
  'Steam AppID', 'NSUID AM', 'NSUID EU', 'NSUID JP', 'Xbox BigID', '来源排名',
  '备注 / 异常说明', '加入日期', '来源链接', 'Steam映射', 'NS映射', 'Xbox映射',
];

function grid(headers = BASE_HEADERS, data = []) {
  return [['title'], ['note'], ['summary'], headers, ...data];
}

test('识别游戏库第 4 行现有中文表头，旧状态只作兼容人工决定', () => {
  const parsed = parseLibraryGrid(grid(BASE_HEADERS, [[
    'elden-ring', 'Elden Ring', '艾尔登法环', '已上线', 'PC / Xbox', 'Steam',
    1245620, '', '', '', 'BIG', '既有 catalog', '', '2026-07-08', 'https://example.test', '是', '否', '是',
  ]]));
  assert.equal(parsed.headerRow, 4);
  assert.equal(parsed.explicitHumanDecision, false);
  assert.equal(parsed.rows[0].candidateId, 'steam:1245620');
  assert.equal(parsed.rows[0].steamAppId, '1245620');
  assert.equal(parsed.rows[0].humanDecision, '批准');
  assert.deepEqual(parsed.rows[0].platforms, ['PC', 'Xbox']);
});

test('显式 humanDecision 列优先于生命周期状态，空值 fail closed', () => {
  const headers = [...BASE_HEADERS, 'humanDecision'];
  const parsed = parseLibraryGrid(grid(headers, [[
    'example', 'Example', '', '已上线', 'Switch', 'eShop', '', '70010000000001', '', '', '', '', '', '', '', '', '', '', '',
  ]]));
  assert.equal(parsed.explicitHumanDecision, true);
  assert.equal(parsed.rows[0].humanDecision, '待定');
  assert.equal(parsed.rows[0].humanDecisionSource, 'humanDecision');
  assert.equal(parsed.rows[0].candidateId, 'ns:70010000000001');
});

test('candidateId 优先使用已冻结显式值，其次 Steam，NS 按 AM -> EU -> JP', () => {
  assert.equal(candidateIdFor({ candidateId: 'ns:70010000000099', nsuidAm: '70010000000001', nsuidEu: '70010000000099' }), 'ns:70010000000099');
  assert.equal(candidateIdFor({ steamAppId: 123, nsuidAm: '70010000000001' }), 'steam:123');
  assert.equal(candidateIdFor({ nsuidEu: '70010000000002', nsuidJp: '70010000000003' }), 'ns:70010000000002');
  assert.throws(() => candidateIdFor({ candidateId: 'steam:42', steamAppId: 43 }), /不一致/u);
  assert.throws(() => candidateIdFor({ candidateId: 'ns:70010000000001', nsuidAm: '70010000000002' }), /不一致/u);
});

test('机器候选字段为事实源，workbook 只 join 人工决定', () => {
  const machine = [{
    candidateId: 'steam:42',
    steamAppId: '42',
    title: 'Machine title',
    evidence: { type: 'game', paid: true },
  }];
  const digest = evidenceDigestFor(machine[0]);
  const workbook = [{
    candidateId: 'steam:42',
    title: 'User edited title',
    sourceHumanDecision: '批准',
    reviewedEvidenceDigest: digest,
    workbookRowNumber: 7,
    humanDecisionSource: 'humanDecision',
  }];
  const [joined] = mergeCandidatesWithWorkbook(machine, workbook);
  assert.equal(joined.title, 'Machine title');
  assert.equal(joined.humanDecision, '批准');
  assert.equal(joined.workbookRowNumber, 7);

  const [stale] = mergeCandidatesWithWorkbook([{ ...machine[0], evidence: { type: 'dlc', paid: true } }], workbook);
  assert.equal(stale.humanDecision, '待定');
  assert.equal(stale.workbookEvidenceStale, true);
});

test('新候选不能用游戏库生命周期“状态”冒充 humanDecision', () => {
  const machine = [{ steamAppId: 42, title: 'Example', evidence: { paid: true } }];
  const legacyRow = [{
    candidateId: 'steam:42',
    steamAppId: '42',
    sourceHumanDecision: '批准',
    humanDecisionSource: '状态',
    lifecycleStatus: '已上线',
  }];
  const [joined] = mergeCandidatesWithWorkbook(machine, legacyRow);
  assert.equal(joined.humanDecision, '待定');
  assert.equal(joined.humanDecisionSource, null);
});

test('扫描其它 sheet 前若干行的显式决策表，改一格后下轮 join 立即读到', () => {
  const machine = [{
    candidateId: 'steam:42',
    steamAppId: '42',
    title: 'Machine title',
    evidence: { type: 'game', paid: true },
  }];
  const digest = evidenceDigestFor(machine[0]);
  const fixture = (decision) => ({
    '总览': [['不相关内容']],
    '候选审核-001': [
      ['GamePriceMap 候选审核'],
      ['请只修改 humanDecision'],
      ['candidateId', '游戏名(EN)', 'Steam AppID', 'evidenceDigest', 'humanDecision'],
      ['steam:42', 'Machine title', '42', digest, decision],
    ],
  });
  const pendingDecisions = parseDecisionSheets(fixture('待定'));
  const approvedDecisions = parseDecisionSheets(fixture('批准'));
  assert.equal(pendingDecisions.sheets[0].headerRow, 3);
  assert.equal(mergeCandidatesWithWorkbook(machine, [], pendingDecisions.rows)[0].humanDecision, '待定');
  const approved = mergeCandidatesWithWorkbook(machine, [], approvedDecisions.rows)[0];
  assert.equal(approved.humanDecision, '批准');
  assert.equal(approved.evidenceDigest, digest);
  assert.equal(approved.decisionSheetName, '候选审核-001');
});

test('显式决策 sheet 的重复 candidateId 与证据变更都 fail closed', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const duplicate = {
    A: [['candidateId', 'evidenceDigest', 'humanDecision'], ['steam:42', digest, '批准']],
    B: [['candidateId', 'evidenceDigest', 'humanDecision'], ['steam:42', digest, '待定']],
  };
  assert.throws(() => parseDecisionSheets(duplicate), /重复/u);

  const machine = [{ steamAppId: 42, title: 'Changed', evidence: { paid: false } }];
  const decisions = parseDecisionSheets({
    review: [['candidateId', 'evidenceDigest', 'humanDecision'], ['steam:42', digest, '批准']],
  });
  const [joined] = mergeCandidatesWithWorkbook(machine, [], decisions.rows);
  assert.equal(joined.humanDecision, '待定');
  assert.equal(joined.workbookEvidenceStale, true);
});
