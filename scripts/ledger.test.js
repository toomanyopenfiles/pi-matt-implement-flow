'use strict';

// 票 02/03：ledger CLI 黑盒测试——在 fixture 临时仓上真实调用 CLI，
// 断言退出码、stdout、生成的台账内容与事件流增量。
// 唯一缝（spec 已确认）：add / build / check 三个子命令的黑盒面。
// 不测内部函数；「模拟破坏」一律发生在 fixture 仓（git 真值、票文件、事件流）里。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, 'ledger.js');

// --- fixture 临时仓 ---

function sh(dir, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture 命令失败: ${cmd}\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function writeTicketFile(dir, num, title, { blockedBy = null, status = 'ready-for-agent', type = null } = {}) {
  const lines = [`# ${num}: ${title}`, '', `**Status:** ${status}`, ''];
  if (type) lines.push(`**Type:** ${type}`, '');
  lines.push(`**Blocked by:** ${blockedBy ?? '—'}`, '');
  fs.writeFileSync(path.join(dir, `.scratch/demo/issues/${num}-x.md`), lines.join('\n'));
}

function makeFixture(t, { tickets = true, remote = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email t@example.com && git config user.name T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  sh(dir, 'git add -A && git commit -qm baseline');
  if (tickets) {
    fs.mkdirSync(path.join(dir, '.scratch/demo/issues'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.scratch/demo/spec.md'), '# demo spec\n');
    writeTicketFile(dir, '01', '自检基线', { blockedBy: null });
    writeTicketFile(dir, '02', 'README 速览', { blockedBy: '01' });
  }
  if (remote) sh(dir, `git remote add origin ${remote}`);
  return {
    dir,
    runtime: path.join(dir, '.pi/matt-implement/demo'),
    git: (cmd) => sh(dir, `git ${cmd}`),
    eventsPath: path.join(dir, '.pi/matt-implement/demo/events.jsonl'),
    ledgerPath: path.join(dir, '.pi/matt-implement/demo/ledger.md'),
    baseline: () => sh(dir, 'git rev-parse HEAD'),
  };
}

function ledger(args, { cwd, env } = {}) {
  const r = spawnSync(process.execPath, [LEDGER, ...args], {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function addAll(f, type, flags = {}, { env } = {}) {
  const args = ['add', type, '--runtime-dir', f.runtime];
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    args.push(`--${k}`);
    if (v !== '') args.push(String(v));
  }
  return ledger(args, { cwd: f.dir, env });
}

function readEvents(f) {
  return fs
    .readFileSync(f.eventsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function readLedger(f) {
  return fs.readFileSync(f.ledgerPath, 'utf8');
}

// --- 标准运行铺底：init + dispatch/settled/verdict（票 01）---

function initRun(f) {
  f.git('checkout -q -b feat/demo');
  const r = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
  });
  assert.equal(r.status, 0, r.stdout);
  return r;
}

function makeWorktree(f, name) {
  const wt = path.join(f.dir, name);
  f.git(`worktree add -q ${wt} -b ${name}`);
  return wt;
}

// 在 feat/demo 上模拟一票的完整生命周期（分支、提交、--no-ff 合并），
// 返回 {head, merge}：coder 报告的 headSha 与 merge 提交。
function mergeTicket(f, num) {
  f.git(`checkout -q -b ticket-${num}`);
  fs.writeFileSync(path.join(f.dir, `work-${num}.txt`), `${num}\n`);
  sh(f.dir, `git add work-${num}.txt && git commit -qm "work ticket-${num}"`);
  const head = f.git('rev-parse HEAD');
  f.git('checkout -q feat/demo');
  f.git(`merge --no-ff -q -m "Merge ticket-${num}: done" ticket-${num}`);
  const merge = f.git('rev-parse HEAD');
  return { head, merge };
}

// ====================================================================
// CLI 使用面
// ====================================================================

test('--help 打印用法并以 0 退出', (t) => {
  const r = ledger(['--help'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /add/);
  assert.match(r.stdout, /build/);
  assert.match(r.stdout, /check/);
  assert.match(r.stdout, /runtime-dir/);
});

test('无参数或未知子命令以非零退出并给出用法提示', (t) => {
  const none = ledger([], { cwd: os.tmpdir() });
  assert.notEqual(none.status, 0);
  assert.match(none.stdout, /用法|usage/i);
  const bogus = ledger(['frobnicate'], { cwd: os.tmpdir() });
  assert.notEqual(bogus.status, 0);
});

test('缺 --runtime-dir 以非零退出', (t) => {
  const r = ledger(['build'], { cwd: os.tmpdir() });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /runtime-dir/);
});

// ====================================================================
// add：信封字段由脚本生成（时间戳 / 序号 / 版本 / HEAD 锚点）
// ====================================================================

test('add init: 事件行含脚本盖的版本/序号/时间戳/HEAD 锚点，台账落盘', (t) => {
  const f = makeFixture(t);
  const r = initRun(f);
  const events = readEvents(f);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.v, 3, '信封版本随事件分类学演进（anomaly refSeq 联动 → v=3）');
  assert.equal(e.seq, 1);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.match(e.ts, /(Z|[+-]\d{2}:\d{2})$/, '时间戳必须含时区');
  assert.equal(e.head, f.baseline());
  assert.equal(e.type, 'init');
  assert.deepEqual(e.payload, {
    branch: 'feat/demo',
    branchBase: 'main',
    baselineSha: f.baseline(),
    spec: '.scratch/demo/spec.md',
    testCommand: 'npm test',
    tracker: 'local',
  });
  assert.ok(fs.existsSync(f.ledgerPath), '记账成功后台账应已自动再生');
  assert.match(r.stdout, /seq=1/);
});

test('序号单调递增、时间戳由脚本盖（LLM 无法提供时间字段）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const r = addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  assert.equal(r.status, 0, r.stdout);
  const r2 = addAll(f, 'dispatch', {
    ticket: '02',
    key: 't-02',
    'run-id': 'bbbbbbbb',
    ts: '2020-01-01T00:00:00Z',
  });
  assert.notEqual(r2.status, 0, '不存在提供时间的旗标——--ts 必须被当作未知旗标拒绝');
  assert.match(r2.stdout, /未知旗标|unknown/i);
  const events = readEvents(f);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2]
  );
  assert.ok(events[1].ts >= events[0].ts, '时间戳由脚本盖章且单调');
});

test('非 init 事件在空事件流上被拒绝；init 重复记账被拒绝', (t) => {
  const f = makeFixture(t);
  const early = addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  assert.equal(early.status, 1);
  assert.match(early.stdout, /init/);
  assert.ok(!fs.existsSync(f.eventsPath), '被拒绝的事件不得落盘');
  initRun(f);
  const again = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
  });
  assert.equal(again.status, 1);
  assert.match(again.stdout, /init/);
  assert.equal(readEvents(f).length, 1);
});

// ====================================================================
// add：坏载荷当场拒绝（退出非零 + 原因 + 不落盘）
// ====================================================================

test('坏载荷：缺必选参数被拒绝并说明缺什么，事件流与台账不被改动', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const before = readLedger(f);
  const r = addAll(f, 'dispatch', { ticket: '01', key: 't-01' }); // 缺 run-id
  assert.equal(r.status, 1);
  assert.match(r.stdout, /run-id|runId/i);
  assert.equal(readEvents(f).length, 1, '被拒绝的事件不得 append');
  assert.equal(readLedger(f), before, '被拒绝的记账不得触发台账再生');
});

test('坏载荷：未知旗标与未知事件类型被拒绝（无任何绕过旗标）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const unknownFlag = addAll(f, 'dispatch', {
    ticket: '01',
    key: 't-01',
    'run-id': 'aaaaaaaa',
    force: 'true',
  });
  assert.equal(unknownFlag.status, 1);
  assert.match(unknownFlag.stdout, /--force/);
  assert.equal(readEvents(f).length, 1);
  const skip = addAll(f, 'merge', {
    ticket: '01',
    'head-sha': '0'.repeat(40),
    'merge-sha': '0'.repeat(40),
    'skip-validation': 'true',
  });
  assert.equal(skip.status, 1);
  assert.match(skip.stdout, /skip-validation/);
  const badType = ledger(['add', 'secrets', '--runtime-dir', f.runtime, '--note', 'x'], { cwd: f.dir });
  assert.equal(badType.status, 1);
  assert.match(badType.stdout, /secrets/);
  assert.equal(readEvents(f).length, 1);
});

