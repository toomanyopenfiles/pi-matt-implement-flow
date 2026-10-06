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

const LEDGER = path.resolve(__dirname, '../scripts/ledger.js');

// 票 02：同步幂等机器 marker——黑盒断言点在 gh 桩的状态与调用日志里。run 标识 = --runtime-dir 的
// 目录名（fixture 下恒 'demo'）；kind = 四类同步写入（merge / escalate / closing / abandon）。
const RUN = 'demo';
const MARK = (kind) => `<!-- matt-implement:${RUN}:${kind} -->`;

// --- gh 桩（Node 脚本）：状态存 GH_STUB_STATE 指向的 JSON 文件，调用追加进 GH_STUB_LOG ---
// GH_STUB_FAIL：所有调用模拟失败（网络不可用）；GH_STUB_FAIL_WRITE=<num>：该号的写入
// 动作（close/comment/edit）模拟失败；<num>:<command> 只拦该号的指定写命令。
// 每次 gh 调用是独立进程，匹配的调用都会失败；重试去掉环境变量后恢复。
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
  return num === f || num + ':' + kind === f;
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
  const s = load();
  const ai = rest.indexOf('--add-assignee');
  if (ai !== -1) {
    // 占坑写面（票 05 claim 子命令）：追加 assignee（幂等：已在位不重复）
    const login = rest[ai + 1];
    if (!(s.issues[num].assignees ?? []).includes(login)) s.issues[num].assignees = [...(s.issues[num].assignees ?? []), login];
    save(s);
  } else {
    const ri = rest.indexOf('--remove-assignee');
    const login = rest[ri + 1];
    s.issues[num].assignees = (s.issues[num].assignees ?? []).filter((a) => a !== login);
    save(s);
  }
} else {
  console.error('gh stub: unhandled issue subcommand: ' + kind);
  process.exit(64);
}
`;

// --- fixture：运行时目录 + tracker 快照（编排器写到同步时点的产物形态）---
// 票 05 契约化：fixture 带 setup 产物（docs/agents/issue-tracker.md = GitHub 范本）作判型
// 输入——同步/占坑的契约模板与 Source 行形态解析的配置单源（可传 localDoc 换 local 范本）。

const SHA_A = '0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6';

function makeFixture(t, { trackerDoc = 'issue-tracker-github.md' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
  fs.chmodSync(path.join(bin, 'gh'), 0o755);
  if (trackerDoc !== null) {
    fs.mkdirSync(path.join(dir, 'docs/agents'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', trackerDoc), path.join(dir, 'docs/agents/issue-tracker.md'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'triage-labels-canonical.md'), path.join(dir, 'docs/agents/triage-labels.md'));
  }
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

function rawLog(f) {
  return fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '';
}

function callLog(f) {
  return rawLog(f).split('\n').filter(Boolean);
}

// 多行正文会让桩日志把 marker 折到后续物理行——按日志原文窗口断言同一调用内携带
// （命令与 marker 之间只有该调用的正文，不跨调用）。
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markerNear = (raw, cmdRe, mark) =>
  new RegExp(cmdRe + '[\\s\\S]{0,80}?' + reEscape(mark)).test(raw);

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

  // tracker 桩状态：合并票已关且评论含 SHA + merge marker；升级票保持开放只有留评
  //（escalate marker）；spec 已关附收尾评论（closing marker）。marker 隐藏在正文尾部，
  // 人类可读正文信息不变；issue #8：固定正文英文（旧版中文只存在于历史评论）。
  assert.deepEqual(stateOf(f, 1043), {
    state: 'closed',
    assignees: [],
    comments: [`Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });
  assert.deepEqual(stateOf(f, 1102), {
    state: 'open',
    assignees: [],
    comments: [`Escalated: 预算用尽\n\n${MARK('escalate')}`],
  });
  assert.deepEqual(stateOf(f, 3001), {
    state: 'closed',
    assignees: [],
    comments: [`已交付：票 1043 合并于主分支，PR #12 待审。\n\n${MARK('closing')}`],
  });
  assert.deepEqual(stateOf(f, 1044), { state: 'open', assignees: [], comments: [] }, '在途票不惊动 tracker');

  const log = callLog(f);
  assert.deepEqual(
    log.filter(isViewCall).map((l) => l.replace(/^-R \S+ /, '').split(' --json')[0]),
    ['issue view 1043', 'issue view 1102', 'issue view 3001'],
    '只拉取同步对象的状态（在途票 1044 不发请求）',
  );
  assert.ok(log.some((l) => l.includes('issue close 1043 --comment Merged (merge SHA: 0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6)')));
  assert.ok(log.some((l) => l.includes('issue comment 1102 --body Escalated: 预算用尽')));
  assert.ok(log.some((l) => /issue close 3001 --comment 已交付：票 1043/.test(l)));
  // 四类同步写入均带 marker —— 逐条验（合并关票=merge、升级留评=escalate、spec 收尾=closing；
  // 各 marker 含本 run 标识）。多行正文折行，按原文窗口断言同一调用内携带。
  assert.ok(markerNear(rawLog(f), 'issue close 1043 --comment ', MARK('merge')), '同步写入携带 marker：merge');
  assert.ok(markerNear(rawLog(f), 'issue comment 1102 --body ', MARK('escalate')), '同步写入携带 marker：escalate');
  assert.ok(markerNear(rawLog(f), 'issue close 3001 --comment ', MARK('closing')), '同步写入携带 marker：closing');

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

