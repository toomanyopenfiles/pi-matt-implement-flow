'use strict';

// 票 05：快照布局核心自检（纯函数直喂风格，同 tracker-set / tracker-sync 测试套件）。
// planSnapshot 把三件事编排成一份快照文件清单：04 的票集解析（三层兜底）→ 02 的转写口径
// （spec 母票带 Type: spec 豁免标记 + Source: 行）→ 文件名布局（issues/<号>-<slug>.md）。
// checkOverwrite 是快照已存在的拒绝判定（续跑保护），exists 谓词注入。
// 不碰网络、不碰文件系统；gh 收发与落盘属 ledger.js 的薄 IO，由 snapshot-cli.test.js 黑盒。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { slugify, planSnapshot, checkOverwrite } = require('./snapshot-core.js');

// --- fixture：tracker 的 issue 集合表示（gh issue list --json 的手工等价物）---

const issue = (number, { title = '', body = '', state = 'OPEN', labels = [], subIssues, blockedBy, url } = {}) => ({
  number,
  title,
  body,
  state,
  labels,
  ...(subIssues === undefined ? {} : { subIssues }),
  ...(blockedBy === undefined ? {} : { blockedBy }),
  ...(url === undefined ? {} : { url }),
});

// ====================================================================
// slugify：标题 → 文件名 slug（确定性；同一标题任何时刻同一 slug）
// ====================================================================

test('slugify：ASCII 标题折叠为 kebab 词段，符号与空白并成单个连字符', () => {
  assert.equal(slugify('Issue transcription pure fns'), 'issue-transcription-pure-fns');
  assert.equal(slugify('  Fix: the -- thing!!  '), 'fix-the-thing');
  assert.equal(slugify('A___B   C'), 'a-b-c');
});

