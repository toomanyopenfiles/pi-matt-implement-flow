'use strict';

// 票 03：同步规划纯函数自检（scripts/sync-planning-core.js）。
// 接缝②（spec「Testing Decisions」新增）：tracker 同步核心纯函数面——
// （快照状态, tracker 状态）→ 幂等动作列表。纯函数直喂，不碰网络、不碰文件系统、
// 不测 gh IO 薄层；「模拟破坏」只喂假想 fixture（快照/ tracker 状态都是合成对象）。
// 幂等矩阵：每个动作在「未同步 / 已同步 / 部分同步」三档下的规划结果。

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { planTrackerSync } = require('./sync-planning-core.js');

// --- 合成 fixture：40 位 SHA（独立已知值，非由实现推出） ---

const SHA_A = '0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6';
const SHA_B = 'c92d1e7744aa83b0f5e6d1c2b3a49f80d7e6c5b4';

// --- 合并票：关票附 merge SHA 评论；tracker 已关时仅补评论 ---

test('合并票未同步：tracker 开着、无痕迹 → 规划关票且评论携带 merge SHA', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '1042', status: 'resolved', type: 'task', mergeSha: SHA_A }] },
    { issues: [{ num: 1042, state: 'open', assignees: [], comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['close'],
  );
  assert.equal(actions[0].num, '1042');
  assert.match(actions[0].body, new RegExp(SHA_A));
});

test('合并票已同步：tracker 已关且评论已含 SHA → 不再产生任何动作', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '1042', status: 'resolved', type: 'task', mergeSha: SHA_A }] },
    { issues: [{ num: 1042, state: 'closed', comments: [`已合并（merge SHA：${SHA_A}）`] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, []);
});

test('合并票部分同步（评论已推送、未关）：只规划关票，不再重复评论', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '1042', status: 'resolved', type: 'task', mergeSha: SHA_A }] },
    { issues: [{ num: 1042, state: 'open', comments: [`已合并（merge SHA：${SHA_A}）`] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, [{ kind: 'close', num: '1042', body: null }]);
});

// --- 升级票：留评（升级原因）且保持开放 —— "保持开放"是关票动作的缺席 ---

test('升级票未同步：tracker 开着、无痕迹 → 只规划留评，不产生任何关票动作', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '87', status: 'claimed', type: 'task', escalateReason: '两轮修复后 review 仍 changes_requested' }] },
    { issues: [{ num: 87, state: 'open', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['comment'],
  );
  assert.match(actions[0].body, /两轮修复后 review 仍 changes_requested/);
});

test('升级票已同步：升级原因评论已在 → 零动作（已评论不重复）', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '87', status: 'claimed', type: 'task', escalateReason: '两轮修复后 review 仍 changes_requested' }] },
    { issues: [{ num: 87, state: 'open', comments: ['已升级上报：两轮修复后 review 仍 changes_requested'] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, []);
});

test('升级票被抢跑关闭：仍补留评（留评不受开合影响，不规划 reopen）', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '87', status: 'claimed', type: 'task', escalateReason: '预算用尽' }] },
    { issues: [{ num: 87, state: 'closed', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['comment'],
  );
  assert.match(actions[0].body, /预算用尽/);
});

test('合并事实优先于升级事实：已合并的票不再补升级评论', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '87', status: 'resolved', mergeSha: SHA_A, escalateReason: '曾升级' }] },
    { issues: [{ num: 87, state: 'open', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['close'],
  );
});

