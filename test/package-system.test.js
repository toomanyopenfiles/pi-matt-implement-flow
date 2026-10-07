'use strict';

// 包级系统回归（阶段 B3）：从真实 npm tarball 解包目录调用包内脚本跑代表场景——
// 被测代码只来自包（test/fixtures/package-harness.js 的解包面），fixture/helper 来自
// test/ 源码。场景由测试控制步骤：这证明包内 CLI/git/tracker 桩的事实链，不模拟
// 模型判断，也不调用任何模型或真实 tracker。所有子进程带超时；临时资源失败也清理
// （t.after + 文件级 after）。验证层级：包级系统。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadPackage, cleanupPackage } = require('./fixtures/package-harness');

const PKG = loadPackage();
after(cleanupPackage);

// 被测入口 = 包内脚本。必须在 require 共享 fixture 之前注入——fixture 在 require 时刻锁定路径。
process.env.MATT_IMPLEMENT_LEDGER = path.join(PKG.root, 'scripts/ledger.js');

const {
  makeFixture, writeTicketFile, ledger, addAll, readEvents, readLedger, initRun, mergeTicket,
} = require('./fixtures/ledger-fixture');
const {
  makeFixture: makeSyncFixture, writeSpec, writeTicket, stubState, sync, withGh,
  rawLog, callLog, isViewCall, stateOf, MARK, SHA_A,
} = require('./fixtures/sync-fixture');
const { initOpenRun, runEvidence } = require('./fixtures/open-run-evidence');

const FINAL_RUN_ID = '89656ee2-8603-4407-957b-9d7f24e0f364';
const RUNTIME = (f) => f.runtime;

function spawnPkg(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(PKG.root, script), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ====================================================================
// 场景 1 · 正常 local run：init → 派发 → 评审 → 真实合并 → final ready → completed 封账
// ====================================================================

test('包级场景 1 · 正常 local run：合法事件链 + 真实 git 合并事实 + 终审 + completed 封账，封账后拒写', (t) => {
  const f = makeFixture(t);
  initRun(f);
  assert.equal(readEvents(f)[0].payload.tracker, 'local', '包内 init 识别 local 契约并入账');

  for (const num of ['01', '02']) {
    assert.equal(addAll(f, 'dispatch', { ticket: num, key: `t-${num}`, 'run-id': '9ea3e64b' }).status, 0);
    const { head, merge } = mergeTicket(f, num);
    assert.equal(addAll(f, 'settled', { ticket: num, round: '1', 'head-sha': head }).status, 0);
    assert.equal(addAll(f, 'verdict', { ticket: num, round: '1', verdict: 'approved' }).status, 0);
    assert.equal(addAll(f, 'merge', { ticket: num, 'head-sha': head, 'merge-sha': merge }).status, 0);
    writeTicketFile(f.dir, num, `完成票 ${num}`, { status: 'resolved' });
    f.git(`branch -D ticket-${num}`);
  }
  assert.equal(addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID }).status, 0);

  const closed = addAll(f, 'close', {});
  assert.equal(closed.status, 0, closed.stdout);
  const md = readLedger(f);
  assert.match(md, /^state: complete/m);
  assert.match(md, /^outcome: completed$/m);

  // merge 事件的 mergeSha 就是 feat/demo 上真实存在的合并提交（git 交叉核对在包内生效）。
  const log = f.git('log --format=%H feat/demo');
  for (const e of readEvents(f).filter((x) => x.type === 'merge')) {
    assert.ok(log.includes(e.payload.mergeSha), `mergeSha ${e.payload.mergeSha} 是真实合并`);
    assert.ok(log.includes(e.payload.headSha), `headSha ${e.payload.headSha} 在分支历史上`);
  }

  // 封账不可逆：拒写且历史不长。
  const history = fs.readFileSync(f.eventsPath, 'utf8');
  const denied = addAll(f, 'anomaly', { note: '封账后补记' });
  assert.equal(denied.status, 1, denied.stdout);
  assert.match(denied.stdout, /已封账/);
  assert.equal(fs.readFileSync(f.eventsPath, 'utf8'), history);

  assert.equal(ledger(['build', '--runtime-dir', RUNTIME(f)], { cwd: f.dir }).status, 0);
  const check = ledger(['check', '--runtime-dir', RUNTIME(f)], { cwd: f.dir });
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /账实一致/);
});

// ====================================================================
// 场景 2 · 修复与正式评审独立、批准门不退化、旧预算只作历史记录
// ====================================================================

