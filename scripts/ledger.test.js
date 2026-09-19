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
  assert.equal(e.v, 1);
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
// 流程形态快照（init 旗标；D20）：reviewer 开关 / 修复预算参数化
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
