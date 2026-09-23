'use strict';

// 票 04：票集解析纯函数自检（接缝②——tracker 同步核心纯函数面，纯函数直喂风格）。
// 从 spec 引用与 tracker 的 issue 集合表示解析出一次 run 的票号集合，三层兜底：
//   ① spec issue 的原生 sub-issues → ② `## Parent` 边反查 → ③ init 票号清单。
// spec 母票不进任务票集合（封账门 Type: spec 豁免的产物口径，与票 02 转写一致）。
// 票号归一与账本共用同一转换点（normalizeTicket）；不碰网络、不碰文件系统。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSpecRef, parseParentEdge, resolveTicketSet } = require('./tracker-set-core.js');

// --- fixture：tracker 的 issue 集合表示（number / body / subIssues）---

const issue = (number, body = '', subIssues) => ({ number, body, subIssues });

// ====================================================================
// spec 引用解析（单一转换点）
// ====================================================================

test('spec 引用解析：issue 号 / #号 / owner/repo#号 / issue URL 四种形态同过一个转换点', () => {
  assert.equal(parseSpecRef('1234'), '1234');
  assert.equal(parseSpecRef('#1042'), '1042');
  assert.equal(parseSpecRef('o/r#205'), '205');
  assert.equal(parseSpecRef('https://github.com/o/r/issues/7'), '07', 'URL 里的 7 号同样补零归一');
  assert.equal(parseSpecRef('https://github.com/o/r/issues/1042?tab=reactions'), '1042');
  assert.equal(parseSpecRef('  #1042 '), '1042', '首尾空白容忍');
});

test('spec 引用解析：文件路径 / 散文 / 空值 / 超位数上限一律解析不出（返回 null）', () => {
  assert.equal(parseSpecRef('.scratch/demo/spec.md'), null, 'local 的 spec 引用是文件路径，不经票号解析');
  assert.equal(parseSpecRef('见 #1234567 说明'), null);
  assert.equal(parseSpecRef('#1234567'), null, '超过 6 位上限按非法形态拒绝');
  assert.equal(parseSpecRef(''), null);
  assert.equal(parseSpecRef(undefined), null);
});

// ====================================================================
// 三层解析：sub-issues → ## Parent 反查 → init 票号清单
// ====================================================================

test('三层解析：spec 有 sub-issues 时直接定界——Parent 边并存也不反查，spec 母票不进集合', () => {
  const issues = [
    issue(100, 'spec 正文', [102, 101, 102]),
    issue(101, '## Parent\n#100'),
    issue(102, '## Parent\n#100'),
    issue(103, '## Parent\n#100'), // 不在 sub-issues 里：层 1 定界后边界外的票不收
  ];
  const r = resolveTicketSet({ issues, specRef: '100', initTickets: ['05'] });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.source, 'sub-issues');
  assert.deepEqual(r.tickets, ['101', '102'], '去重 + 数值排序；层 1 为准，不与他层合并');
  assert.ok(!r.tickets.includes('100'), 'spec 母票不进任务票集合');
  assert.equal(r.specNum, '100');
});

test('三层解析：无 sub-issue 关系时按 ## Parent 边反查——#号 / URL 混用、他票 Parent 不入集', () => {
  const issues = [
    issue(100, 'spec 正文'),
    issue(1, '正文\n\n## Parent\n#100\n\n## Blocked by\n—'),
    issue(2, '## Parent\nhttps://github.com/o/r/issues/100'),
    issue(3, '## Parent\n#200'), // 父票是别的 spec
    issue(4, '无 Parent 边的散票'),
    issue(99, '## Parent\n#200'),
  ];
  const r = resolveTicketSet({ issues, specRef: '#100' });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.source, 'parent-edges');
  assert.deepEqual(r.tickets, ['01', '02']);
});

test('三层解析：两者皆无时用 init 票号清单兜底——归一化 + 去重 + 数值排序', () => {
  const issues = [
    issue(100, 'spec 正文'),
    issue(1042, '无边票据'),
    issue(205, '无边票据'),
    issue(1, '无边票据'),
  ];
  const r = resolveTicketSet({ issues, specRef: '100', initTickets: ['1042', '1', '205'] });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.source, 'init-list');
  assert.deepEqual(r.tickets, ['01', '205', '1042']);
});

test('三层解析：spec 引用也认 URL / owner/repo# 形态，反查与 sub-issues 同一口径', () => {
  const issues = [issue(100, 'spec'), issue(2, '## Parent\nowner/repo#100')];
  const r = resolveTicketSet({ issues, specRef: 'https://github.com/o/r/issues/100' });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.equal(r.source, 'parent-edges');
  assert.deepEqual(r.tickets, ['02']);
});

