'use strict';

// 票 02：工单转写纯函数——tracker issue 表示 → local 同构票文件文本。
// 接缝②（spec 已定）：tracker 同步核心纯函数面。纯函数直喂，无 IO、无网络；
// 测外部行为：三张映射表（状态 / 类型 / blocking）的映射矩阵、spec 母票标记、
// Source 行、转写产物的逐字节确定性与拒绝面。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sync = require('./tracker-sync-core');
const schema = require('./ledger-schema');

// --- 合成 issue fixture（gh issue JSON 的手工等价物）---

const issue = (over = {}) => ({
  number: 1042,
  title: '工单标题',
  body: '工单正文',
  state: 'OPEN',
  labels: [],
  ...over,
});

// ====================================================================
// 状态映射表（Status: 行）
// ====================================================================

test('状态映射：closed → Status: resolved；开放票按 triage label 映射', (t) => {
  assert.equal(sync.statusOf(issue({ state: 'CLOSED' })), 'resolved');
  assert.equal(sync.statusOf(issue({ state: 'closed' })), 'resolved', 'state 大小写不敏感');
  assert.equal(sync.statusOf(issue({ labels: ['ready-for-agent'] })), 'ready-for-agent');
});

test('状态映射：wontfix label → Status: wontfix，优先于 closed（关成 not_planned 的票仍显 wontfix）', (t) => {
  assert.equal(sync.statusOf(issue({ labels: ['wontfix'] })), 'wontfix');
  assert.equal(sync.statusOf(issue({ state: 'CLOSED', labels: ['wontfix'] })), 'wontfix');
  assert.equal(
    sync.statusOf(issue({ state: 'CLOSED', labels: ['ready-for-agent', 'wontfix'] })),
    'wontfix',
    'wontfix 与其他 triage label 并存时仍优先'
  );
});

test('状态映射：triage 词表五项逐项映射，按词表序取优先（与 labels 数组序无关）', (t) => {
  assert.equal(sync.statusOf(issue({ labels: ['needs-triage'] })), 'needs-triage');
  assert.equal(sync.statusOf(issue({ labels: ['needs-info'] })), 'needs-info');
  assert.equal(sync.statusOf(issue({ labels: ['ready-for-agent'] })), 'ready-for-agent');
  assert.equal(sync.statusOf(issue({ labels: ['ready-for-human'] })), 'ready-for-human');
  assert.equal(sync.statusOf(issue({ labels: ['wontfix'] })), 'wontfix');
  // 多 label 并存是输入异常，转写按词表序（wontfix → needs-triage → needs-info →
  // ready-for-agent → ready-for-human）取第一个命中：保守侧优先，不把待评估的票
  // 抬成可派发；映射因此与 labels 数组序无关，同一数据任何时刻转写一致。
  assert.equal(
    sync.statusOf(issue({ labels: ['ready-for-agent', 'needs-info'] })),
    'needs-info'
  );
  assert.equal(
    sync.statusOf(issue({ labels: ['needs-info', 'ready-for-agent'] })),
    'needs-info',
    '输入数组顺序颠倒不改变映射结果（映射是输入数据的纯函数，与数组序无关）'
  );
});

test('状态映射：开放票不在 triage 词表内 → needs-triage 兜底（未评估即待评估）', (t) => {
  assert.equal(sync.statusOf(issue()), 'needs-triage');
  assert.equal(sync.statusOf(issue({ labels: ['bug', 'p2'] })), 'needs-triage');
});

test('状态映射：gh 原始形态兼容——labels 为 {name} 对象数组', (t) => {
  assert.equal(sync.statusOf(issue({ labels: [{ name: 'ready-for-agent' }] })), 'ready-for-agent');
  assert.equal(sync.statusOf(issue({ labels: [{ name: 'wontfix' }, { name: 'p2' }] })), 'wontfix');
});

// ====================================================================
// 类型映射表（Type: 行）
// ====================================================================

test('类型映射：spec 母票 → Type: spec，优先于任何 label（封账门豁免可识别）', (t) => {
  assert.equal(sync.typeOf(issue(), { isSpec: true }), 'spec');
  assert.equal(
    sync.typeOf(issue({ labels: ['wayfinder:research'] }), { isSpec: true }),
    'spec',
    '母票标记压过 wayfinder label'
  );
});

test('类型映射：wayfinder:<type> label → Type: 行，四个词表值逐项映射', (t) => {
  for (const type of ['research', 'prototype', 'grilling', 'task']) {
    assert.equal(sync.typeOf(issue({ labels: [`wayfinder:${type}`] })), type);
  }
});

test('类型映射：未知 wayfinder 后缀逐字透传（转写是忠实拷贝层，不做词表校验）', (t) => {
  assert.equal(sync.typeOf(issue({ labels: ['wayfinder:banana'] })), 'banana');
});

test('类型映射：无 wayfinder label 且非母票 → null（无 Type 行，即默认任务票）', (t) => {
  assert.equal(sync.typeOf(issue()), null);
  assert.equal(sync.typeOf(issue({ labels: ['ready-for-agent', 'p2'] })), null);
});

