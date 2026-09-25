'use strict';

// 票 06：同步读取层纯函数自检（scripts/sync-read-core.js）。
// 接缝②（spec「Testing Decisions」同款纯函数面）：快照 → 同步规划的输入结构。
// 三组纯函数：Comments 事实解析（mergeSha / escalateReason）、Source 行解析
//（spec 母票号 + tracker 原址的 owner/repo）、gh issue view 产物 → planTrackerSync
// 的 tracker 状态适配。readSnapshot 以 fs 谓词注入保持纯函数（不碰真实文件系统）。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCommentsFacts,
  parseSourceLine,
  readSnapshot,
  toTrackerIssues,
} = require('./sync-read-core.js');

const SHA = '0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6';

// ------------------------------------------------------------------
// Comments 事实解析：快照票文件的 ## Comments → { mergeSha, escalateReason }
// ------------------------------------------------------------------

test('Comments 事实：无 Comments 节或节为空 → 两事实皆 null', () => {
  assert.deepEqual(parseCommentsFacts('# 1042: x\n\n**Status:** claimed\n'), {
    mergeSha: null,
    escalateReason: null,
  });
  assert.deepEqual(parseCommentsFacts('# 1042: x\n\n## Comments\n\n（暂无）\n'), {
    mergeSha: null,
    escalateReason: null,
  });
});

test('Comments 事实：裸事实行 merge SHA: <sha>（半角冒号）→ 捕获 SHA', () => {
  const facts = parseCommentsFacts('# x\n\n## Comments\n\n- merge SHA: 0f3a9c41\n');
  assert.equal(facts.mergeSha, '0f3a9c41');
  assert.equal(facts.escalateReason, null);
});

test('Comments 事实：自然收尾评论 已合并（merge SHA：40 位 SHA）→ 捕获（全角冒号宽容）', () => {
  const facts = parseCommentsFacts(`# x\n\n## Comments\n\n- 已合并（merge SHA：${SHA}），Merge ticket-06\n`);
  assert.equal(facts.mergeSha, SHA);
});

test('Comments 事实：escalate: <原因> 与 已升级上报：<原因> 两种写法同捕（带列表符宽容）', () => {
  const a = parseCommentsFacts('# x\n\n## Comments\n\n- escalate: 两轮修复后仍 changes_requested\n');
  assert.equal(a.escalateReason, '两轮修复后仍 changes_requested');
  assert.equal(a.mergeSha, null);
  const b = parseCommentsFacts('# x\n\n## Comments\n\n已升级上报：预算用尽\n');
  assert.equal(b.escalateReason, '预算用尽');
});

test('Comments 事实：merge 与 escalate 并存 → 两事实各自解析（合并事实优先属规划器职责）', () => {
  const facts = parseCommentsFacts('# x\n\n## Comments\n\n- escalate: 曾升级\n- merge SHA: abc1234def5678\n');
  assert.equal(facts.mergeSha, 'abc1234def5678');
  assert.equal(facts.escalateReason, '曾升级');
});

test('Comments 事实：首个 merge SHA 行生效；Comments 节外的散文提及不算事实', () => {
  const text = [
    '# x',
    '',
    '正文里 merge SHA: deadbee 是散文——事实只认 Comments 节内的行。',
    '',
    '## Comments',
    '',
    '- merge SHA: 0f3a9c4',
    '- merge SHA: ffffffff',
  ].join('\n');
  assert.equal(parseCommentsFacts(text).mergeSha, '0f3a9c4');
});

test('Comments 事实：多个 Comments 节取最后一个（追加语义：最新在最下）', () => {
  const text = ['# x', '', '## Comments', '', '- escalate: 旧的一轮', '', '## Comments', '', '- escalate: 新的一轮'].join('\n');
  assert.equal(parseCommentsFacts(text).escalateReason, '新的一轮');
});

// ------------------------------------------------------------------
// Source 行解析：spec.md → { num, repo, url }
// ------------------------------------------------------------------

test('Source 行：GitHub issue URL → spec 母票号（过 normalizeTicket）+ owner/repo', () => {
  assert.deepEqual(parseSourceLine('# Spec: t\n\nSource: https://github.com/o/r/issues/3001\n'), {
    num: '3001',
    repo: 'o/r',
    url: 'https://github.com/o/r/issues/3001',
  });
  assert.deepEqual(parseSourceLine('Source: https://github.com/o/r/issues/7'), {
    num: '07',
    repo: 'o/r',
    url: 'https://github.com/o/r/issues/7',
  });
});

test('Source 行：缺行或非 GitHub issue URL → null（调用方拒绝同步，不猜）', () => {
  assert.equal(parseSourceLine('# Spec: t\n\n**Type:** spec\n'), null);
  assert.equal(parseSourceLine('Source: https://example.com/x/issues/3001\n'), null);
  assert.equal(parseSourceLine(null), null);
});

// ------------------------------------------------------------------
// readSnapshot：快照目录 → planTrackerSync 的 snapshot 输入结构（fs 谓词注入）
// ------------------------------------------------------------------

// --- 极小 fs 桩：tree 即 tracker 目录的内容（{ 'spec.md': '…', issues: { … } }），
// 路径按 /tracker/<seg> 切分下钻；tree=null 表示 tracker 目录不存在 ---