// ====================================================================
// 拒绝行为：非法票号 / 空集合 / 多义 Parent
// ====================================================================

test('拒绝：三层皆空（无 sub-issues、## Parent 反查无子票、init 清单未给或为空）', () => {
  const r = resolveTicketSet({ issues: [issue(100, 'spec')], specRef: '#100' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.tickets, []);
  const why = r.errors.join('\n');
  assert.match(why, /sub-issues/);
  assert.match(why, /Parent/);
  assert.match(why, /init/);
});

test('拒绝：spec 引用不在 issue 集合 / 解析不出 issue 号', () => {
  const r1 = resolveTicketSet({ issues: [issue(1, '## Parent\n#2')], specRef: '99' });
  assert.equal(r1.ok, false);
  assert.match(r1.errors.join('\n'), /不在 issue 集合/);
  const r2 = resolveTicketSet({ issues: [issue(1)], specRef: '.scratch/demo/spec.md' });
  assert.equal(r2.ok, false);
  assert.match(r2.errors.join('\n'), /issue 号/);
});

test('拒绝：多义 Parent——某票 ## Parent 边同时引用本 spec 与他票，点名该票拒绝', () => {
  const issues = [
    issue(100, 'spec 正文'),
    issue(1, '## Parent\n#100 #300'),
    issue(2, '## Parent\n#100'),
  ];
  const r = resolveTicketSet({ issues, specRef: '100' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /多义 Parent/);
  assert.match(r.errors.join('\n'), /票 01/);
});

test('拒绝边界：不涉本 spec 的多义 Parent 边不拒——该票只是别家 spec 的共享票', () => {
  const issues = [
    issue(100, 'spec 正文'),
    issue(1, '## Parent\n#300 #400'),
    issue(2, '## Parent\n#100'),
  ];
  const r = resolveTicketSet({ issues, specRef: '100' });
  assert.equal(r.ok, true, r.errors.join(';'));
  assert.deepEqual(r.tickets, ['02']);
});

test('拒绝：非法票号——init 清单含非数字 / 小数 / 超 6 位时整层拒绝', () => {
  for (const bad of [['abc'], ['1.5'], ['1234567'], ['01', 'x']]) {
    const r = resolveTicketSet({
      issues: [issue(100, 'spec'), issue(1, '## Parent\n#100')],
      specRef: '100',
      initTickets: bad,
    });
    assert.equal(r.ok, false, `initTickets=${JSON.stringify(bad)} 必须被拒`);
    assert.match(r.errors.join('\n'), /非法票号/);
  }
});

test('拒绝：非法票号——sub-issues 含非法形态同样拒绝（同过一个转换点）', () => {
  const r = resolveTicketSet({
    issues: [issue(100, 'spec', [7, 'oops']), issue(7, '## Parent\n#100')],
    specRef: '100',
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /非法票号/);
});

test('拒绝：spec 自指排除——spec 把自己列入 sub-issues 不算成员，也不算空层', () => {
  const r = resolveTicketSet({ issues: [issue(100, 'spec', [100])], specRef: '100' });
  assert.equal(r.ok, false, '排掉自指后层 1 为空，落到三层皆空的拒绝');
  const r2 = resolveTicketSet({ issues: [issue(100, 'spec', [100])], specRef: '100', initTickets: ['07'] });
  assert.equal(r2.ok, true, r2.errors.join(';'));
  assert.equal(r2.source, 'init-list');
  assert.deepEqual(r2.tickets, ['07']);
});

// ====================================================================
// ## Parent 边解析（parseParentEdge）
// ====================================================================

test('Parent 边解析：## Parent 节到下一个标题为止；#号与 URL 同收、同节去重', () => {
  assert.deepEqual(parseParentEdge('## Parent\n#1042\n\n## Blocked by\n—'), ['1042']);
  assert.deepEqual(
    parseParentEdge('## Parent\nhttps://github.com/o/r/issues/1042\n#1042'),
    ['1042'],
    '同一票号两种写法去重为一条边'
  );
  assert.deepEqual(
    parseParentEdge('## Parent\n#1042\n\n## Notes\n正文段落继续提到 #9999'),
    ['1042'],
    '节外的散文不进边'
  );
});

test('Parent 边解析：无 ## Parent 节返回 null（没有边）；空节返回 []（有边无引用）', () => {
  assert.equal(parseParentEdge('# 1042: 标题\n\n**Status:** ready-for-agent'), null);
  assert.equal(parseParentEdge('## Parenthood\n#1042'), null, '标题必须精确是 ## Parent');
  assert.deepEqual(parseParentEdge('## Parent\n'), []);
  assert.equal(parseParentEdge(null), null);
  assert.equal(parseParentEdge(undefined), null);
});