test('包级场景 2 · 修复序号顺序尝试、评审轮次独立去重、批准门看最新裁决；旧预算仅历史记录', (t) => {
  const f = makeFixture(t);
  initRun(f);
  assert.equal(addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' }).status, 0);
  const { head, merge } = mergeTicket(f, '01');
  assert.equal(addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head }).status, 0);
  assert.equal(addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'changes_requested' }).status, 0);

  // 批准门：最新裁决非 approved 不可合并。
  const deniedMerge = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  assert.equal(deniedMerge.status, 1, deniedMerge.stdout);
  assert.match(deniedMerge.stdout, /changes_requested/);

  // 修复次数无配额、序号顺序尝试；跳号拒绝。
  for (const n of ['1', '2', '3']) {
    assert.equal(addAll(f, 'fix', { ticket: '01', 'fix-no': n, key: `fix-01-${n}`, 'resume-run-id': '9ea3e64b' }).status, 0);
  }
  const skipped = addAll(f, 'fix', { ticket: '01', 'fix-no': '5', key: 'fix-01-5', 'resume-run-id': '9ea3e64b' });
  assert.equal(skipped.status, 1, skipped.stdout);
  assert.match(skipped.stdout, /fixNo=5 与已入账 fix 事件数不符/);

  // 评审轮次独立：无新增修复也可正式重评；同票同轮裁决不可重复写入。
  assert.equal(addAll(f, 'verdict', { ticket: '01', round: '2', verdict: 'approved' }).status, 0);
  const dup = addAll(f, 'verdict', { ticket: '01', round: '2', verdict: 'approved' });
  assert.equal(dup.status, 1, dup.stdout);
  assert.match(dup.stdout, /同票同轮去重/);
  assert.equal(addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge }).status, 0);
  const events = readEvents(f);
  assert.deepEqual(events.filter((e) => e.type === 'fix').map((e) => Number(e.payload.fixNo)), [1, 2, 3]);
  assert.deepEqual(events.filter((e) => e.type === 'verdict').map((e) => Number(e.payload.round)), [1, 2]);

  // 旧预算兼容：历史 init 带 maxFixRounds——只作历史记录，不构成配额执法。
  const f2 = makeFixture(t);
  initRun(f2);
  const legacy = readEvents(f2)[0];
  legacy.payload.maxFixRounds = '3';
  fs.writeFileSync(f2.eventsPath, JSON.stringify(legacy) + '\n');
  const original = fs.readFileSync(f2.eventsPath, 'utf8');
  assert.equal(addAll(f2, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' }).status, 0);
  for (const n of ['1', '2', '3', '4']) {
    assert.equal(addAll(f2, 'fix', { ticket: '01', 'fix-no': n, key: `fix-01-${n}`, 'resume-run-id': '9ea3e64b' }).status, 0);
  }
  assert.equal(ledger(['build', '--runtime-dir', RUNTIME(f2)], { cwd: f2.dir }).status, 0);
  assert.match(readLedger(f2), /^historicalMaxFixRounds: 3（历史记录，不再生效）$/m);
  assert.equal(ledger(['check', '--runtime-dir', RUNTIME(f2)], { cwd: f2.dir }).status, 0);
  assert.equal(readEvents(f2).filter((e) => e.type === 'fix').length, 4, '超出旧配额仍可修复');
  assert.ok(fs.readFileSync(f2.eventsPath, 'utf8').startsWith(original), 'build/check 不改写旧记录');
});

// ====================================================================
// 场景 3 · 远端契约桩：同步推送、失败重试只补缺失、marker 幂等、完成态与桩一致
// ====================================================================