// 票 02：幂等判定只认 marker——人在 tracker 上翻译/改写/追加已推送评论的正文后，
// 重跑零动作（正文不再参与判定；marker 是唯一键）。
test('sync 幂等重跑：人改写/翻译/追加正文后 rerun 零动作（只认 marker）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);

  // 模拟人类改写：删掉正文原样、换译写、追加补充——只留 marker（HTML 注释人类不可见，
  // 正常编辑正文时不会动它）
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues[ '1043' ].comments = [`Merged (merge commit: ${SHA_A.slice(0, 7)}, squash).\n\n<!-- matt-implement:${RUN}:merge -->`];
  s.issues[ '1102' ].comments = [`Escalated: budget exhausted（翻译后的升级评论）。\n\n(matt note：细节见 ledger)\n\n<!-- matt-implement:${RUN}:escalate -->`];
  s.issues[ '3001' ].comments = [`Delivered – ticket 1043 merged into main, PR #12 awaiting review.\n\n<!-- matt-implement:${RUN}:closing -->`];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const writesBefore = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  const writesAfter = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  assert.equal(writesAfter, writesBefore, '改写正文后重跑：仍是零动作零写入');
  assert.deepEqual(stateOf(f, 1043).comments.length, 1, '不重复推送');
});

// 票 02：历史无 marker 评论（旧 run 形态）在首次 marker 同步后照带重推（语义显式记录），
// 新写入带 marker —— 再重跑按 marker 判重归零。
test('sync 幂等重跑：旧 run 无 marker 历史评论 → 首重跑后照常推送一次，再跑归零', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  // 预置旧形态痕迹：已关 + 无 marker 的合并评论（旧 run 推的）
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues[ '1043' ].state = 'closed';
  s.issues[ '1043' ].comments = [`已合并（merge SHA：${SHA_A}）`];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const first = sync(f, [], withGh(f));
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /✓ comment 1043/, '历史无 marker 评论视为未同步、照常推送一次');
  // issue #8：旧版中文正文与新英文正文同列——旧文识别、新文携带 marker 推送
  assert.deepEqual(stateOf(f, 1043), {
    state: 'closed',
    assignees: [],
    comments: [`已合并（merge SHA：${SHA_A}）`, `Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });

  // 再重跑：marker 已在 → 零动作（新写入不再重复，语义收敛到 marker）
  const writesBefore = rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0;
  const second = sync(f, [], withGh(f));
  assert.equal(second.status, 0, second.stdout);
  assert.deepEqual(
    rawLog(f).match(/issue (close|comment|edit) /g)?.length ?? 0,
    writesBefore,
    'marker 补推后重跑：零动作',
  );
});

// issue #8：升级前版本推送的旧版中文正文（带 marker）——重跑识别为已同步，零重复推送。
//（无 marker 的旧中文评论按迁移语义照常补推一次，见上一用例；带 marker 的永不重复。）
test('sync 跨语言兼容：旧版中文同步评论（带 marker）→ 重跑识别，零重复推送', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  stubState(f, {
    1043: { state: 'closed', assignees: [], comments: [`已合并（merge SHA：${SHA_A}）\n\n${MARK('merge')}`] },
    1044: { state: 'open', assignees: [], comments: [] },
    1102: { state: 'open', assignees: [], comments: [`已升级上报：预算用尽\n\n${MARK('escalate')}`] },
    3001: { state: 'closed', assignees: [], comments: [`已交付：票 1043 合并于主分支，PR #12 待审。\n\n${MARK('closing')}`] },
  });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /已同步：无待推送动作/);
  assert.equal(callLog(f).filter((l) => !isViewCall(l)).length, 0, '旧中文痕迹识别为已同步：零写入');
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');
  assert.equal(stateOf(f, 1102).comments.length, 1, '升级票留评不重复');
  assert.equal(stateOf(f, 3001).comments.length, 1, 'spec 收尾评论不重复');
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

  // 重跑：规划器看到已推送 marker → 只补 spec 收尾，已关不重关、已评论不重复
  const logBefore = rawLog(f).length;
  const r2 = sync(f, [], withGh(f));
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /✓ close 3001/);
  assert.doesNotMatch(r2.stdout, /close 1043/);
  assert.doesNotMatch(r2.stdout, /comment 1102/);
  assert.equal(stateOf(f, 1043).comments.length, 1, '合并票评论不重复');
  assert.equal(stateOf(f, 1102).comments.length, 1, '升级票留评不重复');
  // 重跑只动未完成的票：日志增量的写入调用只有 3001（关票命令）；多行正文折行，
  // 按原文窗口断言，不逐物理行。
  const logAfter = rawLog(f).slice(logBefore);
  assert.doesNotMatch(logAfter, /issue (close|comment|edit) (1043|1102)( |\n)/, '重跑只动未完成的票');
  assert.match(logAfter, /issue close 3001/, '重跑只补未完成的票');
});