function fsOf(tree) {
  const drill = (p) => {
    if (tree == null) throw new Error(`不存在：${p}`);
    const parts = String(p).split('/').filter(Boolean);
    const base = parts.indexOf('tracker');
    let node = tree;
    for (const seg of parts.slice(base + 1)) {
      if (typeof node !== 'object' || node === null) throw new Error(`不存在：${p}`);
      node = node[seg];
    }
    if (node == null) throw new Error(`不存在：${p}`);
    return node;
  };
  const readFile = (p) => {
    const node = drill(p);
    if (typeof node !== 'string') throw new Error(`不存在：${p}`);
    return node;
  };
  const listDir = (p) => {
    const node = drill(p);
    if (typeof node !== 'object' || node === null) throw new Error(`不是目录：${p}`);
    return Object.keys(node);
  };
  const exists = (p) => {
    try {
      drill(p);
      return true;
    } catch {
      return false;
    }
  };
  return { readFile, listDir, exists };
}

const SPEC_MD = [
  '# Spec: GitHub tracker 一等公民支持',
  '',
  'Source: https://github.com/o/r/issues/1042',
  '',
  '**Status:** needs-triage',
  '',
  '**Type:** spec',
  '',
  'spec 正文',
  '',
  '## Comments',
  '',
  '- closing: 已交付：票 1043 合并于主分支。',
].join('\n');

test('readSnapshot：spec 母票（Source/Type/closing）+ 票文件事实 → 规划器输入结构，票按数值序', () => {
  const tree = {
    'spec.md': SPEC_MD,
    issues: {
      '1102-escalated.md': [
        '# 1102: 升级票',
        '',
        '**Status:** claimed',
        '',
        '**Blocked by:** —',
        '',
        '## Comments',
        '',
        '- escalate: 预算用尽',
      ].join('\n'),
      '1043-merged.md': [
        '# 1043: 合并票',
        '',
        '**Status:** resolved',
        '',
        '## Comments',
        '',
        `- merge SHA: ${SHA}`,
      ].join('\n'),
      '0007-short.md': '# 7: 个位号\n\n**Status:** ready-for-agent\n',
    },
  };
  const r = readSnapshot({ trackerDir: '/x/tracker', ...fsOf(tree) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
  // 票按数值序（ADR-0004，7 < 1043 < 1102）；个位号过 normalizeTicket 归一为 '07'
  assert.deepEqual(
    r.tickets.map((t) => t.num),
    ['07', '1043', '1102'],
  );
  const merged = r.tickets.find((t) => t.num === '1043');
  assert.equal(merged.status, 'resolved');
  assert.equal(merged.mergeSha, SHA);
  assert.equal(merged.escalateReason, null);
  assert.equal(r.tickets.find((t) => t.num === '1102').escalateReason, '预算用尽');
  assert.equal(r.tickets.find((t) => t.num === '07').mergeSha, null);
  assert.deepEqual(r.spec, {
    num: '1042',
    type: 'spec',
    closingNote: '已交付：票 1043 合并于主分支。',
  });
  assert.deepEqual(r.source, { repo: 'o/r', url: 'https://github.com/o/r/issues/1042' });
});

test('readSnapshot：快照目录不存在 / 缺 spec.md / 缺 issues 目录 → 拒绝并点名', () => {
  const noDir = readSnapshot({ trackerDir: '/x/tracker', ...fsOf(null) });
  assert.equal(noDir.ok, false);
  assert.match(noDir.errors[0], /快照不存在/);

  const noSpec = readSnapshot({
    trackerDir: '/x/tracker',
    ...fsOf({ issues: { '1-a.md': '# 1: x' } }),
  });
  assert.equal(noSpec.ok, false);
  assert.match(noSpec.errors[0], /spec\.md/);

  const noIssues = readSnapshot({
    trackerDir: '/x/tracker',
    ...fsOf({ 'spec.md': SPEC_MD }),
  });
  assert.equal(noIssues.ok, false);
  assert.match(noIssues.errors[0], /issues/);
});

test('readSnapshot：无数字前缀文件跳过并警告；Source 行非法 → 整体拒绝（spec 母票不可定位）', () => {
  const tree = {
    'spec.md': SPEC_MD,
    issues: {
      'README.md': '# 说明',
      '1043-a.md': '# 1043: x\n\n**Status:** claimed\n',
    },
  };
  const r = readSnapshot({ trackerDir: '/x/tracker', ...fsOf(tree) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tickets.map((t) => t.num), ['1043']);
  assert.match(r.warnings[0], /README\.md/);

  const bad = readSnapshot({
    trackerDir: '/x/tracker',
    ...fsOf({ 'spec.md': '# Spec: t\n\nSource: https://example.com/x/1\n', issues: {} }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /Source/);
});

// ------------------------------------------------------------------
// toTrackerIssues：gh issue view 产物 → planTrackerSync 的 tracker 状态
// ------------------------------------------------------------------

test('toTrackerIssues：gh 语义归一——大写 state → 小写、assignee 对象 → login、comment 对象 → body', () => {
  const issues = toTrackerIssues([
    {
      number: 3001,
      state: 'OPEN',
      assignees: [{ login: 'alice' }],
      comments: [{ body: '本 run 已放弃：改期' }],
    },
    { number: '1042', state: 'CLOSED', comments: [{ body: '已合并（merge SHA：0f3a9c41）' }] },
  ]);
  assert.deepEqual(issues, [
    { num: '3001', state: 'open', assignees: ['alice'], comments: ['本 run 已放弃：改期'] },
    { num: '1042', state: 'closed', assignees: [], comments: ['已合并（merge SHA：0f3a9c41）'] },
  ]);
});

test('toTrackerIssues：缺 assignees / comments 字段 → 空数组缺省（规划器输入形态的缺省约定）', () => {
  assert.deepEqual(toTrackerIssues([{ number: 7, state: 'open' }]), [
    { num: '07', state: 'open', assignees: [], comments: [] },
  ]);
});