test('slugify：CJK 逐字折叠（不猜音译）——纯中文标题得空串，调用方退化裸票号文件名', () => {
  assert.equal(slugify('05: 快照初始化子命令'), '05', 'ASCII 词段保留，CJK 折叠');
  assert.equal(slugify('快照初始化子命令'), '');
  assert.equal(slugify('???'), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

// ====================================================================
// planSnapshot：票集（04）→ 转写（02）→ 文件布局
// ====================================================================

test('planSnapshot：## Parent 反查定界——spec.md 带 Source 行与 Type: spec 豁免标记，票文件名带原生票号', () => {
  const issues = [
    issue(1042, {
      title: 'GitHub tracker 一等公民支持',
      body: '## Solution\n\n快照 + 同步。',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/o/r/issues/1042',
    }),
    issue(1043, {
      title: 'Issue transcription pure fns',
      body: '## Parent\n\n#1042',
      labels: [{ name: 'ready-for-agent' }],
      url: 'https://github.com/o/r/issues/1043',
    }),
    issue(1044, {
      title: 'Sync command',
      body: '## Parent\n\n#1042\n\nBlocked by: 1043',
      state: 'CLOSED',
      url: 'https://github.com/o/r/issues/1044',
    }),
    issue(2, { title: '快照小号票', body: '## Parent\n\n#1042', url: 'https://github.com/o/r/issues/2' }),
    issue(9000, { title: 'Unrelated feature issue', body: '别的 spec 的票，不入本 run 票集' }),
  ];
  const plan = planSnapshot({ issues, specRef: '#1042' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.equal(plan.specNum, '1042');
  assert.equal(plan.source, 'parent-edges');

  // spec 母票：文件名固定 spec.md，头部带 Source: 行（tracker 原址）与 Type: spec（封账门豁免标记）
  assert.equal(plan.spec.rel, 'spec.md');
  assert.equal(plan.spec.source, 'https://github.com/o/r/issues/1042');
  assert.match(plan.spec.text, /^# Spec: GitHub tracker 一等公民支持$/m, 'H1 对齐 local spec.md 形态（integration-05 对齐项）');
  assert.match(plan.spec.text, /^Source: https:\/\/github\.com\/o\/r\/issues\/1042$/m);
  assert.match(plan.spec.text, /^\*\*Type:\*\* spec$/m, 'spec 母票豁免标记');
  assert.match(plan.spec.text, /^\*\*Status:\*\* ready-for-agent$/m, '状态走 02 的 label 映射口径');

  // 每票一文件：issues/<号>-<slug>.md，票号数值序；纯中文标题退化裸号
  assert.deepEqual(
    plan.tickets.map((tk) => tk.rel),
    [
      'issues/02.md',
      'issues/1043-issue-transcription-pure-fns.md',
      'issues/1044-sync-command.md',
    ],
    '票号归一（2 → 02）+ 数值排序；boundary 外的 9000 不转写'
  );
  assert.match(plan.tickets[1].text, /^\*\*Status:\*\* ready-for-agent$/m);
  assert.match(
    plan.tickets[2].text,
    /^\*\*Status:\*\* resolved$/m,
    'closed → resolved（02 的状态映射表）'
  );
  assert.match(
    plan.tickets[2].text,
    /^\*\*Blocked by:\*\* 1043$/m,
    '正文 Blocked by 行过 02 的阻塞映射表'
  );
  assert.ok(!plan.tickets.some((tk) => tk.rel.includes('9000')), '票集边界外的票不进快照');
});

test('planSnapshot：native 依赖边（issue.blockedBy 注入）透传进票文件 Blocked by 行（integration-05 缺陷 1）', () => {
  // gh 薄 IO 把 dependencies/blocked_by 拉取产物注入 issue.blockedBy——纯布局层只验证
  // 注入后的字段原样流进 02 的阻塞映射表，不问注入从何而来。
  const issues = [
    issue(1042, { title: 'spec', body: 'spec 正文', url: 'https://github.com/o/r/issues/1042' }),
    issue(1043, { title: 'blocker', body: '## Parent\n\n#1042' }),
    issue(1044, { title: 'blocked ticket', body: '## Parent\n\n#1042', blockedBy: ['1043'] }),
  ];
  const plan = planSnapshot({ issues, specRef: '#1042' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  const text = plan.tickets.find((tk) => tk.num === '1044').text;
  assert.match(text, /^\*\*Blocked by:\*\* 1043$/m, 'native 边落 Blocked by 行（正文行缺席也不落占位 —）');
});

test('planSnapshot：sub-issues 层优先定界——正文无 Parent 边的票也入集，spec 母票不进集合', () => {
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文', labels: [], url: 'https://github.com/o/r/issues/100' }),
    issue(101, { title: 'Alpha ticket', body: '没有 Parent 边' }),
    issue(102, { title: 'Beta ticket', body: '没有 Parent 边' }),
    issue(103, { title: '边界外散票', body: '没有 Parent 边' }),
  ];
  // subIssues 注入是 IO 薄层的职责（tracker-set-core 的调用方契约）
  issues[0].subIssues = [102, 101, 102];
  const plan = planSnapshot({ issues, specRef: '100' });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.equal(plan.source, 'sub-issues');
  assert.deepEqual(
    plan.tickets.map((tk) => tk.rel),
    ['issues/101-alpha-ticket.md', 'issues/102-beta-ticket.md'],
    '去重 + 数值排序；边界外的 103 不收'
  );
  assert.ok(!plan.tickets.some((tk) => tk.num === '100'), 'spec 母票不进任务票集合');
});

test('planSnapshot：三层皆走不通到 init 票号清单兜底——归一 + 去重后按清单落盘', () => {
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文', url: 'https://github.com/o/r/issues/100' }),
    issue(1042, { title: 'Edge case ticket', body: '无边票据' }),
    issue(1, { title: 'another', body: '无边票据' }),
  ];
  const plan = planSnapshot({ issues, specRef: '100', initTickets: ['1042', '1', '1'] });
  assert.equal(plan.ok, true, plan.errors.join(';'));
  assert.equal(plan.source, 'init-list');
  assert.deepEqual(
    plan.tickets.map((tk) => tk.rel),
    ['issues/01-another.md', 'issues/1042-edge-case-ticket.md']
  );
});

test('planSnapshot：spec 引用不可解析（local 路径 / 散文）→ 拒绝且零文件', () => {
  const plan = planSnapshot({ issues: [issue(1, { title: 'x' })], specRef: '.scratch/demo/spec.md' });
  assert.equal(plan.ok, false);
  assert.equal(plan.files ? plan.files.length : plan.tickets.length, 0);
  assert.match(plan.errors[0], /spec 引用无法解析出 issue 号/);
  assert.match(plan.errors[0], /GitHub 传 issue 号/);
  assert.equal(plan.spec, null);
});

test('planSnapshot：spec 引用指向集合外的 issue → 拒绝（拉取不全或引用有误）', () => {
  const plan = planSnapshot({ issues: [issue(1, { title: 'x' })], specRef: '#1042' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors[0], /1042 不在 issue 集合中/);
});

test('planSnapshot：spec issue 缺 tracker 原址（无 URL）→ 拒绝，不落盘', () => {
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文' }), // 无 url：Source 无从取
    issue(101, { title: 'Ticket', body: '## Parent\n\n#100' }),
  ];
  const plan = planSnapshot({ issues, specRef: '#100' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors[0], /Source/);
  assert.match(plan.errors[0], /tracker 原址/);
});

test('planSnapshot：init 票号清单含非法票号（票号空间外）→ 拒绝', () => {
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文', url: 'https://github.com/o/r/issues/100' }),
    issue(1042, { title: 'ok', body: '## Parent\n\n#100' }),
  ];
  const plan = planSnapshot({ issues, specRef: '#100', initTickets: ['1042', '1234567'] });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /非法票号/);
});

test('planSnapshot：init 票号清单指向拉取集合外的票 → 如实诊断（用户输入或拉取不全），不借内部不变量之名拒绝', () => {
  // 笔误/越界票号与 --limit 1000 截断都让边界票号落在拉取集合之外：这是用户可见事实，
  // 诊断必须点名两种可能成因，不得伪装成内部不变量被破坏。
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文', url: 'https://github.com/o/r/issues/100' }),
    issue(1042, { title: 'real ticket', body: '无边票据' }),
  ];
  const plan = planSnapshot({ issues, specRef: '#100', initTickets: ['1049'] });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /1049/);
  assert.match(plan.errors.join('\n'), /拉取不全/);
  assert.match(plan.errors.join('\n'), /limit 1000/);
  assert.doesNotMatch(plan.errors.join('\n'), /内部不变量/);
  assert.equal(plan.tickets.length, 0, '拒绝即零文件，不落半成品');
});

test('planSnapshot：sub-issues 边界指向未拉到的票 → 同样如实诊断（拉取不全）', () => {
  const issues = [
    issue(100, { title: 'spec', body: 'spec 正文', url: 'https://github.com/o/r/issues/100', subIssues: [1043, 9999] }),
    issue(1043, { title: 'pulled ticket', body: '## Parent\n\n#100' }),
  ];
  const plan = planSnapshot({ issues, specRef: '#100' });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /9999/);
  assert.match(plan.errors.join('\n'), /拉取不全/);
  assert.doesNotMatch(plan.errors.join('\n'), /内部不变量/);
});

// ====================================================================
// checkOverwrite：快照已存在的拒绝判定（续跑保护）
// ====================================================================

test('checkOverwrite：快照根目录已存在 → 拒绝并点名冲突路径；不存在 → 放行', () => {
  const seen = new Set(['/rt/tracker']);
  const hit = checkOverwrite({ snapshotDir: '/rt/tracker', fileExists: (p) => seen.has(p) });
  assert.equal(hit.ok, false);
  assert.deepEqual(hit.conflicts, ['/rt/tracker']);

  const clear = checkOverwrite({ snapshotDir: '/rt/tracker', fileExists: () => false });
  assert.equal(clear.ok, true);
  assert.deepEqual(clear.conflicts, []);
});