// ====================================================================
// abandon 路径：撤占坑（移除 assignee）+ 留评说明
// ====================================================================

// #16：sync 是公开 CLI seam；真实 init 保证开放状态不是测试手写的结论。
// 故障只注入外部 gh 命令，sync 不负责封账、ready 或停止平台 child。
function initOpenRun(f) {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: f.dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  fs.writeFileSync(path.join(f.dir, 'README.md'), 'fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'baseline');
  const baseline = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feat/demo');
  const r = spawnSync(process.execPath, [LEDGER, 'init', '--runtime-dir', f.runtime,
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', baseline,
    '--spec', path.join(f.tracker, 'spec.md'), '--test-command', 'npm test'], {
    cwd: f.dir, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.writeFileSync(path.join(f.runtime, 'notes.md'), '用户明确放弃；未完成票保留，代码与验证证据已保存。\n');
}

function runEvidence(f) {
  return Object.fromEntries([
    'events.jsonl', 'ledger.md', 'notes.md', 'tracker/spec.md',
    ...fs.readdirSync(path.join(f.tracker, 'issues')).map((name) => `tracker/issues/${name}`),
  ].map((name) => [name, fs.readFileSync(path.join(f.runtime, name), 'utf8')]));
}

function assertOpenEvidence(f, before) {
  assert.deepEqual(runEvidence(f), before, 'sync 不修改事件、台账、笔记或快照（失败与成功都可核查）');
  assert.match(before['ledger.md'], /state: running/);
  const events = before['events.jsonl'].trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.type === 'close' || (e.type === 'pr' && e.payload.state === 'ready')),
    '放弃同步不封账、不标 ready');
}

function seedAbandonFixture(f) {
  seedSealFixture(f); // 即使存在 merge/escalate/closing 事实，abandon 也不执行 seal。
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['3001'].assignees = ['alice', 'bob'];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  initOpenRun(f);
}

const ABANDON_ARGS = ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户明确放弃，保留未完成项'];

function assertAbandonTicketsUntouched(f) {
  for (const num of [1043, 1044, 1102]) {
    assert.deepEqual(stateOf(f, num), { state: 'open', assignees: [], comments: [] },
      `abandon 不同步票 ${num}，包括未完成票与远程延迟的已合并票`);
  }
  assert.doesNotMatch(rawLog(f), /issue (view|close|comment|edit) (1043|1044|1102)\b/);
  assert.doesNotMatch(rawLog(f), /issue close |\bpr\b/);
}

test('sync abandon：说明失败保持开放与占坑；重试补说明和撤占坑，不执行 seal/ready', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = sync(f, ABANDON_ARGS, { ...withGh(f), GH_STUB_FAIL_WRITE: '3001:comment' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：comment 3001/);
  assert.match(failed.stdout, /已完成（0\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 3001), { state: 'open', assignees: ['alice', 'bob'], comments: [] });
  assert.doesNotMatch(rawLog(f), /--remove-assignee/, '说明失败不提前撤占坑');
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  const offset = rawLog(f).length;
  const retried = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：2 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open', assignees: ['bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  const retryLog = rawLog(f).slice(offset);
  assert.equal((retryLog.match(/issue comment 3001 /g) ?? []).length, 1);
  assert.equal((retryLog.match(/issue edit 3001 --remove-assignee alice/g) ?? []).length, 1);
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);
});