test('包级场景 3 · 远端契约桩：seal 同步 + 部分失败重试续作 + marker 幂等，最终态与桩一致', (t) => {
  const f = makeSyncFixture(t);
  writeSpec(f);
  writeTicket(f, '1043', 'merged', { status: 'resolved', comments: [`merge SHA: ${SHA_A}`] });
  writeTicket(f, '1044', 'in-flight', { status: 'claimed' });
  writeTicket(f, '1102', 'escalated', { status: 'claimed', comments: ['escalate: 预算用尽'] });
  stubState(f, {
    1043: { state: 'open', assignees: [], comments: [] },
    1044: { state: 'open', assignees: [], comments: [] },
    1102: { state: 'open', assignees: [], comments: [] },
    3001: { state: 'open', assignees: [], comments: [] },
  });

  // 部分失败：spec 收尾（最后动作）失败，前两个动作真实生效。
  const r1 = sync(f, [], { ...withGh(f), GH_STUB_FAIL_WRITE: '3001' });
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /同步失败/);
  assert.match(r1.stdout, /✓ close 1043/);
  assert.match(r1.stdout, /✓ comment 1102/);
  assert.match(r1.stdout, /未完成/);
  assert.match(r1.stdout, /close 3001/);
  assert.match(r1.stdout, /重跑/);
  assert.equal(stateOf(f, 1043).state, 'closed', '已完成的部分真实生效');
  assert.equal(stateOf(f, 3001).state, 'open', '未完成的动作不落任何状态');

  // 重跑续作：只补缺失动作。
  const r2 = sync(f, [], withGh(f));
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /✓ close 3001/);
  assert.doesNotMatch(r2.stdout, /close 1043/);
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');

  // marker 幂等：第三次执行零写入。
  const writesBefore = callLog(f).filter((l) => !isViewCall(l)).length;
  const r3 = sync(f, [], withGh(f));
  assert.equal(r3.status, 0, r3.stdout + r3.stderr);
  assert.match(r3.stdout, /已同步：无待推送动作/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, writesBefore, '第三次零写入');

  // 最终完成态与桩一致（正文 + 机器 marker；在途票不惊动 tracker）。
  assert.deepEqual(stateOf(f, 1043), {
    state: 'closed', assignees: [],
    comments: [`Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });
  assert.deepEqual(stateOf(f, 1102), {
    state: 'open', assignees: [],
    comments: [`Escalated: 预算用尽\n\n${MARK('escalate')}`],
  });
  assert.deepEqual(stateOf(f, 3001), {
    state: 'closed', assignees: [],
    comments: [`已交付：票 1043 合并于主分支，PR #12 待审。\n\n${MARK('closing')}`],
  });
  assert.deepEqual(stateOf(f, 1044), { state: 'open', assignees: [], comments: [] }, '在途票不惊动 tracker');
});

// ====================================================================
// 场景 4 · 显式放弃：未完成票开放、abandon 同步成功后封账、非法输入/未初始化拒绝
// ====================================================================

test('包级场景 4 · abandoned：同步放弃（留评+撤占坑）→ 显式封账，未完成票保持开放，拒绝面不落盘', (t) => {
  const f = makeSyncFixture(t);
  writeSpec(f);
  writeTicket(f, '1043', 'merged', { status: 'resolved', comments: [`merge SHA: ${SHA_A}`] });
  writeTicket(f, '1044', 'in-flight', { status: 'claimed' });
  writeTicket(f, '1102', 'escalated', { status: 'claimed', comments: ['escalate: 预算用尽'] });
  stubState(f, {
    1043: { state: 'open', assignees: [], comments: [] },
    1044: { state: 'open', assignees: [], comments: [] },
    1102: { state: 'open', assignees: [], comments: [] },
    3001: { state: 'open', assignees: ['alice', 'bob'], comments: [] },
  });
  initOpenRun(f); // 真实 init（包内脚本）：开放 run 不是测试手写的结论。
  const snapshotBefore = runEvidence(f);

  // abandon 同步：留评说明 + 撤占坑；不执行 seal、不关票。
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户明确放弃，保留未完成项'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /同步完成：2 个动作/);
  assert.doesNotMatch(r.stdout, /PR 标 ready/);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open', assignees: ['bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  for (const num of [1043, 1044, 1102]) {
    assert.deepEqual(stateOf(f, num), { state: 'open', assignees: [], comments: [] },
      `abandon 不同步票 ${num}，未完成票与未推送事实都保持开放`);
  }

  // 显式放弃封账：快照票文件零改动，历史只增不改。
  const eventsBefore = fs.readFileSync(f.eventsPath, 'utf8');
  const closed = addAll(f, 'close', { outcome: 'abandoned', note: '用户明确放弃，保留未完成项' });
  assert.equal(closed.status, 0, closed.stdout);
  assert.match(readLedger(f), /^state: complete/m);
  assert.match(readLedger(f), /^outcome: abandoned$/m);
  assert.ok(fs.readFileSync(f.eventsPath, 'utf8').startsWith(eventsBefore));
  for (const [name, content] of Object.entries(runEvidence(f))) {
    if (name.startsWith('tracker/')) {
      assert.equal(content, snapshotBefore[name], `放弃封账不改快照票文件：${name}`);
    }
  }

  // 封账后拒写。
  const denied = addAll(f, 'anomaly', { note: '封账后补记' });
  assert.equal(denied.status, 1, denied.stdout);
  assert.match(denied.stdout, /已封账/);

  // 非法输入 / 未初始化拒绝：不落盘（local fixture——git 事实面齐备，仅缺事件流）。
  const g = makeFixture(t);
  const early = addAll(g, 'close', { outcome: 'abandoned' });
  assert.equal(early.status, 1, early.stdout);
  assert.match(early.stdout, /未初始化/);
  assert.ok(!fs.existsSync(g.eventsPath), '未初始化拒绝不创建事件流');
  initRun(g);
  const before = fs.readFileSync(g.eventsPath, 'utf8');
  for (const flags of [{ outcome: 'abandon' }, { outcome: 'ready' }, { outcome: 'abandoned', force: 'true' }]) {
    const bad = addAll(g, 'close', flags);
    assert.equal(bad.status, 1, bad.stdout);
    assert.equal(fs.readFileSync(g.eventsPath, 'utf8'), before, '非法输入不落盘');
  }
});