test('类型映射：多个 wayfinder label 取数组序第一个', (t) => {
  assert.equal(sync.typeOf(issue({ labels: ['wayfinder:task', 'wayfinder:research'] })), 'task');
});

// ====================================================================
// 阻塞映射表（Blocked by: 行）
// ====================================================================

test('阻塞映射：正文 Blocked by 行 → 归一化编号（与账本同一转换点）', (t) => {
  assert.deepEqual(sync.blockedByOf(issue({ body: '**Blocked by:** 01, 02' })), ['01', '02']);
  assert.deepEqual(sync.blockedByOf(issue({ body: 'Blocked by: 7, 1042' })), ['07', '1042']);
  // 读取侧（parseTicketFile）归一后应得到同一表示——补零语义同过一个转换点
  for (const n of sync.blockedByOf(issue({ body: 'Blocked by: 7' }))) {
    assert.equal(n, schema.normalizeTicket('7'), '与账本 schema 共用 normalizeTicket');
  }
});

test('阻塞映射：native dependencies（blockedBy 字段）与正文行合并、去重、数值排序', (t) => {
  assert.deepEqual(sync.blockedByOf(issue({ blockedBy: [1042, 205] })), ['205', '1042']);
  assert.deepEqual(
    sync.blockedByOf(issue({ blockedBy: [205], body: 'Blocked by: 1042, 205' })),
    ['205', '1042'],
    '两个来源合并去重（'+"'205' 在正文与 native 各出现一次只留一条）"
  );
  assert.deepEqual(
    sync.blockedByOf(issue({ blockedBy: ['7', 1042] })),
    ['07', '1042'],
    'native 侧的数字同样过归一化'
  );
});

test('阻塞映射：无阻塞（—、None、无数字行、无正文）→ 空数组（落 **Blocked by:** —）', (t) => {
  assert.deepEqual(sync.blockedByOf(issue()), []);
  assert.deepEqual(sync.blockedByOf(issue({ body: '**Blocked by:** —' })), []);
  assert.deepEqual(sync.blockedByOf(issue({ body: 'Blocked by: None (can start immediately)' })), []);
  assert.deepEqual(sync.blockedByOf(issue({ body: '正文里只是顺带提到 Blocked by 这个词' })), []);
});

test('阻塞映射：超位数字引用被单一转换点丢弃（票号空间不可表示的边沿不进票文件）', (t) => {
  assert.deepEqual(sync.blockedByOf(issue({ blockedBy: [1234567], body: 'Blocked by: 7654321' })), []);
  assert.deepEqual(
    sync.blockedByOf(issue({ blockedBy: [12], body: 'Blocked by: 1234567' })),
    ['12'],
    '合法边照常保留，坏边不拖累整票'
  );
});

// ====================================================================
// 工单转写（票文件文本）
// ====================================================================

test('工单转写：固定编排的完整票文件文本（逐字节）', (t) => {
  assert.equal(
    sync.transcribeTicket(
      issue({
        number: 1042,
        title: '工单转写纯函数',
        state: 'OPEN',
        labels: ['ready-for-agent'],
        body: '**What to build:** 三张映射表。\n\n**Blocked by:** 1041',
        blockedBy: [1041],
      })
    ),
    [
      '# 1042: 工单转写纯函数',
      '',
      '**Status:** ready-for-agent',
      '',
      '**Blocked by:** 1041',
      '',
      '**What to build:** 三张映射表。',
      '',
      '**Blocked by:** 1041',
      '',
    ].join('\n'),
    '任务票默认无 Type 行（isTaskFile 语义：缺 Type 即 task）'
  );
});

test('工单转写：wayfinder 票带 Type 行；无正文时文件止于头部块；空 body 不落空节', (t) => {
  assert.equal(
    sync.transcribeTicket(issue({ number: 7, title: '侦察', labels: ['wayfinder:research'], body: null })),
    [
      '# 07: 侦察',
      '',
      '**Status:** needs-triage',
      '',
      '**Type:** research',
      '',
      '**Blocked by:** —',
      '',
    ].join('\n'),
    '1–9 号补零显示为 01–09（与账本显示语义自洽）；无 Type 之外的可选节'
  );
});

test('工单转写：CRLF 正文归一为 LF（local 同构，跨机器逐字节一致）', (t) => {
  const text = sync.transcribeTicket(issue({ body: '第一行\r\n\r\n第二行\r\n' }));
  assert.ok(!text.includes('\r'), '产物不得含 \\r');
  assert.match(text, /第一行\n\n第二行/);
});