test('sync abandon：撤占坑失败保留已推说明与开放状态；重试只撤占坑，之后零动作', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = sync(f, ABANDON_ARGS, { ...withGh(f), GH_STUB_FAIL_WRITE: '3001:edit' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：unassign 3001/);
  assert.match(failed.stdout, /已完成（1\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open', assignees: ['alice', 'bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  // 人可改写说明正文，marker 仍是重试判重依据。
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['3001'].comments = [`用户已终结此 run；未完成范围仍开放。\n\n${MARK('abandon')}`];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const offset = rawLog(f).length;
  const retried = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：1 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  const retryLog = rawLog(f).slice(offset);
  assert.doesNotMatch(retryLog, /issue (comment|close) /);
  assert.equal((retryLog.match(/issue edit 3001 --remove-assignee alice/g) ?? []).length, 1);
  assert.deepEqual(stateOf(f, 3001), { ...state.issues['3001'], assignees: ['bob'] });
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  const afterRetry = rawLog(f).length;
  const again = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.doesNotMatch(rawLog(f).slice(afterRetry), /issue (close|comment|edit) /);
  assertOpenEvidence(f, before);
});

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
  // 放弃留评携带 abandon marker（含 run 标识）——人类可读正文原样保留（issue #8：英文正文，原因原文跟随）
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open',
    assignees: [],
    comments: [`This run has been abandoned: 用户拍板放弃：终审 not_ready\n\n${MARK('abandon')}`],
  });
  assert.ok(markerNear(rawLog(f), 'issue comment 3001 --body ', MARK('abandon')), '放弃留评携带 marker：abandon');
  assert.match(r.stdout, /✓ comment 3001/);
  assert.match(r.stdout, /✓ unassign 3001（alice）/);

  const logBefore = rawLog(f).length;
  const again = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGh(f));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.equal(rawLog(f).slice(logBefore).match(/issue (close|comment|edit) /g), null, '重跑不产生任何新写入');
});

test('sync abandon：占坑者已不在（他人已处理）→ 只留说明', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '改期重跑'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 3001), {
    state: 'open',
    assignees: [],
    comments: [`This run has been abandoned: 改期重跑\n\n${MARK('abandon')}`],
  });
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

// ====================================================================
// 占坑（票 05 claim 子命令）：契约 claim 模板执行——先读状态再写入，冲突不猜测覆盖
// ====================================================================

test('claim 成功：先读状态无人占坑 → claim 模板执行，tracker 桩状态真实更新', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', 'https://github.com/o/r/issues/3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /占坑/);
  assert.match(r.stdout, /3001/);
  assert.deepEqual(stateOf(f, 3001).assignees, ['@me'], 'tracker 桩状态：占坑落 assignee');
  assert.ok(rawLog(f).includes('issue edit 3001 --add-assignee @me'), 'claim 走契约 claim 模板');
  assert.ok(rawLog(f).includes('issue view 3001'), '先读状态再写入');
});

test('claim 冲突：他人已在位 → 拒绝并点名在位者，不覆盖（无 claim 写入）', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: ['alice'], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', '#3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /占坑冲突/);
  assert.match(r.stdout, /alice/);
  assert.deepEqual(stateOf(f, 3001).assignees, ['alice'], '他人占坑零覆盖');
  assert.equal(rawLog(f).match(/issue edit 3001 --add-assignee/g), null, '冲突路径无 claim 写入');
});

test('claim local 契约 / 缺 setup 产物 / 缺 --spec：显式停下不猜测', (t) => {
  const runClaim = (f, args) =>
    spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, ...args], {
      cwd: f.dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
    });

  const local = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  const rl = runClaim(local, ['--spec', '3001']);
  assert.equal(rl.status, 1);
  assert.match(rl.stdout, /tracker=local 无 tracker 写面/);

  const noDoc = makeFixture(t, { trackerDoc: null });
  const rn = runClaim(noDoc, ['--spec', '3001']);
  assert.equal(rn.status, 1);
  assert.match(rn.stdout, /setup-matt-pocock-skills/);

  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const missing = runClaim(f, []);
  assert.equal(missing.status, 2, '用法拒绝（exit 2）');
  assert.match(missing.stdout, /缺少必选参数 --spec/);
  const bogus = runClaim(f, ['--spec', '3001', '--bogus', 'x']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(callLog(f).length, 0, '拒绝面不触碰 tracker');
});