test('合并票部分同步（已被抢跑关闭、评论未推送）：只补评论，不重复关票', () => {
  const actions = planTrackerSync(
    { tickets: [{ num: '1042', status: 'resolved', type: 'task', mergeSha: SHA_A }] },
    { issues: [{ num: 1042, state: 'closed', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(
    actions.map((a) => a.kind),
    ['comment'],
  );
  assert.match(actions[0].body, new RegExp(SHA_A));
});

// --- spec 母票：收尾关闭（评论含交付指引），同样过幂等矩阵 ---

test('spec 母票未同步：tracker 开着、无痕迹 → 规划关票且评论携带交付指引', () => {
  const note = '已交付：票 1042、1043 合并于主分支，PR #12 待审。';
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec', closingNote: note } },
    { issues: [{ num: 3001, state: 'open', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, [{ kind: 'close', num: '3001', body: note }]);
});

test('spec 母票已同步：已关且交付指引评论已在 → 零动作', () => {
  const note = '已交付：票 1042 合并于主分支。';
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec', closingNote: note } },
    { issues: [{ num: 3001, state: 'closed', comments: [note] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, []);
});

test('spec 母票部分同步（评论已在、未关）：只关票，不重复评论', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec', closingNote: '已交付。' } },
    { issues: [{ num: 3001, state: 'open', comments: ['已交付。'] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, [{ kind: 'close', num: '3001', body: null }]);
});

test('spec 母票被抢跑关闭、评论未推送：只补评论', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec', closingNote: '已交付。' } },
    { issues: [{ num: 3001, state: 'closed', comments: [] }] },
    { mode: 'seal' },
  );
  assert.deepEqual(actions, [{ kind: 'comment', num: '3001', body: '已交付。' }]);
});

test('spec 母票仍开放但快照无交付指引：拒绝放行（收尾协议未完成）', () => {
  assert.throws(
    () =>
      planTrackerSync(
        { tickets: [], spec: { num: '3001', type: 'spec', closingNote: null } },
        { issues: [{ num: 3001, state: 'open', comments: [] }] },
        { mode: 'seal' },
      ),
    /同步规划拒绝/,
  );
});

// --- 放弃路径：撤占坑 + 留评说明 ---

test('放弃未同步：撤占坑并留评说明，先评论后撤占', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec' } },
    { issues: [{ num: 3001, state: 'open', assignees: ['alice'], comments: [] }] },
    { mode: 'abandon', claimant: 'alice', reason: '用户拍板放弃：终审 not_ready' },
  );
  assert.deepEqual(actions.map((a) => a.kind), ['comment', 'unassign']);
  assert.match(actions[0].body, /用户拍板放弃：终审 not_ready/);
  assert.deepEqual(actions[1], { kind: 'unassign', num: '3001', login: 'alice' });
});

test('放弃部分同步（说明已留）：只撤占坑，不重复评论', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec' } },
    { issues: [{ num: 3001, state: 'open', assignees: ['alice'], comments: ['本 run 已放弃：改期重跑'] }] },
    { mode: 'abandon', claimant: 'alice', reason: '改期重跑' },
  );
  assert.deepEqual(actions, [{ kind: 'unassign', num: '3001', login: 'alice' }]);
});

test('放弃时占坑已不在（他人已处理）：只留说明', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec' } },
    { issues: [{ num: 3001, state: 'open', assignees: [], comments: [] }] },
    { mode: 'abandon', claimant: 'alice', reason: '改期重跑' },
  );
  assert.deepEqual(actions, [{ kind: 'comment', num: '3001', body: '本 run 已放弃：改期重跑' }]);
});

test('放弃已同步（评论已在、占坑已撤）：零动作', () => {
  const actions = planTrackerSync(
    { tickets: [], spec: { num: '3001', type: 'spec' } },
    { issues: [{ num: 3001, state: 'open', assignees: [], comments: ['本 run 已放弃：改期重跑'] }] },
    { mode: 'abandon', claimant: 'alice', reason: '改期重跑' },
  );
  assert.deepEqual(actions, []);
});

// --- 确定性：多票规划按票号数值序、spec 殿后；重复规划得同一列表；输入不被改动 ---

test('多票规划：动作按票号数值序排列，spec 收尾殿后，重复规划得到同一列表且不改输入', () => {
  const snapshot = {
    tickets: [
      { num: '1102', status: 'claimed', escalateReason: '预算用尽' },
      { num: '1042', status: 'resolved', mergeSha: SHA_A },
      { num: '7', status: 'resolved', mergeSha: SHA_B },
    ],
    spec: { num: '3001', type: 'spec', closingNote: '收尾。' },
  };
  const tracker = {
    issues: [
      { num: 3001, state: 'open', comments: [] },
      { num: 7, state: 'open', comments: [] },
      { num: 1042, state: 'closed', comments: [] },
      { num: 1102, state: 'open', comments: [] },
    ],
  };
  const snapshotCopy = JSON.parse(JSON.stringify(snapshot));
  const trackerCopy = JSON.parse(JSON.stringify(tracker));
  const actions = planTrackerSync(snapshot, tracker, { mode: 'seal' });
  assert.deepEqual(
    actions.map((a) => `${a.kind}@${a.num}`),
    ['close@07', 'comment@1042', 'comment@1102', 'close@3001'],
  );
  const again = planTrackerSync(snapshot, tracker, { mode: 'seal' });
  assert.deepEqual(again, actions);
  assert.deepEqual(snapshot, snapshotCopy);
  assert.deepEqual(tracker, trackerCopy);
});

test('规划器对空快照放行：零票零 spec → 零动作', () => {
  assert.deepEqual(planTrackerSync({ tickets: [] }, { issues: [] }, { mode: 'seal' }), []);
});

// --- 拒绝面：形态不合格的输入一律拒绝，不猜测 ---

test('拒绝面：非法快照、票号、重复、SHA 形态、mode、放弃参数与缺失 tracker 状态', () => {
  const okTracker = { issues: [{ num: 1042, state: 'open', comments: [] }] };
  // snapshot.tickets 非数组
  assert.throws(() => planTrackerSync({ tickets: 'x' }, okTracker, { mode: 'seal' }), /snapshot\.tickets 必须是数组/);
  // 票号非法
  assert.throws(
    () => planTrackerSync({ tickets: [{ num: 'ticket-042' }] }, okTracker, { mode: 'seal' }),
    /快照票号非法/,
  );
  // 快照票号重复
  const dup = { tickets: [{ num: '42', mergeSha: SHA_A }, { num: 42 }] };
  assert.throws(() => planTrackerSync(dup, okTracker, { mode: 'seal' }), /快照票号重复：42/);
  // tracker 票号重复 / state 非法
  assert.throws(
    () =>
      planTrackerSync(
        { tickets: [] },
        { issues: [{ num: 7, state: 'open' }, { num: '07', state: 'closed' }] },
        { mode: 'seal' },
      ),
    /tracker 票号重复：07/,
  );
  assert.throws(
    () => planTrackerSync({ tickets: [] }, { issues: [{ num: 7, state: 'OPEN' }] }, { mode: 'seal' }),
    /state 非法/,
  );
  // merge SHA 形态
  assert.throws(
    () => planTrackerSync({ tickets: [{ num: '42', mergeSha: 'not-a-sha' }] }, okTracker, { mode: 'seal' }),
    /mergeSha 非法/,
  );
  assert.throws(
    () => planTrackerSync({ tickets: [{ num: '42', mergeSha: '' }] }, okTracker, { mode: 'seal' }),
    /mergeSha 非法/,
  );
  // 升级原因空串
  assert.throws(
    () => planTrackerSync({ tickets: [{ num: '42', escalateReason: '  ' }] }, okTracker, { mode: 'seal' }),
    /escalateReason 非法/,
  );
  // 有同步事实但 tracker 缺状态
  assert.throws(
    () => planTrackerSync({ tickets: [{ num: '42', mergeSha: SHA_A }] }, { issues: [] }, { mode: 'seal' }),
    /tracker 缺快照票 42/,
  );
  // mode 缺失
  assert.throws(() => planTrackerSync({ tickets: [] }, { issues: [] }, {}), /mode 非法/);
  // 放弃参数缺失
  const spec = { tickets: [], spec: { num: '3001', type: 'spec' } };
  const withAssignee = { issues: [{ num: 3001, state: 'open', assignees: ['alice'], comments: [] }] };
  assert.throws(
    () => planTrackerSync(spec, withAssignee, { mode: 'abandon', reason: 'r' }),
    /abandon 需要 claimant/,
  );
  assert.throws(
    () => planTrackerSync(spec, withAssignee, { mode: 'abandon', claimant: 'alice' }),
    /abandon 需要 reason/,
  );
  assert.throws(
    () => planTrackerSync({ tickets: [] }, withAssignee, { mode: 'abandon', claimant: 'alice', reason: 'r' }),
    /abandon 需要快照 spec/,
  );
  // spec 母票 Type 不是 spec
  assert.throws(
    () =>
      planTrackerSync(
        { tickets: [], spec: { num: '3001', type: 'task', closingNote: 'n' } },
        withAssignee,
        { mode: 'seal' },
      ),
    /spec 母票 Type 非法/,
  );
});