test('坏载荷：非法枚举值（verdict / pr state / tracker）被拒绝', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const v = addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'blocked' });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /approved|changes_requested/);
  const p = addAll(f, 'pr', { state: 'merged' });
  assert.equal(p.status, 1);
  assert.match(p.stdout, /opened-draft|ready/);
  const tr = addAll(f, 'init', {
    branch: 'b',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: 's',
    'test-command': 'npm test',
    tracker: 'jira',
  });
  assert.equal(tr.status, 1);
  assert.match(tr.stdout, /local|github|gitlab/);
  assert.equal(readEvents(f).length, 1);
});

test('anomaly 是唯一逃生通道：带 --note 的事件即使在校验器会皱眉的时刻也可入账', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const r = addAll(f, 'anomaly', {
    note: '与校验器分歧：票 01 分支此刻不可见，但 coder 报告工作已完成；停下上报用户',
  });
  assert.equal(r.status, 0, r.stdout);
  const events = readEvents(f);
  assert.equal(events[1].type, 'anomaly');
  assert.match(events[1].payload.note, /分歧/);
});

// ====================================================================
// add：警告档（此刻尚不可核实的 git 事实）——警告不拒绝
// ====================================================================

test('派发时 worktree 尚不可见 → 警告但入账；可见 → 无警告（两档区分）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const invisible = addAll(f, 'dispatch', {
    ticket: '01',
    key: 't-01',
    'run-id': 'aaaaaaaa',
    worktree: '/definitely/not/a/worktree',
  });
  assert.equal(invisible.status, 0, '不可核实 → 警告，不是拒绝');
  assert.match(invisible.stdout, /⚠|警告/);
  assert.ok(readEvents(f)[1].warn.length > 0, '警告应记入事件信封');
  const wt = makeWorktree(f, 'wt-02');
  const visible = addAll(f, 'dispatch', {
    ticket: '02',
    key: 't-02',
    'run-id': 'bbbbbbbb',
    worktree: wt,
  });
  assert.equal(visible.status, 0, visible.stdout);
  assert.doesNotMatch(visible.stdout, /⚠|警告/);
  assert.equal(readEvents(f)[2].warn, undefined);
});

// ====================================================================
// build：四段台账（头部 / 表格 / 时间线 / 对账结论）
// ====================================================================

test('完整一轮：add 链路自动再生台账，四段结构与 11 列表格齐备', (t) => {
  const f = makeFixture(t);
  const baseSha = f.baseline();
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  const wt = makeWorktree(f, 'wt-01');
  assert.equal(addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b', worktree: wt }).status, 0);
  assert.equal(
    addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head, worktree: wt, gate: 'npm test 17/17' }).status,
    0
  );
  assert.equal(
    addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved', 'rev-run-id': 'bbc1daa6' }).status,
    0
  );
  assert.equal(addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge }).status, 0);
  // 按协议收尾（关票 + 清理），否则对账必然报差异：票 Status→resolved、删票分支、移除 coder worktree
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  f.git('worktree remove --force wt-01');
  f.git('branch -D ticket-01');
  const rebuilt = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(rebuilt.status, 0, rebuilt.stdout);

  const md = readLedger(f);
  // 头部：state 与两分立的 base 字段
  assert.match(md, /state: running/);
  assert.match(md, /branch: feat\/demo/);
  assert.match(md, /^branchBase: main/m);
  assert.match(md, new RegExp(`^baselineSha: ${baseSha}`, 'm'));
  // 表格：11 列
  assert.match(
    md,
    /\| ticket \| title \| status \| blockedBy \| coderRunId \| coderWorktree \| branch \| headSha \| mergedIn \| fixes \| escalated \|/
  );
  const row = md.split('\n').find((l) => l.startsWith('| 01 '));
  assert.ok(row, '票 01 应有表格行');
  assert.match(row, /done/);
  assert.match(row, /9ea3e64b/);
  assert.match(row, new RegExp(head.slice(0, 7)));
  assert.match(row, new RegExp(merge.slice(0, 7)));
  assert.match(row, /已清理/, '已移除的 worktree 由真相层标注');
  // 时间线：5 条事件、序号与紧凑时刻
  assert.match(md, /## 时间线/);
  assert.match(md, /\[1\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} init /);
  assert.match(md, /\[5\] .* merge ticket=01/);
  assert.match(md, /revRunId=bbc1daa6/, 'reviewer 的派发与 runId 在时间线有迹可循');
  // 对账结论
  assert.match(md, /## 对账结论/);
  assert.match(md, /账实一致/);
});

test('build 全量再生：删除台账后重跑，产物一致（确定性重建）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  const first = readLedger(f);
  fs.rmSync(f.ledgerPath);
  const r = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readLedger(f), first, 'build 必须从事件流 + 真相层确定性再生');
  assert.match(r.stdout, /state: running/, 'build 把台账全文打到 stdout 供 compaction 恢复读取');
});

test('台账重建是原子的：不留撕裂文件，陈旧临时文件被清走', (t) => {
  const f = makeFixture(t);
  initRun(f);
  fs.writeFileSync(f.ledgerPath + '.tmp', 'stale garbage');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  assert.ok(!fs.existsSync(f.ledgerPath + '.tmp'), '中断不留撕裂文件——陈旧 .tmp 必须消失');
  const md = readLedger(f);
  assert.match(md, /state: running/);
  assert.match(md, /## 时间线/);
  assert.match(md, /## 对账结论/);
  fs.writeFileSync(f.ledgerPath + '.tmp', 'stale garbage');
  const r = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, r.stdout);
  assert.ok(!fs.existsSync(f.ledgerPath + '.tmp'));
});

// ====================================================================
// 降级路径：可见的降级，不静默编造
// ====================================================================

test('事件流丢失 → build 降级再生：git 可导出列保留，平台态列标 unknown 并告警', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  fs.rmSync(f.eventsPath);
  const r = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, '降级再生不失败，但必须可见');
  assert.match(r.stdout, /⚠|警告/);
  const md = readLedger(f);
  assert.match(md, /自检基线/, '票文件可导出的 title 保留');
  assert.match(md, /unknown/, '平台态列（coderRunId 等）标 unknown');
  assert.doesNotMatch(md, /9ea3e64b/, '不得编造丢失的 runId');
});

