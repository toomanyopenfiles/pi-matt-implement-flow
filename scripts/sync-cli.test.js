'use strict';

// 票 06：sync 子命令黑盒测试——真实调用 ledger CLI，断言退出码、stdout、gh 调用日志
// 与（gh 桩的）tracker 状态迁移。gh 收发是 best-effort 薄 IO（spec 测试决策：不设缝、
// 不碰网络）——测试通过 PATH 注入 gh 桩二进制供给合成 tracker 状态；生产代码不含任何
// 测试钩子。桩是有状态的：close/comment/edit 真实改写状态文件，幂等矩阵（已关不重关、
// 已评论不重复、部分同步后重跑续作）在外部行为面上端到端验证。
// 快照文件由测试直接落盘（run 期间编排器写快照的产物形态，票 05 转写 + Comments 事实）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, 'ledger.js');

// --- gh 桩（Node 脚本）：状态存 GH_STUB_STATE 指向的 JSON 文件，调用追加进 GH_STUB_LOG ---
// GH_STUB_FAIL：所有调用模拟失败（网络不可用）；GH_STUB_FAIL_WRITE=<num>：该号的写入
// 动作（close/comment/edit）模拟失败——部分同步状态的注入点（每次 gh 调用是独立进程，
// 同号多次写入各自都会拦；用例用它拦最后一个动作，此前的动作照常推送）。
// issue view 的失败不设专门开关：从桩状态里删号即真实缺票（同步对象缺失用例）。

const GH_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GH_STUB_STATE;
const log = process.env.GH_STUB_LOG;
if (log) fs.appendFileSync(log, args.join(' ') + '\\n');
const die = (msg) => { console.error('gh: ' + msg); process.exit(1); };
if (process.env.GH_STUB_FAIL) die('simulated failure (network down)');
const rest = args[0] === '-R' ? args.slice(2) : args;
const sub = rest[0];
if (sub !== 'issue') { console.error('gh stub: unhandled invocation: ' + args.join(' ')); process.exit(64); }
const kind = rest[1];
const num = String(rest[2] ?? '');
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const it = state.issues[num];
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const writeFail = () => {
  const f = process.env.GH_STUB_FAIL_WRITE;
  if (!f) return false;
  delete process.env.GH_STUB_FAIL_WRITE; // 只防同进程内重入——每个 gh 调用是独立进程，跨调用各自判定
  return num === f;
};
if (kind === 'view') {
  if (!it) die('issue #' + num + ' not found');
  process.stdout.write(JSON.stringify({
    number: Number(num),
    state: it.state === 'closed' ? 'CLOSED' : 'OPEN',
    assignees: (it.assignees ?? []).map((login) => ({ login })),
    comments: (it.comments ?? []).map((body) => ({ body })),
  }));
} else if (kind === 'close') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (close ' + num + ')');
  const ci = rest.indexOf('--comment');
  const body = ci !== -1 ? rest[ci + 1] : null;
  const s = load();
  s.issues[num].state = 'closed';
  if (body) s.issues[num].comments.push(body);
  save(s);
} else if (kind === 'comment') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (comment ' + num + ')');
  const bi = rest.indexOf('--body');
  const body = rest[bi + 1];
  const s = load();
  s.issues[num].comments.push(body);
  save(s);
} else if (kind === 'edit') {
  if (!it) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (edit ' + num + ')');
  const ri = rest.indexOf('--remove-assignee');
  const login = rest[ri + 1];
  const s = load();
  s.issues[num].assignees = (s.issues[num].assignees ?? []).filter((a) => a !== login);
  save(s);
} else {
  console.error('gh stub: unhandled issue subcommand: ' + kind);
  process.exit(64);
}
`;

// --- fixture：运行时目录 + tracker 快照（编排器写到同步时点的产物形态）---

const SHA_A = '0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6';

function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  const runtime = path.join(dir, '.pi/matt-implement/demo');
  const tracker = path.join(runtime, 'tracker');
  fs.mkdirSync(path.join(tracker, 'issues'), { recursive: true });
  return { dir, bin, runtime, tracker, stateFile: path.join(dir, 'gh-state.json'), logFile: path.join(dir, 'gh-log.txt') };
}

function writeSpec(f, { closing = true } = {}) {
  fs.writeFileSync(
    path.join(f.tracker, 'spec.md'),
    [
      '# Spec: GitHub tracker 一等公民支持',
      '',
      'Source: https://github.com/o/r/issues/3001',
      '',
      '**Type:** spec',
      '',
      'spec 正文',
      '',
      '## Comments',
      ...(closing ? ['', '- closing: 已交付：票 1043 合并于主分支，PR #12 待审。'] : []),
    ].join('\n') + '\n',
  );
}

function writeTicket(f, num, slug, extra = {}) {
  const lines = [`# ${num}: ${slug}`, '', `**Status:** ${extra.status ?? 'claimed'}`, '', '**Blocked by:** —'];
  if (extra.comments?.length) lines.push('', '## Comments', '', ...extra.comments.map((c) => `- ${c}`));
  fs.writeFileSync(path.join(f.tracker, 'issues', `${num}-${slug}.md`), lines.join('\n') + '\n');
}

