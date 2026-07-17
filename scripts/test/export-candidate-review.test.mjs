import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReviewRows,
  csvCell,
  rowsToCsv,
} from '../export-candidate-review.mjs';

test('CSV 正确转义逗号、引号、换行，并防止表格公式注入', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('a\nb'), '"a\nb"');
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  const csv = rowsToCsv(['name', 'note'], [{ name: '游戏', note: 'x,y' }]);
  assert.ok(csv.startsWith('\uFEFFname,note\r\n'));
  assert.ok(csv.endsWith('游戏,"x,y"\r\n'));
});

test('review CSV 只显示 join 后的有效人工决定，旧证据批准标为待定', () => {
  const [row] = buildReviewRows([{
    candidateId: 'steam:42',
    title: 'Example',
    steamAppId: '42',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    humanDecision: '待定',
    verifyStatus: 'pending',
    applyStatus: 'not_applied',
    approvalStale: true,
  }]);
  assert.equal(row.humanDecision, '待定');
  assert.equal(row.verifyStatus, '待核验');
  assert.match(row['异常原因'], /重新人工批准/u);
});