test('工单转写与账本同构：三个标签行都能被 parseTicketFile 的宽容格式读到', (t) => {
  // ledger.js 对票文件的契约：**Status:** x / Status: x 两种写法都读（parseTicketFile）
  const text = sync.transcribeTicket(issue({ labels: ['wayfinder:research'], blockedBy: [1041] }));
  assert.match(text, /^\*\*\s*Status\s*:\*\*\s*.+$/m);
  assert.match(text, /^\*\*\s*Type\s*:\*\*\s*.+$/m);
  assert.match(text, /^\*\*\s*Blocked by\s*:\*\*\s*.+$/m);
  assert.match(text, /^#\s+1042\s*[:：]/m, 'H1 首题为 <票号>: <标题>，票号可被文件名/解析两侧读出');
});

// ====================================================================
// spec 母票转写（Source 行）
// ====================================================================

test('spec 转写：头部含 Source 行（tracker 原址，供同步收尾解析）+ Type: spec + 状态映射', (t) => {
  const text = sync.transcribeSpec({
    issue: issue({ number: 1040, title: 'Spec: 大功能', state: 'OPEN', body: '# Spec: 大功能\n\n正文' }),
    source: 'https://github.com/acme/repo/issues/1040',
  });
  const head = text.split('\n').slice(0, 5);
  assert.equal(head[0], '# 1040: Spec: 大功能');
  assert.match(head[1] + '\n' + head[2], /Source: https:\/\/github\.com\/acme\/repo\/issues\/1040/, 'Source 行在文件头部');
  assert.match(text, /\*\*Status:\*\* needs-triage|\*\*Status:\*\* ready-for-agent/);
  assert.match(text, /\*\*Type:\*\* spec/);
  assert.match(text, /# Spec: 大功能\n\n正文/, 'spec 正文逐字保留');
});

test('spec 转写：closed 的 spec issue → Status: resolved（同一张状态表）', (t) => {
  const text = sync.transcribeSpec({
    issue: issue({ number: 1040, state: 'CLOSED' }),
    source: 'https://github.com/acme/repo/issues/1040',
  });
  assert.match(text, /\*\*Status:\*\* resolved/);
});

test('spec 转写：source 缺省时回退 issue.url / issue.html_url；两者皆无 → 拒绝', (t) => {
  const withUrl = sync.transcribeSpec({ issue: issue({ url: 'https://github.com/acme/repo/issues/1040' }) });
  assert.match(withUrl, /^Source: https:\/\/github\.com\/acme\/repo\/issues\/1040$/m);
  const withHtmlUrl = sync.transcribeSpec({
    issue: issue({ html_url: 'https://github.com/acme/repo/issues/1040' }),
  });
  assert.match(withHtmlUrl, /^Source: https:\/\/github\.com\/acme\/repo\/issues\/1040$/m);
  assert.throws(() => sync.transcribeSpec({ issue: issue({ url: null, html_url: null }) }), /Source/);
});

// ====================================================================
// 整批转写与确定性
// ====================================================================

test('整批转写：spec + 工单列表 → spec 文本与数值排序的票文件文本', (t) => {
  const snap = sync.transcribeSnapshot({
    specIssue: issue({ number: 1040, title: 'Spec: 大功能' }),
    source: 'https://github.com/acme/repo/issues/1040',
    issues: [issue({ number: 1042, title: 'B 票' }), issue({ number: 205, title: 'A 票' })],
  });
  assert.match(snap.spec, /\*\*Type:\*\* spec/);
  assert.deepEqual(
    snap.tickets.map((x) => x.num),
    ['205', '1042'],
    '票按数值序供给落盘层（ADR-0004 同一口径）'
  );
  assert.match(snap.tickets[0].text, /^# 205: A 票$/m);
});

test('转写确定性：同一批 issue 数据任何时刻重复转写 → 逐字节一致', (t) => {
  const batch = () =>
    sync.transcribeSnapshot({
      specIssue: issue({
        number: 1040,
        title: 'Spec: 大功能',
        labels: ['ready-for-agent'],
        body: '# Spec: 大功能\n\n正文\r\n',
      }),
      source: 'https://github.com/acme/repo/issues/1040',
      issues: [
        issue({ number: 7, title: '一票', labels: ['wayfinder:research'], body: '研究题' }),
        issue({ number: 1042, title: '二票', labels: ['ready-for-agent'], body: '**Blocked by:** 7' }),
        issue({ number: 205, title: '三票', state: 'CLOSED', labels: ['wontfix'] }),
      ],
    });
  const a = batch();
  const b = batch();
  assert.equal(a.spec, b.spec);
  assert.deepEqual(a.tickets, b.tickets);
  // 逐字节：拼接整个产物再比对
  const flat = (s) => s.spec + s.tickets.map((x) => x.num + '\x00' + x.text).join('');
  assert.equal(flat(a), flat(b));
});

// ====================================================================
// 拒绝面（校验档：拒绝）
// ====================================================================

test('拒绝面：缺 spec 母票 / 票号非法 / 批内票号重复', (t) => {
  assert.throws(() => sync.transcribeSpec({ issue: null, source: 'https://x' }), /spec/);
  assert.throws(() => sync.transcribeTicket(issue({ number: 'abc' })), /票号/);
  assert.throws(
    () =>
      sync.transcribeSnapshot({
        specIssue: issue({ number: 1040 }),
        source: 'https://x',
        issues: [issue({ number: 1042 }), issue({ number: '1042' })],
      }),
    /重复/
  );
});