// tracker 桩初始状态：{ num: { state, assignees, comments } }
function stubState(f, issues) {
  fs.writeFileSync(f.stateFile, JSON.stringify({ issues }));
}

function sync(f, args, env = {}) {
  const r = spawnSync(process.execPath, [LEDGER, 'sync', '--runtime-dir', f.runtime, ...args], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const withGh = (f) => ({ GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile });

function callLog(f) {
  return fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8').split('\n').filter(Boolean) : [];
}

function stateOf(f, num) {
  return JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).issues[String(num)];
}

// gh 桩日志行：'-R o/r issue view 1043 --json …'——视图调用以 'issue view' 子串识别
const isViewCall = (line) => /(^|\s)issue view /.test(line);

function writeEvents(f, events) {
  fs.writeFileSync(
    path.join(f.runtime, 'events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
}

// 恒定 fixture：合并票 1043（Comments 有 SHA）、升级票 1102（Comments 有原因）、
// 在途票 1044（无事实，不是同步对象）、spec 母票 3001（closing 收尾评论）。
function seedSealFixture(f) {
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
}

// ====================================================================
// seal 成功路径：合并票关票附 SHA、升级票留评保持开放、spec 收尾关闭
// ====================================================================

test('sync seal 成功：合并票关票附 SHA、升级票只留评保持开放、spec 收尾关闭；输出清理指引', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);

  // tracker 桩状态：合并票已关且评论含 SHA；升级票保持开放只有留评；spec 已关附收尾评论
  assert.deepEqual(stateOf(f, 1043), { state: 'closed', assignees: [], comments: [`已合并（merge SHA：${SHA_A}）`] });
  assert.deepEqual(stateOf(f, 1102), { state: 'open', assignees: [], comments: ['已升级上报：预算用尽'] });
  assert.deepEqual(stateOf(f, 3001), {
    state: 'closed',
    assignees: [],
    comments: ['已交付：票 1043 合并于主分支，PR #12 待审。'],
  });
  assert.deepEqual(stateOf(f, 1044), { state: 'open', assignees: [], comments: [] }, '在途票不惊动 tracker');

  const log = callLog(f);
  assert.deepEqual(
    log.filter(isViewCall).map((l) => l.replace(/^-R \S+ /, '').split(' --json')[0]),
    ['issue view 1043', 'issue view 1102', 'issue view 3001'],
    '只拉取同步对象的状态（在途票 1044 不发请求）',
  );
  assert.ok(log.some((l) => /issue close 1043 --comment 已合并（merge SHA：0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6）/.test(l)));
  assert.ok(log.some((l) => /issue comment 1102 --body 已升级上报：预算用尽/.test(l)));
  assert.ok(log.some((l) => /issue close 3001 --comment 已交付：票 1043/.test(l)));

  assert.match(r.stdout, /同步完成：3 个动作/);
  assert.match(r.stdout, /✓ close 1043/);
  assert.match(r.stdout, /✓ comment 1102/);
  assert.match(r.stdout, /✓ close 3001/);
  // 清理指引：快照与 review bundle 清理、findings 与账本三件套留存
  assert.match(r.stdout, /清理 tracker 快照/);
  assert.match(r.stdout, /review bundle/);
  assert.match(r.stdout, /findings/);
  assert.match(r.stdout, /events\.jsonl/);
  assert.match(r.stdout, /notes\.md/);
});

test('sync 幂等重跑：已关不重关、已评论不重复——第二次执行零动作零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);

  const writesAfterFirst = callLog(f).filter((l) => !isViewCall(l)).length;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  assert.match(second.stdout, /幂等|零副作用/);
  assert.equal(
    callLog(f).filter((l) => !isViewCall(l)).length,
    writesAfterFirst,
    '重跑不产生任何新写入',
  );
  // 评论不重复：升级票的留评仍恰一条
  assert.equal(stateOf(f, 1102).comments.length, 1);
  assert.equal(stateOf(f, 1043).comments.length, 1);
});

// ====================================================================
// 部分失败：逐动作报告已完成/未完成，可安全重跑（重跑只补未完成）
// ====================================================================