test('gh 离线 → PR 状态标 unknown；无 remote → none；gh 在线 → 真实状态', (t) => {
  const offline = makeFixture(t, { remote: 'https://github.com/x/y.git' });
  initRun(offline);
  const fakeBin = path.join(offline.dir, 'fakebin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(fakeBin, 'gh'), 0o755);
  let r = ledger(['build', '--runtime-dir', offline.runtime], {
    cwd: offline.dir,
    env: { PATH: `${fakeBin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^pr: unknown/m, 'gh 不可用时标 unknown，不编造');

  const bare = makeFixture(t);
  initRun(bare);
  r = ledger(['build', '--runtime-dir', bare.runtime], { cwd: bare.dir });
  assert.match(r.stdout, /^pr: none/m, '无 remote 不探测 gh');

  const online = makeFixture(t, { remote: 'https://github.com/x/y.git' });
  initRun(online);
  const onlineBin = path.join(online.dir, 'fakebin');
  fs.mkdirSync(onlineBin);
  fs.writeFileSync(
    path.join(onlineBin, 'gh'),
    '#!/bin/sh\necho \'[{"state":"OPEN","isDraft":true}]\'\n'
  );
  fs.chmodSync(path.join(onlineBin, 'gh'), 0o755);
  r = ledger(['build', '--runtime-dir', online.runtime], {
    cwd: online.dir,
    env: { PATH: `${onlineBin}:${process.env.PATH}` },
  });
  assert.match(r.stdout, /^pr: opened-draft/m);
});

// ====================================================================
// check：账实核验
// ====================================================================

test('check：账实一致 → 退出 0；check 无需重建台账', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  f.git('branch -D ticket-01');
  const before = readLedger(f);
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /一致/);
  assert.equal(readLedger(f), before, 'check 只读，不写台账');
});

// ====================================================================
// 票 03：执法与对账闭环（写点执法 / git 交叉核对 / check 差异清单 / 逃生通道）
// ====================================================================

// 在 feat/demo 上制造一个真实提交（执法测试不需要 ticket 分支与 worktree）
function step(f, msg) {
  f.git(`commit -q --allow-empty -m "${msg}"`);
  return f.git('rev-parse HEAD');
}

// 票 01 铺到「第 k 轮评审 changes_requested 后已记账 k 次 fix」的状态
function seedFixes(f, k) {
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  for (let r = 1; r <= k; r++) {
    const sha = step(f, `work r${r}`);
    addAll(f, 'settled', { ticket: '01', round: String(r), 'head-sha': sha });
    addAll(f, 'verdict', {
      ticket: '01',
      round: String(r),
      verdict: 'changes_requested',
      findings: `findings/01-r${r}.md`,
    });
    addAll(f, 'fix', {
      ticket: '01',
      'fix-no': String(r),
      key: `fix-01-r${r + 1}`,
      'resume-run-id': 'aaaaaaaa',
    });
  }
}

test('init 前置核验：spec 文件不存在被拒（未经验证的结论不得进账）', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const r = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/nonexistent/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /spec 文件不存在/);
  assert.ok(!fs.existsSync(f.eventsPath));
});

test('fix 预算：第 2 次 fix 仍准入（边界），第 3 次被拒并提示应升级上报', (t) => {
  const f = makeFixture(t);
  seedFixes(f, 2);
  const third = addAll(f, 'fix', {
    ticket: '01',
    'fix-no': '3',
    key: 'fix-01-r4',
    'resume-run-id': 'aaaaaaaa',
  });
  assert.equal(third.status, 1, '第 3 次 fix 必须在写点被机械拒绝');
  assert.match(third.stdout, /预算已耗尽/);
  assert.match(third.stdout, /escalate/);
  assert.equal(readEvents(f).filter((e) => e.type === 'fix').length, 2, '被拒的 fix 不得入账');
});

test('结算被拒（坏 SHA）不返还预算：计数于派发时刻', (t) => {
  const f = makeFixture(t);
  seedFixes(f, 2);
  const badSettle = addAll(f, 'settled', {
    ticket: '01',
    round: '3',
    'head-sha': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  });
  assert.equal(badSettle.status, 1, 'headSha 不存在是确定矛盾');
  assert.match(badSettle.stdout, /不存在/);
  const third = addAll(f, 'fix', {
    ticket: '01',
    'fix-no': '3',
    key: 'fix-01-r4',
    'resume-run-id': 'aaaaaaaa',
  });
  assert.equal(third.status, 1, '结算被拒也不改变已消耗的修复预算');
});

test('同票同轮 verdict 去重；轮号恒等式（round = fix 数 + 1）交叉核对', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const sha = step(f, 'work r1');
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': sha });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'changes_requested' });
  const dup = addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  assert.equal(dup.status, 1);
  assert.match(dup.stdout, /去重/);
  const skip = addAll(f, 'verdict', { ticket: '01', round: '2', verdict: 'approved' });
  assert.equal(skip.status, 1, '没有任何 fix 事件时 verdict 轮号只能是 1');
  assert.match(skip.stdout, /恒等式/);
  const again = addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  assert.equal(again.status, 1);
  assert.equal(readEvents(f).filter((e) => e.type === 'verdict').length, 1);
});

test('merge 门：无 verdict / 最近 verdict 非 approved 被拒', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  const noVerdict = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  assert.equal(noVerdict.status, 1);
  assert.match(noVerdict.stdout, /verdict/);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'changes_requested' });
  const cr = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  assert.equal(cr.status, 1);
  assert.match(cr.stdout, /changes_requested/);
});

test('merge git 交叉核对：不存在 / 非祖先 / 无令牌 / headSha 非被合并工作，全部矛盾拒绝', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });

  const ghost = addAll(f, 'merge', {
    ticket: '01',
    'head-sha': head,
    'merge-sha': '1234567890abcdef1234567890abcdef12345678',
  });
  assert.equal(ghost.status, 1);
  assert.match(ghost.stdout, /mergeSha/);

  // 存在但不在特性分支历史上的提交（旁支）
  f.git('checkout -q -b stray main');
  const stray = step(f, 'stray work');
  f.git('checkout -q feat/demo');
  const notAncestor = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': stray });
  assert.equal(notAncestor.status, 1);
  assert.match(notAncestor.stdout, /祖先/);

  // 无 ticket-01 令牌的合并提交：从旁支制造一次真实的无令牌合并
  f.git('checkout -q -b stray2 feat/demo');
  step(f, 'stray2 work');
  f.git('checkout -q feat/demo');
  f.git(`merge --no-ff -q -m "chore: combine branches" stray2`);
  const tokenless = f.git('rev-parse HEAD');
  const noToken = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': tokenless });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stdout, /ticket-01 令牌/);

  // headSha 与 mergeSha 对不上（记录的合并与被合并工作不对应）
  const later = step(f, 'post-merge work');
  const mismatch = addAll(f, 'merge', { ticket: '01', 'head-sha': later, 'merge-sha': tokenless });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stdout, /不对应/);
  assert.equal(readEvents(f).filter((e) => e.type === 'merge').length, 0);
});

test('close 门：未闭环任务票阻塞封账并逐票列出', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const blocked = addAll(f, 'close', {});
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /票 01/);
  assert.match(blocked.stdout, /票 02/);
  // 闭环两票：01 走 merge，02 走 escalate
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  addAll(f, 'dispatch', { ticket: '02', key: 't-02', 'run-id': 'bbbbbbbb' });
  const esc = addAll(f, 'escalate', { ticket: '02', note: '两轮修复后仍 changes_requested' });
  assert.equal(esc.status, 0, esc.stdout);
  // 票全闭环后仍缺终审裁决：封账门（票 02）会拒绝，记 final 后方可封账
  assert.equal(addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': '89656ee2-8603-4407-957b-9d7f24e0f364' }).status, 0);
  const ok = addAll(f, 'close', {});
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(readLedger(f), /state: complete/);
});

test('close 非任务票排除：spec 母票与 resolved 研究票不阻塞', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '03', '母票——spec 本体', { status: 'ready-for-agent', type: 'spec' });
  writeTicketFile(f.dir, '04', '对齐调研', { status: 'resolved', type: 'research' });
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  addAll(f, 'escalate', { ticket: '01' });
  addAll(f, 'dispatch', { ticket: '02', key: 't-02', 'run-id': 'bbbbbbbb' });
  addAll(f, 'escalate', { ticket: '02' });
  const ok = addAll(f, 'close', {});
  assert.equal(ok.status, 0, `非任务票不应阻塞封账：${ok.stdout}`);
});

test('封账后拒绝一切记账；close 不可重复', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  addAll(f, 'escalate', { ticket: '01' });
  addAll(f, 'dispatch', { ticket: '02', key: 't-02', 'run-id': 'bbbbbbbb' });
  addAll(f, 'escalate', { ticket: '02' });
  assert.equal(addAll(f, 'close', {}).status, 0);
  const after = addAll(f, 'anomaly', { note: '封账后发现遗漏' });
  assert.equal(after.status, 1, '封账后不再接受任何事件');
  assert.match(after.stdout, /封账/);
  const again = addAll(f, 'close', {});
  assert.equal(again.status, 1);
});

test('事件流丢失时的执法降级：拒绝无记忆的续写', (t) => {
  const f = makeFixture(t);
  initRun(f);
  fs.rmSync(f.eventsPath);
  const r = addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /init/);
});

test('check：仅派发未结算的票不要求 ticket 分支存在（派发时分支尚未锚定）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, `派发后、结算前不应有分支差异：${r.stdout}`);
});

test('check：已锚定票的分支被删 → 非零退出 + 差异清单', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const sha = step(f, 'work');
  f.git(`branch ticket-01 ${sha}`);
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': sha });
  assert.equal(ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir }).status, 0);
  f.git('branch -D ticket-01');
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1, '账实不符必须非零退出');
  assert.match(r.stdout, /票 01 未合并但分支 ticket-01 不存在/);
});

test('check：票文件 Status 与账不符 → 逐条差异', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  f.git('branch -D ticket-01');
  // 账上有 merge，票文件仍是 ready-for-agent
  let r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /票 01 文件 Status 为 ready-for-agent，账上已有 merge（应 resolved）/);
  // 反向：文件 resolved 而账上无 merge/escalate（票 02）
  writeTicketFile(f.dir, '02', 'README 速览', { status: 'resolved', blockedBy: '01' });
  r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /票 02 文件 Status 为 resolved，账上无 merge\/escalate 事件/);
});

test('check：git 有合并提交而事件流无 merge 事件 → 差异（表格停在中间态不可再现）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  mergeTicket(f, '01'); // 真相层有合并提交，但故意不记账
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /git 有票 01 的合并提交/);
});

test('check：事件流被手改（序号跳变）→ 差异；损坏 JSON → 三个子命令全部拒绝', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const tampered = fs
    .readFileSync(f.eventsPath, 'utf8')
    .replace('"seq":2', '"seq":9');
  fs.writeFileSync(f.eventsPath, tampered);
  let r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /seq=9/);
  fs.writeFileSync(f.eventsPath, tampered + '{corrupt\n');
  for (const cmd of ['add', 'build', 'check']) {
    const args = cmd === 'add' ? ['add', 'settled', '--runtime-dir', f.runtime, '--ticket', '01', '--round', '1', '--head-sha', f.baseline()] : [cmd, '--runtime-dir', f.runtime];
    r = ledger(args, { cwd: f.dir });
    assert.equal(r.status, 1, `${cmd} 必须拒绝损坏的事件流`);
    assert.match(r.stdout, /不是合法 JSON/);
  }
});

// ====================================================================
// 评审发现回归：事件流里的票若没有票文件，台账不得静默吞掉（全量再生保证）
// ====================================================================

test('事件流里的票没有票文件：表格有行、对账报缺失、封账被阻塞', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '07', key: 't-07', 'run-id': 'cccccccc' });
  let r = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\| 07 \| \(票文件缺失\) \|/, 'event-only 票必须有表格行');
  r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /票 07 在事件流中出现，但票文件缺失/);
  const close = addAll(f, 'close', {});
  assert.equal(close.status, 1, 'event-only 票无 merge/escalate，必须阻塞封账');
  assert.match(close.stdout, /票 07/);
});

// ====================================================================
// 流程形态快照（init 旗标）：reviewer 开关 / 修复预算参数化
// ====================================================================

test('reviewer=off：verdict/fix 被拒、merge 无 verdict 放行、台账 header 标注形态', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const r = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
    reviewer: 'off',
    'max-concurrent': '5',
  });
  assert.equal(r.status, 0, r.stdout);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const sha = step(f, 'work r1');
  assert.equal(addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': sha }).status, 0);
  const v = addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  assert.equal(v.status, 1, 'off 形态不得记 verdict');
  assert.match(v.stdout, /reviewer=off/);
  const fix = addAll(f, 'fix', { ticket: '01', 'fix-no': '1', key: 'fix-01-r2', 'resume-run-id': 'bbbbbbbb' });
  assert.equal(fix.status, 1, 'off 形态不得记 fix');
  assert.match(fix.stdout, /reviewer=off/);
  const { head, merge } = mergeTicket(f, '01');
  const m = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  assert.equal(m.status, 0, 'off 形态 merge 无需 verdict——平台测试门 + 集成门是仅存防线');
  const md = readLedger(f);
  assert.match(md, /flow: reviewer=off, maxFixRounds=2, maxConcurrent=5/);
  assert.match(md, /reviewer=off maxConcurrent=5/, 'init 时间线行带快照旗标（缺省旗标不进 payload，header 显示补全后的形态）');
});

test('maxFixRounds=3：init 快照放宽预算，第 3 次 fix 可入账，第 4 次拒绝', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const r = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
    'max-fix-rounds': '3',
  });
  assert.equal(r.status, 0, r.stdout);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const sha = step(f, 'work r1');
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': sha });
  assert.equal(addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'changes_requested' }).status, 0);
  assert.equal(addAll(f, 'fix', { ticket: '01', 'fix-no': '1', key: 'fix-01-r2', 'resume-run-id': 'bbbbbbbb' }).status, 0);
  assert.equal(addAll(f, 'fix', { ticket: '01', 'fix-no': '2', key: 'fix-01-r3', 'resume-run-id': 'cccccccc' }).status, 0);
  assert.equal(addAll(f, 'fix', { ticket: '01', 'fix-no': '3', key: 'fix-01-r4', 'resume-run-id': 'dddddddd' }).status, 0);
  const fourth = addAll(f, 'fix', { ticket: '01', 'fix-no': '4', key: 'fix-01-r5', 'resume-run-id': 'eeeeeeee' });
  assert.equal(fourth.status, 1, '快照预算耗尽必须拒绝');
  assert.match(fourth.stdout, /上限 3/);
});

test('init 非法快照值被 schema 拒绝（枚举 / 正整数）', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const base = {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
  };
  assert.equal(addAll(f, 'init', { ...base, reviewer: 'maybe' }).status, 1);
  assert.equal(addAll(f, 'init', { ...base, 'max-fix-rounds': '0' }).status, 1);
  assert.equal(addAll(f, 'init', { ...base, 'max-concurrent': 'x' }).status, 1);
  assert.ok(!fs.existsSync(f.eventsPath), '三条全部未入账——事件流文件都未创建');
});

// ====================================================================
// 票 01：final 事件——整分支终审裁决入账（schema / 校验 / 时间线 / --help）
// ====================================================================

const FINAL_RUN_ID = '89656ee2-8603-4407-957b-9d7f24e0f364';

test('add final: 三值裁决全部入账，事件行含信封四件套（v=3 / 单调序号 / 权威时间戳 / HEAD 锚点）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  for (const verdict of ['ready', 'ready_with_fixes', 'not_ready']) {
    const r = addAll(f, 'final', { 'final-verdict': verdict, 'run-id': FINAL_RUN_ID });
    assert.equal(r.status, 0, r.stdout);
  }
  const finals = readEvents(f).filter((e) => e.type === 'final');
  assert.equal(finals.length, 3, '三值裁决各入账一条');
  assert.deepEqual(
    finals.map((e) => e.payload.finalVerdict),
    ['ready', 'ready_with_fixes', 'not_ready']
  );
  assert.deepEqual(
    finals.map((e) => e.seq),
    [2, 3, 4],
    '序号由脚本单调盖章'
  );
  const head = f.git('rev-parse HEAD');
  for (const e of finals) {
    assert.equal(e.v, 3, '事件分类学演进 → 信封版本升为 3（旧账按 v 识别）');
    assert.equal(e.payload.runId, FINAL_RUN_ID);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '权威时间戳由脚本盖');
    assert.equal(e.head, head, '写入时刻 HEAD 锚点由脚本盖');
  }
});

test('add final: 缺 --run-id / 非法裁决值 / 未知旗标 / 空旗标值 → 非零退出 + 中文原因 + 不入账', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const before = readLedger(f);
  const cases = [
    {
      name: '缺 --run-id',
      args: ['add', 'final', '--runtime-dir', f.runtime, '--final-verdict', 'ready'],
      reason: /缺少必选参数 --run-id/,
    },
    {
      name: '非法裁决值',
      args: ['add', 'final', '--runtime-dir', f.runtime, '--final-verdict', 'approved', '--run-id', FINAL_RUN_ID],
      reason: /finalVerdict 必须是 ready \| ready_with_fixes \| not_ready/,
    },
    {
      name: '未知旗标',
      args: ['add', 'final', '--runtime-dir', f.runtime, '--final-verdict', 'ready', '--run-id', FINAL_RUN_ID, '--force', 'true'],
      reason: /未知旗标 --force/,
    },
    {
      name: '空旗标值',
      args: ['add', 'final', '--runtime-dir', f.runtime, '--final-verdict=', '--run-id', FINAL_RUN_ID],
      reason: /旗标 --final-verdict 的值为空/,
    },
    {
      name: '旗标缺值',
      args: ['add', 'final', '--runtime-dir', f.runtime, '--run-id', FINAL_RUN_ID, '--final-verdict'],
      reason: /旗标 --final-verdict 缺少值/,
    },
  ];
  for (const c of cases) {
    const r = ledger(c.args, { cwd: f.dir });
    assert.equal(r.status, 1, `${c.name} 必须被拒绝：${r.stdout}`);
    assert.match(r.stdout, /拒绝/, c.name);
    assert.match(r.stdout, c.reason, c.name);
  }
  assert.equal(readEvents(f).length, 1, '被拒的 final 不得入账');
  assert.equal(readLedger(f), before, '被拒的记账不得触发台账再生');
});

test('add final: 尚无 merge 事件 → 警告入账（warn 字段可见，不拒绝）；已有 merge → 无警告', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const early = addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID });
  assert.equal(early.status, 0, `流程异常非事实矛盾——警告不拒绝：${early.stdout}`);
  assert.match(early.stdout, /⚠/, '警告必须打在 stdout 上，编排器当场可见');
  const earlyEvent = readEvents(f).at(-1);
  assert.equal(earlyEvent.type, 'final');
  assert.ok(earlyEvent.warn?.length, '警告应记入事件信封（warn 字段）');
  assert.match(earlyEvent.warn.join('；'), /merge/);
  assert.match(readLedger(f), /⚠.*merge/, '台账时间线同步可见警告');

  // 铺一票到 merge 之后：终审发生在闭环之后，不应再有该警告
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  const m = addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  assert.equal(m.status, 0, m.stdout);
  const late = addAll(f, 'final', { 'final-verdict': 'ready_with_fixes', 'run-id': FINAL_RUN_ID });
  assert.equal(late.status, 0, late.stdout);
  assert.doesNotMatch(late.stdout, /⚠/, '有 merge 的 run 记 final 无流程异常警告');
  assert.equal(readEvents(f).at(-1).warn, undefined);
});

test('add final: 多轮终审各记一条——同裁决同 runId 也照常入账（无同事件去重）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const round = { 'final-verdict': 'ready_with_fixes', 'run-id': FINAL_RUN_ID };
  const first = addAll(f, 'final', { ...round, findings: 'findings/final-r1.md' });
  const second = addAll(f, 'final', { ...round, findings: 'findings/final-r2.md' });
  assert.equal(first.status, 0, first.stdout);
  assert.equal(second.status, 0, `多轮终审不去重（seq 顺序即轮次）：${second.stdout}`);
  const finals = readEvents(f).filter((e) => e.type === 'final');
  assert.deepEqual(
    finals.map((e) => [e.seq, e.payload.findings]),
    [
      [2, 'findings/final-r1.md'],
      [3, 'findings/final-r2.md'],
    ]
  );
});

test('add final: 封账后拒记（封账拒一切事件的既有语义对新事件同样生效）', (t) => {
  const f = makeFixture(t);
  initRun(f);
  for (const num of ['01', '02']) {
    addAll(f, 'dispatch', { ticket: num, key: `t-${num}`, 'run-id': 'aaaaaaaa' });
    addAll(f, 'escalate', { ticket: num });
  }
  assert.equal(addAll(f, 'close', {}).status, 0);
  const r = addAll(f, 'final', { 'final-verdict': 'not_ready', 'run-id': FINAL_RUN_ID });
  assert.equal(r.status, 1, '封账后不再接受任何事件');
  assert.match(r.stdout, /封账/);
  assert.equal(readEvents(f).filter((e) => e.type === 'final').length, 0);
});

test('台账时间线逐条渲染 final：紧凑裁决形式 + runId 短码，无键名 stutter', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'final', {
    'final-verdict': 'ready_with_fixes',
    'run-id': FINAL_RUN_ID,
    findings: 'findings/final-r1.md',
    note: '修复后重审',
  });
  addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID });
  const md = readLedger(f);
  const lines = md.split('\n').filter((l) => /^- \[\d+\] .* final /.test(l));
  assert.equal(lines.length, 2, '多轮终审逐条渲染');
  assert.match(
    lines[0],
    /\[2\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} final verdict=ready_with_fixes runId=89656ee2 findings=findings\/final-r1\.md note="修复后重审"/
  );
  assert.match(lines[1], /\[3\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} final verdict=ready runId=89656ee2( |$).*$/);
  assert.doesNotMatch(md, /finalVerdict=/, '紧凑形式：final finalVerdict=… 键名 stutter 不得出现');
  assert.doesNotMatch(md, new RegExp(FINAL_RUN_ID), '时间线显示 runId 短码（前 8 位）');
});

test('--help 的事件清单与参数说明含 final 与旗标集（记账语法不靠会话记忆）', (t) => {
  const r = ledger(['--help'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stdout);
  assert.match(
    r.stdout,
    /^\s+final\s+--final-verdict\(ready\|ready_with_fixes\|not_ready\) --run-id <runId> \[--findings\] \[--note\]$/m
  );
  assert.match(r.stdout, /runId 必选/, '帮助必须说明 runId 为何必选，而不是只列旗标');
  assert.match(r.stdout, /终审/);
});

test('add final: reviewer=off 的运行终审照跑照记（final 不进流程形态快照）', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const init = addAll(f, 'init', {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    tracker: 'local',
    reviewer: 'off',
  });
  assert.equal(init.status, 0, init.stdout);
  const r = addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID });
  assert.equal(r.status, 0, `终审不随流程形态开关漂移：${r.stdout}`);
  assert.equal(readEvents(f).filter((e) => e.type === 'final').length, 1);
});

// ====================================================================
// 票 02：封账门（分层）与终审可见性——close 三态 / 头部 final: 行 / check 证据核验
// ====================================================================

const FINAL_RUN_ID_2 = 'f1cea05a-0d3b-4f8e-9a11-2c6b7d8e9f01';

// 「一票合并 + 一票升级」的完整运行（票全闭环，尚不封账）：封账门三态与终审可见性的共同前置。
// 终审在该状态之后才发生，故此后记 final 不会有「尚无 merge」的流程异常警告。
function completeRun(f) {
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  addAll(f, 'dispatch', { ticket: '02', key: 't-02', 'run-id': 'bbbbbbbb' });
  addAll(f, 'escalate', { ticket: '02' });
  writeTicketFile(f.dir, '02', 'README 速览', { status: 'escalated', blockedBy: '01' });
  f.git('branch -D ticket-01');
  return { head, merge };
}

// 伪造平台证据：HOME 指向 fixture 目录。会话产物目录约定与审计工具同源——
//   <HOME>/.pi/agent/sessions/--<仓库路径各段以 '-' 连接>--/subagent-artifacts/<runId>_*
// 不传 repoDir = 连会话根都没有的 home（证据完全不可核验）；传了 repoDir 但不给 runIds =
// 目录在、该 runId 的产物不在（已被清理）。
function fakeHome(t, { repoDir = null, runIds = [] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (!repoDir) return home;
  const dir = path.join(
    home,
    '.pi/agent/sessions',
    `--${fs.realpathSync(repoDir).split(path.sep).filter(Boolean).join('-')}--`,
    'subagent-artifacts'
  );
  fs.mkdirSync(dir, { recursive: true });
  for (const id of runIds) {
    fs.writeFileSync(path.join(dir, `${id}_meta.json`), JSON.stringify({ agent: 'final-reviewer', exitCode: 0 }));
    fs.writeFileSync(path.join(dir, `${id}_output.md`), '# final review\n');
  }
  return home;
}

test('close 门：有 merge 无 final → 拒绝，拒绝消息同时列出票闭环缺口与终审缺口', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': '9ea3e64b' });
  addAll(f, 'settled', { ticket: '01', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '01', round: '1', verdict: 'approved' });
  addAll(f, 'merge', { ticket: '01', 'head-sha': head, 'merge-sha': merge });
  // 票 02 未闭环 + 尚无终审裁决：两个缺口必须出现在同一条拒绝消息里
  const r = addAll(f, 'close', {});
  assert.equal(r.status, 1);
  assert.match(r.stdout, /票 02/, '票闭环缺口照旧逐票列出');
  assert.match(r.stdout, /终审/, '终审缺口与票闭环缺口合并给出');
  assert.match(r.stdout, /final/, '拒绝消息给出补救动作（记账 final）');
  assert.ok(!readEvents(f).some((e) => e.type === 'close'), '被拒的 close 不得入账');
});

test('close 门：有 merge 无 final 且票已全闭环 → 仍拒绝（终审缺口单独成因）', (t) => {
  const f = makeFixture(t);
  completeRun(f);
  const r = addAll(f, 'close', {});
  assert.equal(r.status, 1, '封账门：有合并工作的运行须已有终审裁决入账');
  assert.match(r.stdout, /终审/);
  assert.doesNotMatch(r.stdout, /未闭环/, '票已全闭环，不应再报票闭环缺口');
  assert.ok(!readEvents(f).some((e) => e.type === 'close'));
});

test('close 门：latest=not_ready → 警告放行，台账标注警告', (t) => {
  const f = makeFixture(t);
  completeRun(f);
  const fin = addAll(f, 'final', {
    'final-verdict': 'not_ready',
    'run-id': FINAL_RUN_ID,
    note: '跨票漂移未修完，用户拍板放弃',
  });
  assert.equal(fin.status, 0, fin.stdout);
  const r = addAll(f, 'close', {});
  assert.equal(r.status, 0, `放弃是合法出口——封账放行：${r.stdout}`);
  assert.match(r.stdout, /⚠/, '警告必须打在 stdout 上，编排器当场可见');
  assert.match(r.stdout, /not_ready/);
  const closeEvent = readEvents(f).at(-1);
  assert.equal(closeEvent.type, 'close');
  assert.match(String(closeEvent.warn), /not_ready/, '警告记入封账事件信封（warn 字段）');
  const md = readLedger(f);
  assert.match(md, /^state: complete/m);
  assert.match(md, /⚠[^\n]*not_ready/, '台账（时间线）可见封账警告标注');
});

test('close 门：latest∈{ready, ready_with_fixes} → 正常放行、无终审警告', (t) => {
  for (const verdict of ['ready', 'ready_with_fixes']) {
    const f = makeFixture(t);
    completeRun(f);
    const fin = addAll(f, 'final', { 'final-verdict': verdict, 'run-id': FINAL_RUN_ID });
    assert.equal(fin.status, 0, fin.stdout);
    const r = addAll(f, 'close', {});
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /⚠/, `latest=${verdict} 视为已过终审，不得有终审警告`);
    assert.equal(readEvents(f).filter((e) => e.type === 'final').length, 1);
  }
});

test('close 门：零 merge（全 escalate）无 final → 正常放行，无终审相关警告', (t) => {
  const f = makeFixture(t);
  initRun(f);
  for (const num of ['01', '02']) {
    addAll(f, 'dispatch', { ticket: num, key: `t-${num}`, 'run-id': 'aaaaaaaa' });
    addAll(f, 'escalate', { ticket: num });
  }
  const r = addAll(f, 'close', {});
  assert.equal(r.status, 0, `无 merge 就没有终审环节——封账不检查：${r.stdout}`);
  assert.doesNotMatch(r.stdout, /终审|final/, '零合并票的运行封账不产生终审相关消息');
  assert.match(readLedger(f), /^state: complete/m);
});

test('close 门：零 merge 的运行即使记过 not_ready 终审 → 封账不检查终审、无终审警告', (t) => {
  const f = makeFixture(t);
  initRun(f);
  for (const num of ['01', '02']) {
    addAll(f, 'dispatch', { ticket: num, key: `t-${num}`, 'run-id': 'aaaaaaaa' });
    addAll(f, 'escalate', { ticket: num });
  }
  addAll(f, 'final', { 'final-verdict': 'not_ready', 'run-id': FINAL_RUN_ID });
  const r = addAll(f, 'close', {});
  assert.equal(r.status, 0, `零合并票的运行封账不检查终审：${r.stdout}`);
  assert.doesNotMatch(r.stdout, /⚠/, '零合并票的运行封账不得产生终审警告');
});

test('台账头部 final: 行：多轮取最新裁决与 runId 短码；无 final 显示 none（与 pr: 行对称）', (t) => {
  const f = makeFixture(t);
  completeRun(f);
  let md = readLedger(f);
  assert.match(md, /^pr: [^\n]*\nfinal: none$/m, '无 final 事件时按最小形态显示 none，紧跟 pr: 行');

  addAll(f, 'final', { 'final-verdict': 'ready_with_fixes', 'run-id': FINAL_RUN_ID });
  md = readLedger(f);
  assert.match(md, /^final: ready_with_fixes \(89656ee2\)$/m, '短码取 runId 前 8 位');

  addAll(f, 'final', { 'final-verdict': 'not_ready', 'run-id': FINAL_RUN_ID_2 });
  md = readLedger(f);
  assert.match(md, /^final: not_ready \(f1cea05a\)$/m, '多轮终审一律取最新裁决');
  assert.doesNotMatch(md, /^final: .*89656ee2/m, '头部只显示最新一条裁决');
});

test('check 正路径：HOME 指向伪造平台证据 fixture → 证据可核验、零警告、退出码 0', (t) => {
  const f = makeFixture(t);
  completeRun(f);
  assert.equal(addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID }).status, 0);
  assert.equal(addAll(f, 'close', {}).status, 0);
  const home = fakeHome(t, { repoDir: f.dir, runIds: [FINAL_RUN_ID] });
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: home } });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.stdout, /⚠/, `证据在手时不得有任何警告：${r.stdout}`);
});

test('check 负路径：终审 runId 证据缺失/不可核验 → 一条警告、退出码 0（不误杀不可核验的账）', (t) => {
  const f = makeFixture(t);
  completeRun(f);
  assert.equal(addAll(f, 'final', { 'final-verdict': 'ready', 'run-id': FINAL_RUN_ID }).status, 0);
  assert.equal(addAll(f, 'close', {}).status, 0);

  // 目录在、该 runId 的产物不在（已被清理）
  const cleaned = fakeHome(t, { repoDir: f.dir });
  let r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: cleaned } });
  assert.equal(r.status, 0, `证据缺失不得影响退出码：${r.stdout}`);
  assert.equal((r.stdout.match(/⚠/g) ?? []).length, 1, '证据缺失逐条可见（此处一条）');
  assert.match(r.stdout, /终审/);
  assert.match(r.stdout, /89656ee2/, '警告点出是哪个 runId 的证据');

  // 连会话根都不存在（不可核验）
  const bare = fakeHome(t);
  r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: bare } });
  assert.equal(r.status, 0, `不可核验不得影响退出码：${r.stdout}`);
  assert.equal((r.stdout.match(/⚠/g) ?? []).length, 1, '不可核验逐条可见（此处一条）');
  assert.match(r.stdout, /终审/);
});

test('旧账兼容：无 final 事件的完整旧账（v=1 信封）build/check 零新增报错、零新增警告', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const { head, merge } = mergeTicket(f, '01');
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  writeTicketFile(f.dir, '02', 'README 速览', { status: 'escalated', blockedBy: '01' });
  // 手写工具升级前的旧账：v=1 信封、无 final 事件（升级后的脚本不得对它新增报错或警告）
  const ts = (i) => new Date(Date.UTC(2026, 8, 18, 3, i, 0)).toISOString();
  const legacy = [
    { v: 1, seq: 1, ts: ts(0), head: f.baseline(), type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: f.baseline(), spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local' } },
    { v: 1, seq: 2, ts: ts(1), head, type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: '9ea3e64b' } },
    { v: 1, seq: 3, ts: ts(2), head, type: 'settled', payload: { ticket: '01', round: 1, headSha: head } },
    { v: 1, seq: 4, ts: ts(3), head, type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'approved' } },
    { v: 1, seq: 5, ts: ts(4), head: merge, type: 'merge', payload: { ticket: '01', headSha: head, mergeSha: merge } },
    { v: 1, seq: 6, ts: ts(5), head, type: 'escalate', payload: { ticket: '02', note: '两轮修复后仍 changes_requested' } },
    { v: 1, seq: 7, ts: ts(6), head, type: 'close', payload: {} },
  ];
  fs.writeFileSync(f.eventsPath, legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const check = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: fakeHome(t) } });
  assert.equal(check.status, 0, `旧账 check 必须照旧零差异：${check.stdout}`);
  assert.doesNotMatch(check.stdout, /⚠/, '旧账不得新增警告');
  assert.doesNotMatch(check.stdout, /✗/, '旧账不得新增报错');

  const build = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: fakeHome(t) } });
  assert.equal(build.status, 0, build.stdout);
  assert.doesNotMatch(build.stdout, /⚠/, '旧账 build 不得新增警告');
  assert.doesNotMatch(build.stdout, /✗/, '旧账 build 不得新增报错');
  assert.match(build.stdout, /^state: complete/m);
  assert.match(build.stdout, /^final: none$/m, '旧账无 final 事件 → 头部按最小形态显示 none');
  assert.match(build.stdout, /账实一致/);
});

// ====================================================================
// 票 03：anomaly refSeq 联动与信封 v3
// ====================================================================

test('add anomaly --ref-seq N：正常入账（payload 含 refSeq），时间线渲染 ↩ ref-seq N；无 refSeq 行零变化', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  const r = addAll(f, 'anomaly', {
    note: 'seq=2 的 dispatch 字段被 shell 变量污染；下一条 dispatch 为修正记录',
    'ref-seq': '2',
  });
  assert.equal(r.status, 0, r.stdout);
  const anomaly = readEvents(f).at(-1);
  assert.equal(anomaly.type, 'anomaly');
  assert.equal(anomaly.seq, 3);
  assert.equal(anomaly.v, 3, '信封版本随分类学演进（refSeq 联动 → v=3）');
  assert.equal(anomaly.payload.refSeq, '2', 'refSeq 指向既有事件序号（旗标值原样入账，与 round 同）');
  assert.match(anomaly.payload.note, /污染/);

  const md = readLedger(f);
  const line3 = md.split('\n').find((l) => l.startsWith('- [3] '));
  assert.ok(line3, '时间线应有 anomaly 行');
  assert.ok(
    line3.endsWith(
      'anomaly ↩ ref-seq 2 note=seq=2 的 dispatch 字段被 shell 变量污染；下一条 dispatch 为修正记录' +
        ' note="seq=2 的 dispatch 字段被 shell 变量污染；下一条 dispatch 为修正记录"'
    ),
    `补正链指针必须渲染在 anomaly 行上：${line3}`
  );

  // 不带 refSeq 的 anomaly：渲染与升级前逐字一致（默认 payload 展开形态原样保留）
  assert.equal(addAll(f, 'anomaly', { note: '无关异常，不指向任何事件' }).status, 0);
  const line4 = readLedger(f).split('\n').find((l) => l.startsWith('- [4] '));
  assert.ok(
    line4.endsWith('anomaly note=无关异常，不指向任何事件 note="无关异常，不指向任何事件"'),
    `无 refSeq 的行渲染零变化：${line4}`
  );
});

test('--help：anomaly 用法行含 --ref-seq，并说明 refSeq 指向既有事件的语义', (t) => {
  const r = ledger(['--help'], { cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^\s+anomaly\s+--note \[--ref-seq N\]$/m);
  assert.match(r.stdout, /refSeq/);
  assert.match(r.stdout, /正整数/);
  assert.match(r.stdout, /小于/);
});

test('add anomaly --ref-seq 三重拒绝：非正整数 / 不小于当前序号 / 绕过旗标 → 非零退出 + 中文原因 + 不入账', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const before = readLedger(f);
  const base = ['add', 'anomaly', '--runtime-dir', f.runtime, '--note', '指向性异常'];
  const cases = [
    { name: '非正整数 0', args: [...base, '--ref-seq', '0'], reason: /refSeq 必须是正整数/ },
    { name: '非正整数（非数字）', args: [...base, '--ref-seq', 'abc'], reason: /refSeq 必须是正整数/ },
    { name: '不小于当前序号（自身序号）', args: [...base, '--ref-seq', '2'], reason: /refSeq=2 不小于当前序号 2/ },
    { name: '不小于当前序号（未来序号）', args: [...base, '--ref-seq', '99'], reason: /refSeq=99 不小于当前序号 2/ },
    { name: '绕过旗标', args: [...base, '--ref-seq', '1', '--force', 'true'], reason: /未知旗标 --force/ },
  ];
  for (const c of cases) {
    const r = ledger(c.args, { cwd: f.dir });
    assert.equal(r.status, 1, `${c.name} 必须被拒绝：${r.stdout}`);
    assert.match(r.stdout, /拒绝/, c.name);
    assert.match(r.stdout, c.reason, c.name);
  }
  assert.equal(readEvents(f).length, 1, '被拒的 anomaly 不得入账');
  assert.equal(readLedger(f), before, '被拒的记账不得触发台账再生');
});

test('add anomaly --ref-seq 指向不存在事件（事件流序号有洞）→ 拒绝 + 不入账；洞之外的既有事件仍可指向', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  // 手工制造序号洞（模拟 append-only 被破坏的账）：第二行 seq 2 → 3
  const events = readEvents(f);
  events[1].seq = 3;
  fs.writeFileSync(f.eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  const before = readEvents(f);
  const r = addAll(f, 'anomaly', { note: '指向洞里的 seq 2', 'ref-seq': '2' });
  assert.equal(r.status, 1, `悬空 refSeq 必须拒绝：${r.stdout}`);
  assert.match(r.stdout, /拒绝/);
  assert.match(r.stdout, /refSeq=2 指向的事件不存在/);
  assert.deepEqual(readEvents(f), before, '被拒的 anomaly 不得入账');

  // 校验看的是「对应事件存在」而非「序号连续」：洞之外的既有事件照常可指向
  const ok = addAll(f, 'anomaly', { note: '指向 seq 3', 'ref-seq': '3' });
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(readEvents(f).at(-1).payload.refSeq, '3');
});

test('check 对账：refSeq 越界/悬空 → 账实差异；合法 refSeq 零差异', (t) => {
  const f = makeFixture(t);
  initRun(f);
  addAll(f, 'dispatch', { ticket: '01', key: 't-01', 'run-id': 'aaaaaaaa' });
  assert.equal(addAll(f, 'anomaly', { note: '污染留痕', 'ref-seq': '2' }).status, 0);

  const good = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(good.status, 0, `合法 refSeq 不得新增差异：${good.stdout}`);
  assert.match(good.stdout, /账实一致/);

  // 手改事件流：refSeq 指向未来序号（越界）——写点拒绝后的漏网之鱼靠 check 暴露
  const future = readEvents(f);
  future[2].payload.refSeq = 99;
  fs.writeFileSync(f.eventsPath, future.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r1 = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r1.status, 1, `越界 refSeq 必须判为账实差异：${r1.stdout}`);
  assert.match(r1.stdout, /账实差异/);
  assert.match(r1.stdout, /第 3 行 anomaly 的 refSeq=99 不是指向既有事件/);
  assert.match(r1.stdout, /小于自身序号 3/);

  // 手改事件流：制造序号洞，refSeq 指向洞里（悬空）
  const holed = readEvents(f);
  holed[1].seq = 5;
  holed[2].payload.refSeq = 2;
  fs.writeFileSync(f.eventsPath, holed.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r2 = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r2.status, 1, `悬空 refSeq 必须判为账实差异：${r2.stdout}`);
  assert.match(r2.stdout, /第 3 行 anomaly 的 refSeq=2 不是指向既有事件/);
});

test('旧账兼容：v=2 信封（含 final 事件、无 refSeq）的完整旧账 build/check 零新增差异', (t) => {
  const f = makeFixture(t);
  initRun(f);
  const base = f.baseline();
  const { head, merge } = mergeTicket(f, '01');
  writeTicketFile(f.dir, '01', '自检基线', { status: 'resolved' });
  writeTicketFile(f.dir, '02', 'README 速览', { status: 'escalated', blockedBy: '01' });
  // 手写升级前的旧账：v=2 信封（final 已入流）、anomaly 仍是散文时代形态（无 refSeq）
  const ts = (i) => new Date(Date.UTC(2026, 8, 20, 3, i, 0)).toISOString();
  const legacy = [
    { v: 2, seq: 1, ts: ts(0), head: base, type: 'init', payload: { branch: 'feat/demo', branchBase: 'main', baselineSha: base, spec: '.scratch/demo/spec.md', testCommand: 'npm test', tracker: 'local' } },
    { v: 2, seq: 2, ts: ts(1), head, type: 'dispatch', payload: { ticket: '01', key: 't-01', runId: '9ea3e64b' } },
    { v: 2, seq: 3, ts: ts(2), head, type: 'settled', payload: { ticket: '01', round: 1, headSha: head } },
    { v: 2, seq: 4, ts: ts(3), head, type: 'verdict', payload: { ticket: '01', round: 1, verdict: 'approved' } },
    { v: 2, seq: 5, ts: ts(4), head: merge, type: 'merge', payload: { ticket: '01', headSha: head, mergeSha: merge } },
    { v: 2, seq: 6, ts: ts(5), head, type: 'anomaly', payload: { note: '散文时代的异常留痕（无 refSeq）' } },
    { v: 2, seq: 7, ts: ts(6), head, type: 'final', payload: { finalVerdict: 'ready', runId: FINAL_RUN_ID } },
    { v: 2, seq: 8, ts: ts(7), head, type: 'escalate', payload: { ticket: '02' } },
    { v: 2, seq: 9, ts: ts(8), head, type: 'close', payload: {} },
  ];
  fs.writeFileSync(f.eventsPath, legacy.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const home = fakeHome(t, { repoDir: f.dir, runIds: [FINAL_RUN_ID] });

  const check = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: home } });
  assert.equal(check.status, 0, `v=2 旧账 check 必须照旧零差异：${check.stdout}`);
  assert.doesNotMatch(check.stdout, /⚠/, 'v=2 旧账不得新增警告');
  assert.doesNotMatch(check.stdout, /✗/, 'v=2 旧账不得新增报错');

  const build = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir, env: { HOME: home } });
  assert.equal(build.status, 0, build.stdout);
  assert.doesNotMatch(build.stdout, /⚠/, 'v=2 旧账 build 不得新增警告');
  assert.doesNotMatch(build.stdout, /✗/, 'v=2 旧账 build 不得新增报错');
  assert.match(build.stdout, /^final: ready \(89656ee2\)$/m, 'v=2 的 final 事件照旧识别');
  assert.match(build.stdout, /账实一致/);
  assert.match(
    build.stdout,
    /\[6\] .* anomaly note=散文时代的异常留痕（无 refSeq） note="散文时代的异常留痕（无 refSeq）"$/m,
    '无 refSeq 的 anomaly 行渲染逐字不变（默认 payload 展开形态）'
  );
  assert.doesNotMatch(build.stdout, /↩/, '旧账不得凭空长出补正链指针');
});

// ====================================================================
// 票号空间：tracker 原生编号（ADR-0004，ticket 01）
// 归一化唯一转换点（normalizeTicket）：写入（--ticket / Blocked by 行）与核验（merge 令牌
// 提取）共用；四位以上 issue number 正常入账，1–9 号补零显示为 01–09，混位数按数值排序。
// ====================================================================

test('票号空间：四位以上的 tracker 原生票号正常归一化入账（payload 存归一形态）', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '1042', '大号票');
  initRun(f);
  const r = addAll(f, 'dispatch', { ticket: '1042', key: 't-1042', 'run-id': 'aaaaaaaa' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readEvents(f).at(-1).payload.ticket, '1042', '写入侧：1042 经单一转换点入账为 1042');
  assert.match(r.stdout, /ticket=1042/);
});

test('票号空间：仍拒绝非数字与非法形态（非数字 / 小数 / 负数 / 超位数上限），拒绝不入账', (t) => {
  const f = makeFixture(t);
  initRun(f);
  for (const bad of ['abc', '1.5', '-1', '1234567']) {
    const r = addAll(f, 'dispatch', { ticket: bad, key: 't-bad', 'run-id': 'aaaaaaaa' });
    assert.equal(r.status, 1, `非法票号 ${bad} 必须被拒`);
    assert.match(r.stdout, /票号数字/);
  }
  assert.equal(readEvents(f).length, 1, '只有 init 一条——被拒载荷全部不入账');
});

test('票号空间：1–9 号补零为 07 形态，读写同过一个转换点自洽（令牌 7 核验归一为票 07）', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '7', '单号票');
  initRun(f);
  const r = addAll(f, 'dispatch', { ticket: '7', key: 't-7', 'run-id': 'aaaaaaaa' });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readEvents(f).at(-1).payload.ticket, '07', '写入侧：--ticket 7 归一为 07');
  // 核验侧同一转换点：git 历史里未补零的 ticket-7 令牌经归一化后与账上的 07 对上
  mergeTicket(f, '7'); // 故意不记 merge 事件 → 对账必须报这条未入账合并
  const r2 = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout, /git 有票 07 的合并提交/, '令牌 7 与事件 ticket=07 同经归一化对上');
  const md = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(md.status, 0, md.stdout);
  assert.match(md.stdout, /\| 07 \| 单号票 \|/, '补零显示：表格行 ticket 列为 07');
});

test('票号空间：票表与前沿按数值排序——混位数（01 / 02 / 205 / 1042）顺序正确、Blocked by 多位号原样显示', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '1042', '大号票', { blockedBy: '205' });
  writeTicketFile(f.dir, '205', '中号票', { blockedBy: '02' });
  initRun(f);
  addAll(f, 'dispatch', { ticket: '1042', key: 'k1', 'run-id': 'aaaaaaaa' });
  addAll(f, 'dispatch', { ticket: '02', key: 'k2', 'run-id': 'bbbbbbbb' });
  addAll(f, 'dispatch', { ticket: '205', key: 'k3', 'run-id': 'cccccccc' });
  const r = ledger(['build', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, r.stdout);
  const rows = r.stdout
    .split('\n')
    .filter((l) => /^\| \d+ \|/.test(l))
    .map((l) => /^\| (\d+) \|/.exec(l)[1]);
  assert.deepEqual(rows, ['01', '02', '205', '1042'], '数值序——字典序会把 1042 排在 02 与 205 之间');
  assert.match(r.stdout, /\| 1042 \| 大号票 \| claimed \| 205 \|/, 'blockedBy 的多位号引用原样显示');
});

test('票号空间：多位号 merge 全生命周期——令牌核验通过、check 扫描同归一（账实一致）', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '1042', '大号票');
  initRun(f);
  addAll(f, 'dispatch', { ticket: '1042', key: 'k1', 'run-id': 'aaaaaaaa' });
  f.git('checkout -q -b ticket-1042');
  const head = step(f, 'work 1042');
  f.git('checkout -q feat/demo');
  f.git('merge --no-ff -q -m "Merge ticket-1042: 大号票" ticket-1042');
  const merge = f.git('rev-parse HEAD');
  addAll(f, 'settled', { ticket: '1042', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '1042', round: '1', verdict: 'approved' });
  const ok = addAll(f, 'merge', { ticket: '1042', 'head-sha': head, 'merge-sha': merge });
  assert.equal(ok.status, 0, ok.stdout);
  // 按协议收尾（关票 + 删分支）后：check 对 ticket-1042 令牌扫描归一为票 1042，账实一致
  writeTicketFile(f.dir, '1042', '大号票', { status: 'resolved' });
  f.git('branch -D ticket-1042');
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 0, r.stdout);
});

test('票号空间：merge 门对多位号照旧执法——信息令牌缺失（ticket-104 ≠ 票 1042）→ 矛盾拒绝', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '1042', '大号票');
  initRun(f);
  addAll(f, 'dispatch', { ticket: '1042', key: 'k1', 'run-id': 'aaaaaaaa' });
  f.git('checkout -q -b ticket-1042');
  const head = step(f, 'work 1042');
  f.git('checkout -q feat/demo');
  f.git('merge --no-ff -q -m "Merge ticket-104: 少一位" ticket-1042');
  const merge = f.git('rev-parse HEAD');
  addAll(f, 'settled', { ticket: '1042', round: '1', 'head-sha': head });
  addAll(f, 'verdict', { ticket: '1042', round: '1', verdict: 'approved' });
  const bad = addAll(f, 'merge', { ticket: '1042', 'head-sha': head, 'merge-sha': merge });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /ticket-1042 令牌/);
  assert.equal(readEvents(f).filter((e) => e.type === 'merge').length, 0);
});

test('票号空间：未入账合并扫描对多位号提取正确（ticket-205 历史提交 → 差异点名票 205）', (t) => {
  const f = makeFixture(t);
  writeTicketFile(f.dir, '205', '中号票');
  initRun(f);
  f.git('checkout -q -b ticket-205');
  step(f, 'work 205');
  f.git('checkout -q feat/demo');
  f.git('merge --no-ff -q -m "Merge ticket-205: 中号票" ticket-205');
  const r = ledger(['check', '--runtime-dir', f.runtime], { cwd: f.dir });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /git 有票 205 的合并提交/, '四位以下的多位号同样被扫描提取并点名');
});