// ====================================================================
// 场景 5 · 旧记录 build/check 与审计输出：unknown outcome、不补写历史、引用可达
// ====================================================================

test('包级场景 5 · 旧记录：build/check 只读兼容（close 无 outcome 不猜、历史不重写），审计双语降级可用', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  writeTicketFile(f.dir, '02', 'README 速览', { status: 'escalated', blockedBy: '01' });
  writeTicketFile(f.dir, '03', '未开工票', { status: 'ready-for-agent', blockedBy: '01' });
  // 手写工具升级前的旧账：v=1 信封、init 带历史预算、无 final、close 无 outcome。
  const ts = (i) => new Date(Date.UTC(2026, 8, 18, 3, i, 0)).toISOString();
  const legacy = [
    { v: 1, seq: 1, ts: ts(0), head: f.baseline(), type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: f.baseline(), spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local', maxFixRounds: 2 } },
    { v: 1, seq: 2, ts: ts(1), head, type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: '9ea3e64b' } },
    { v: 1, seq: 3, ts: ts(2), head, type: 'settled', payload: { ticket: '01', round: 1, headSha: head } },
    { v: 1, seq: 4, ts: ts(3), head, type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'approved' } },
    { v: 1, seq: 5, ts: ts(4), head: merge, type: 'merge', payload: { ticket: '01', headSha: head, mergeSha: merge } },
    { v: 1, seq: 6, ts: ts(5), head, type: 'escalate', payload: { ticket: '02', note: '两轮修复后仍 changes_requested' } },
    { v: 1, seq: 7, ts: ts(6), head, type: 'close', payload: { note: '旧封账' } },
  ];
  fs.writeFileSync(f.eventsPath, legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const before = fs.readFileSync(f.eventsPath, 'utf8');
  // 干净 HOME：平台证据探测不拾取宿主真实产物（无 final 事件也不探测）。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const build = ledger(['build', '--runtime-dir', RUNTIME(f)], { cwd: f.dir, env: { HOME: home } });
  assert.equal(build.status, 0, build.stdout);
  const md = readLedger(f);
  assert.match(md, /^state: complete/m);
  assert.match(md, /^outcome: unknown（旧记录未记录结果）$/m, '旧 close 无 outcome → 如实标 unknown，不猜历史意图');
  assert.match(md, /historicalMaxFixRounds: 2（历史记录，不再生效）/);
  const check = ledger(['check', '--runtime-dir', RUNTIME(f)], { cwd: f.dir, env: { HOME: home } });
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /账实一致/);
  assert.equal(fs.readFileSync(f.eventsPath, 'utf8'), before, 'build/check 不补写历史');

  // 旧封账同样不可重开。
  const denied = addAll(f, 'close', {});
  assert.equal(denied.status, 1, denied.stdout);
  assert.match(denied.stdout, /已封账/);
  assert.equal(fs.readFileSync(f.eventsPath, 'utf8'), before);

  // 审计输出（包内 CLI）：双语页面产出、旧 close 明确标为未记录、票文件引用可达。
  const expectations = {
    zh: /旧记录：封账结果未记录/,
    en: /Legacy record: close outcome not recorded/,
  };
  for (const [lang, legacyText] of Object.entries(expectations)) {
    const out = path.join(f.dir, `report-${lang}`);
    const r = spawnPkg('audit-report/report.js', ['--runtime-dir', RUNTIME(f), '--lang', lang, '--out', out], { cwd: f.dir });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (const page of ['index.html', 'final.html']) {
      const html = fs.readFileSync(path.join(out, page), 'utf8');
      assert.match(html, legacyText, `${lang}/${page} 不猜旧 close 的历史意图`);
      assert.match(html, /旧封账/, `${lang}/${page} 旧 close note 原文可见`);
    }
    // 票文件引用可达：票页存在且带票题（快照/票文件被真实读取，不是空壳报告）；
    // 零事件的未开工票也进票清单（放弃 run 不漏未完成票）。
    assert.match(fs.readFileSync(path.join(out, 'ticket-01.html'), 'utf8'), /自检基线/, `${lang} 票 01 页面引用票文件标题`);
    assert.match(fs.readFileSync(path.join(out, 'ticket-02.html'), 'utf8'), /README 速览/, `${lang} 票 02 页面引用票文件标题`);
    assert.match(fs.readFileSync(path.join(out, 'ticket-03.html'), 'utf8'), /未开工票/, `${lang} 未开工票也进票清单`);
  }
});