test('sync 部分失败：报告已完成/未完成；重跑续作（已完成的动作不重复）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // spec 收尾（最后一个动作）失败：前两个动作已推送
  const r1 = sync(f, [], { ...withGh(f), GH_STUB_FAIL_WRITE: '3001' });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /同步失败/);
  assert.match(r1.stdout, /已完成/);
  assert.match(r1.stdout, /✓ close 1043/);
  assert.match(r1.stdout, /✓ comment 1102/);
  assert.match(r1.stdout, /未完成/);
  assert.match(r1.stdout, /close 3001/);
  assert.match(r1.stdout, /重跑/);
  assert.equal(stateOf(f, 1043).state, 'closed', '已完成的部分真实生效');
  assert.equal(stateOf(f, 3001).state, 'open', '未完成的动作不落任何状态');

  // 重跑：规划器看到已推送痕迹 → 只补 spec 收尾，已关不重关、已评论不重复
  const logBefore = callLog(f).length;
  const r2 = sync(f, [], withGh(f));
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /✓ close 3001/);
  assert.doesNotMatch(r2.stdout, /close 1043/);
  assert.doesNotMatch(r2.stdout, /comment 1102/);
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');
  assert.equal(stateOf(f, 1102).comments.length, 1, '升级票留评不重复');
  assert.ok(callLog(f).slice(logBefore).every((l) => isViewCall(l) || /3001/.test(l)), '重跑只动未完成的票');
});

// ====================================================================
// abandon 路径：撤占坑（移除 assignee）+ 留评说明
// ====================================================================

test('sync abandon：spec 留评放弃说明 + 撤占坑；重跑零动作', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  writeTicket(f, '1044', 'in-flight', { status: 'claimed' });
  stubState(f, {
    1044: { state: 'open', assignees: [], comments: [] },
    3001: { state: 'open', assignees: ['alice'], comments: [] },
  });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open',
    assignees: [],
    comments: ['本 run 已放弃：用户拍板放弃：终审 not_ready'],
  });
  assert.match(r.stdout, /✓ comment 3001/);
  assert.match(r.stdout, /✓ unassign 3001（alice）/);

  const logBefore = callLog(f).filter((l) => !isViewCall(l)).length;
  const again = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGh(f));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, logBefore, '重跑不产生任何新写入');
});

test('sync abandon：占坑者已不在（他人已处理）→ 只留说明', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '改期重跑'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 3001), { state: 'open', assignees: [], comments: ['本 run 已放弃：改期重跑'] });
  assert.match(r.stdout, /✓ comment 3001/);
});

// ====================================================================
// 拒绝面：缺快照、已封账、参数缺省
// ====================================================================

test('sync 拒绝：快照不存在（tracker=local 无需同步的提示）', (t) => {
  const f = makeFixture(t);
  fs.rmSync(f.tracker, { recursive: true, force: true });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /快照不存在/);
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 gh');
});

test('sync 拒绝：run 已封账——同步须发生在封账之前', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'close', seq: 9 },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /已封账/);
  assert.match(r.stdout, /封账之前/);
  assert.equal(callLog(f).length, 0);
});

test('sync 拒绝：PR 已标 ready（pr --state ready 已入账）——同步须在 PR 标 ready 之前', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'ready' } },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PR 已标 ready/);
  assert.match(r.stdout, /之前/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 gh');
});

test('sync 放行：pr --state opened-draft 不拦同步（时点门只对 ready 生效）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'opened-draft' } },
  ]);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /同步完成/);
});

test('sync 拒绝：abandon 缺 claimant/reason、mode 非法、未知旗标（exit 2 用法拒绝）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const noClaimant = sync(f, ['--mode', 'abandon', '--reason', 'r'], withGh(f));
  assert.equal(noClaimant.status, 2);
  assert.match(noClaimant.stdout, /--claimant/);
  const noReason = sync(f, ['--mode', 'abandon', '--claimant', 'alice'], withGh(f));
  assert.equal(noReason.status, 2);
  assert.match(noReason.stdout, /--reason/);
  const badMode = sync(f, ['--mode', 'push'], withGh(f));
  assert.equal(badMode.status, 2);
  assert.match(badMode.stdout, /--mode 非法/);
  const bogus = sync(f, ['--bogus', 'x'], withGh(f));
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(callLog(f).length, 0);
});

test('sync 拒绝：快照形态不合格（缺 spec.md）——不触碰 gh', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  fs.rmSync(path.join(f.tracker, 'spec.md'));
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /spec\.md/);
  assert.equal(callLog(f).length, 0);
});

// ====================================================================
// gh 薄 IO 失败：拉取失败整体中止、零写入（无半成品推送）
// ====================================================================

test('sync gh 拉取失败：报错清晰、零写入（规划先行，失败不推送）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], { ...withGh(f), GH_STUB_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /拉取失败/);
  assert.match(r.stdout, /未执行任何动作|未执行任何写入/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0, '零写入');
  // tracker 状态原封未动
  assert.equal(stateOf(f, 1043).state, 'open');
});

test('sync gh 拉取失败：同步对象在 tracker 上缺失（如被删除）→ 点名缺票，零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // 从桩状态删掉升级票 1102
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  delete s.issues[1102];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1102/);
  assert.match(r.stdout, /拉取失败/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0);
});