test('sync abandon（local）：无远程说明或占坑写面，保留开放 run、本地票与证据', (t) => {
  const f = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  fs.writeFileSync(path.join(f.tracker, 'spec.md'), '# Spec: local\n\n**Status:** ready-for-agent\n');
  writeTicket(f, '01', 'unfinished', { status: 'claimed' });
  initOpenRun(f);
  const before = runEvidence(f);
  const r = sync(f, ABANDON_ARGS, withGh(f));
  assert.equal(r.status, 1, r.stdout + r.stderr); // local 的既有公开接口：不经 sync CLI。
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.match(r.stdout, /本地票文件即真相层/);
  assert.doesNotMatch(r.stdout, /PR 标 ready|清理指引/);
  assertOpenEvidence(f, before);

  const claim = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime,
    '--spec', path.join(f.tracker, 'spec.md')], {
    cwd: f.dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...withGh(f) },
  });
  assert.equal(claim.status, 1, claim.stdout + claim.stderr);
  assert.match(claim.stdout, /tracker=local 无 tracker 写面/);
  assert.equal(callLog(f).length, 0, 'local claim/abandon 不触碰外部 tracker');
  assertOpenEvidence(f, before);
});

test('sync 拒绝：local 契约（快照/同步为无操作）——票文件即真相层', (t) => {
  const f = makeFixture(t, { trackerDoc: 'issue-tracker-local.md' });
  writeSpec(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /tracker=local 无需同步/);
  assert.match(r.stdout, /本地票文件即真相层/);
  assert.equal(callLog(f).length, 0, 'local 契约同步零 tracker 触碰');
});

test('sync 拒绝：缺 setup 产物 → 识别先于一切拉取，指引运行 /setup-matt-pocock-skills', (t) => {
  const f = makeFixture(t, { trackerDoc: null });
  writeSpec(f);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /setup-matt-pocock-skills/);
  assert.equal(callLog(f).length, 0, '识别失败零网络');
});

// ====================================================================
// 仓库作用域（票 05 评审 r1 P0/P1）：跨仓引用必须打到契约仓——issue 命令一律前置 -R <repo>
//（viewIssue / close / comment / unclaim 四面；REST 路径模板自带 <repo> 除外）
// ====================================================================

test('仓库作用域：sync 的 viewIssue/close/comment/unclaim 全部携带 -R <repo>（契约仓，非 cwd）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = sync(f, [], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  // viewIssue：三个同步对象的拉取都带 -R o/r（Source 行的 repo）
  const views = log.filter(isViewCall);
  assert.equal(views.length, 3);
  assert.ok(views.every((l) => /^-R o\/r issue view /.test(l)), `view 全部 -R 前置：${views.join(' | ')}`);
  // close / comment：写入动作同样 -R 前置（stub 日志多行正文折行，按原文窗口断言）
  assert.ok(markerNear(rawLog(f), '-R o/r issue close 1043 --comment ', MARK('merge')), 'close 1043 带 -R');
  assert.ok(markerNear(rawLog(f), '-R o/r issue comment 1102 --body ', MARK('escalate')), 'comment 1102 带 -R');
  assert.ok(markerNear(rawLog(f), '-R o/r issue close 3001 --comment ', MARK('closing')), 'close 3001 带 -R');
});

test('仓库作用域：abandon 的 unclaim（撤占坑）同样携带 -R <repo>', (t) => {
  const f = makeFixture(t);
  writeSpec(f, { closing: false });
  stubState(f, { 3001: { state: 'open', assignees: ['alice'], comments: [] } });
  const r = sync(f, ['--mode', 'abandon', '--claimant', 'alice', '--reason', '放弃'], withGh(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  assert.ok(log.some((l) => /^-R o\/r issue view 3001 /.test(l)), 'abandon 母票拉取带 -R');
  assert.ok(log.some((l) => /^-R o\/r issue edit 3001 --remove-assignee alice/.test(l)), 'unclaim 带 -R');
});

test('仓库作用域：跨仓 spec 引用（o/r#号）的 claim 读/写都落在契约仓', (t) => {
  const f = makeFixture(t);
  stubState(f, { 3001: { state: 'open', assignees: [], comments: [] } });
  const r = spawnSync(process.execPath, [LEDGER, 'claim', '--runtime-dir', f.runtime, '--spec', 'other/repo#3001'], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_STATE: f.stateFile, GH_STUB_LOG: f.logFile },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = callLog(f);
  assert.ok(log.some((l) => /^-R other\/repo issue view 3001 /.test(l)), `view 落在引用声明的契约仓：${log.join(' | ')}`);
  assert.ok(log.some((l) => /^-R other\/repo issue edit 3001 --add-assignee @me/.test(l)), 'claim 落在契约仓');
});
