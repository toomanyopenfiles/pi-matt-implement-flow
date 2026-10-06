'use strict';

// 票 06（接缝③）：GitLab tracker 的黑盒端到端——glab 有状态桩按契约命令模板伺服 ledger
// CLI，断言退出码、stdout 与桩状态迁移。与 sync-cli.test.js（GitHub 形态）同一套测试纪律：
// 零网络、生产代码零测试钩子、快照与桩状态由测试直落 fixture；桩是有状态的——note/close/
// update 真实改写桩状态文件，幂等矩阵（已关不重关、已评不重评、部分同步续作续力、放弃撤占坑）
// 在外部行为面上端到端验证。glab 桩 mirror gh 桩的分派骨架（意回应有新语义的服务器形态），
// 略有差异：view.Yes 产物 是 gitlab 形态（iid/notes/state opened|closed/assignees[].username）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, '../scripts/ledger.js');

// 票 02：同步幂等机器 marker——run 标识 = --runtime-dir 目录名（fixture 恒 'demo'）。
const RUN = 'demo';
const MARK = (kind) => `<!-- matt-implement:${RUN}:${kind} -->`;

// --- glab 有状态桩：状态存 GLAB_STUB_STATE 指向的 JSON 文件，调用追加进 GLAB_STUB_LOG ---
// 有状态：note/close/update 真实改写桩状态（幂等矩阵在外部行为面端到端验证）；
// GLAB_STUB_FAIL：所有调用模拟失败；GLAB_STUB_FAIL_WRITE=<iid>：该号的写入动作模拟失败。
// <iid>:<command> 只拦指定写命令（note/close/update）；匹配的调用每次都失败，重试移除旗标。
// close 携带 --message / --comment 时桩真实报错：closeWithComment=false 的能力差异由桩硬编码。
const GLAB_STUB = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const stateFile = process.env.GLAB_STUB_STATE;
const log = process.env.GLAB_STUB_LOG;
if (log) fs.appendFileSync(log, args.join(' ') + '\\n');
const die = (msg) => { console.error('glab: ' + msg); process.exit(1); };
if (process.env.GLAB_STUB_FAIL) die('simulated failure (network down)');
// 契约 driver 的仓库作用旗前置（-R <repo>）——与 gh 桩同一剥旗口径（票 05 driver 位约定）
const rest = args[0] === '-R' ? args.slice(2) : args;
if (rest[0] !== 'issue') { console.error('glab stub: unhandled invocation: ' + args.join(' ')); process.exit(64); }
if (rest[1] === 'list') {
  // snapshot-init 取数：glab issue list -F json → 合成集合（测试直喂的 issues.json）。
  if (process.env.GLAB_STUB_LIST_FAIL) die('simulated failure (issue list)');
  process.stdout.write(fs.readFileSync(process.env.GLAB_STUB_ISSUES, 'utf8'));
  return;
}
const kind = rest[1];
const num = String(rest[2] ?? '');
const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s));
const writeFail = () => {
  const f = process.env.GLAB_STUB_FAIL_WRITE;
  if (!f) return false;
  return num === f || num + ':' + kind === f;
};
if (kind === 'view') {
  const it = state().issues[num];
  if (!it) die('issue #' + num + ' not found');
  process.stdout.write(JSON.stringify({
    iid: Number(num),
    state: it.state === 'closed' ? 'closed' : 'opened',
    assignees: (it.assignees ?? []).map((login) => ({ username: login })),
    notes: (it.comments ?? []).map((body) => ({ body })),
  }));
} else {
  const it = state().issues[num] ?? null;
  if (it == null) die('issue #' + num + ' not found');
  if (writeFail()) die('simulated write failure (' + kind + ' ' + num + ')');
  if (kind === 'note') {
    const bi = rest.indexOf('--message');
    const s = state();
    s.issues[num].comments.push(rest[bi + 1]);
    save(s);
  } else if (kind === 'close') {
    if (rest.includes('--message') || rest.includes('--comment')) {
      die('glab stub: close 不接受收尾评论（closeWithComment=false 由 note 先行承载）');
    }
    const s = state();
    s.issues[num].state = 'closed';
    save(s);
  } else if (kind === 'update') {
    const s = state();
    const ai = rest.indexOf('--assignee');
    if (ai !== -1) {
      // 占坑写面（claim 子命令）：追加 assignee（幂等：已在位不重复）
      const login = rest[ai + 1];
      if (!(s.issues[num].assignees ?? []).includes(login)) {
        s.issues[num].assignees = [...(s.issues[num].assignees ?? []), login];
      }
      save(s);
    } else {
      const ri = rest.indexOf('--unassign');
      const login = rest[ri + 1];
      s.issues[num].assignees = (s.issues[num].assignees ?? []).filter((a) => a !== login);
      save(s);
    }
  } else {
    die('unhandled issue subcommand: ' + kind);
  }
}
`;

// --- 合成 issue 集合（glab issue list -F json 的产物形态）---
const GITLAB_HOST = 'gitlab.example.net'; // 自建实例域名（路径形态识别，不认域名）
const GITLAB_PROJECT = 'tools/meta';
const srcUrl = (n) => `https://${GITLAB_HOST}/${GITLAB_PROJECT}/-/issues/${n}`;

const mkIssue = (n, { title, body, state = 'opened', labels = [] }) => ({
  iid: n,
  title,
  description: body,
  state,
  labels,
  web_url: srcUrl(n),
});

const SPEC_BODY = '## Solution\n\n快照 + 同步。';
const ISSUES = JSON.stringify([
  mkIssue(7042, { title: 'GitLab tracker 一等支持', body: SPEC_BODY, labels: ['ready-for-agent'] }),
  mkIssue(7043, { title: 'Transcription pure fns', body: '## Parent\n\n#7042\n\n**Blocked by:** —' }),
  mkIssue(7044, { title: 'Sync command', body: '## Parent\n\n#7042\n\nBlocked by: 7043', state: 'closed' }),
  mkIssue(7045, { title: 'Claim subcommand', body: '## Parent\n\n#7042' }),
  mkIssue(9999, { title: '别的 spec 的票', body: '不在本 run 票集' }),
]);

// 无 Parent 边的变体（走 init 票号清单兜底）
const ISSUES_NO_EDGES = JSON.stringify([
  mkIssue(7042, { title: 'GitLab tracker 一等支持', body: SPEC_BODY }),
  mkIssue(7043, { title: 'Transcription pure fns', body: '无边票据' }),
  mkIssue(7044, { title: 'Sync command', body: '无边票据', state: 'closed' }),
  mkIssue(7045, { title: 'Claim subcommand', body: '无边票据' }),
]);

// --- fixture：运行时目录 + setup 产物（gitlab 范本作判型输入，配置单源）+ glab 桩 ---
const readFixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const GITLAB_DOC = readFixture('issue-tracker-gitlab.md');
const TRIAGE_CANONICAL = readFixture('triage-labels-canonical.md');

function makeFixture(t, { trackerDoc = GITLAB_DOC } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitlab-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'glab'), GLAB_STUB);
  fs.chmodSync(path.join(bin, 'glab'), 0o755);
  if (trackerDoc !== null) {
    fs.mkdirSync(path.join(dir, 'docs/agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/agents/issue-tracker.md'), trackerDoc);
    fs.writeFileSync(path.join(dir, 'docs/agents/triage-labels.md'), TRIAGE_CANONICAL);
  }
  const runtime = path.join(dir, '.pi/matt-implement/demo');
  const tracker = path.join(runtime, 'tracker'); // 快照根不预建（续跑保护以已存在即拒绝为准）
  return { dir, bin, runtime, tracker, stateFile: path.join(dir, 'glab-state.json'), logFile: path.join(dir, 'glab-log.txt') };
}

function writeStubIssues(f, issues) {
  fs.writeFileSync(path.join(f.dir, 'issues.json'), issues);
}

// tracker 桩初始状态：{ iid: { state, assignees, comments } }
function stubState(f, issues) {
  fs.writeFileSync(f.stateFile, JSON.stringify({ issues }));
}

function runLedger(f, command, args, env = {}) {
  const r = spawnSync(process.execPath, [LEDGER, command, '--runtime-dir', f.runtime, ...args], {
    cwd: f.dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${f.bin}${path.delimiter}${process.env.PATH}`, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const withGlab = (f) => ({ GLAB_STUB_STATE: f.stateFile, GLAB_STUB_LOG: f.logFile, GLAB_STUB_ISSUES: path.join(f.dir, 'issues.json') });

function rawLog(f) {
  return fs.existsSync(f.logFile) ? fs.readFileSync(f.logFile, 'utf8') : '';
}
function calls(f) {
  return rawLog(f).split('\n').filter(Boolean);
}
const isViewCall = (l) => /(^|\s)issue view /.test(l);
const viewCmds = (f) => calls(f).filter(isViewCall).map((l) => l.replace(/^issue view /, '').split(' -F json')[0]);
// 写入动作计数（close/note/update 首行命中；多行正文折行不影响计数起点）
const writes = (f) => (rawLog(f).match(/issue (close|note|update) \d/g) ?? []).length;

// 多行正文会让 marker 折到桩日志的后续物理行——按原文窗口断言同一调用内携带。
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markerNear = (raw, cmdRe, mark) => new RegExp(cmdRe + '[\\s\\S]{0,80}?' + reEscape(mark)).test(raw);

function stateOf(f, num) {
  return JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).issues[String(num)];
}
function lsIssues(f) {
  return fs.existsSync(path.join(f.tracker, 'issues'))
    ? fs.readdirSync(path.join(f.tracker, 'issues')).sort()
    : [];
}
function writeEvents(f, events) {
  fs.writeFileSync(path.join(f.runtime, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const SHA_A = '0f3a9c41b7e2d5f8a6c1e4b9d2f7a3c5e8b1d4f6';

// ====================================================================
// snapshot-init（GitLab 形态）：issue list 取数 → Parent 反查 / 票号清单兜底 →
// 自建实例 URL 的 Source 行按 /-/issues/N 路径形态落盘
// ====================================================================

test('snapshot-init（gitlab）：Parent 反查定界、自建实例 Source 行按路径形态落盘、父引用与阻塞边正确转写', (t) => {
  const f = makeFixture(t);
  writeStubIssues(f, ISSUES);
  stubState(f, {});
  const r = runLedger(f, 'snapshot-init', ['--spec', srcUrl(7042)], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /票集边界=parent-edges/, '无 sub-issues 层——Parent 反查定界');
  assert.deepEqual(lsIssues(f), [
    '7043-transcription-pure-fns.md',
    '7044-sync-command.md',
    '7045-claim-subcommand.md',
  ]);
  const specText = fs.readFileSync(path.join(f.tracker, 'spec.md'), 'utf8');
  assert.match(specText, new RegExp(`^Source: ${reEscape(srcUrl(7042))}$`, 'm'), '自建实例原址照原样落 Source 行');
  assert.match(specText, /^\*\*Type:\*\* spec$/m, 'spec 母票豁免标记');
  assert.equal((specText.match(/^Source:/gm) ?? []).length, 1, 'Source 行恰一行');
  const mid = fs.readFileSync(path.join(f.tracker, 'issues', '7043-transcription-pure-fns.md'), 'utf8');
  assert.match(mid, /^\*\*Blocked by:\*\* —$/m);
  const blocked = fs.readFileSync(path.join(f.tracker, 'issues', '7044-sync-command.md'), 'utf8');
  assert.match(blocked, /^\*\*Blocked by:\*\* 7043$/m, '阻塞边转写自正文 Blocked by 行');
  assert.match(blocked, /## Parent[\s\S]*#7042/, '`## Parent` 正文引用在 GitLab 形态下同样正确');
  assert.equal(viewCmds(f).length, 0, 'snapshot-init 零 view 调用（只发 issue list）');
  assert.ok(calls(f).length > 0 && calls(f).every((l) => /^-R \S+ issue list /.test(l) || l.startsWith('issue list')), `取数只有 issue list：${calls(f).join(' | ')}`);
  assert.equal(fs.existsSync(`${f.tracker}.incoming`), false, '无落盘草稿残留');
});

test('snapshot-init（gitlab）：出票走 --tickets 兜底（init-list）+ 皆空诊断不点名 sub-issues，且零落盘', (t) => {
  const f = makeFixture(t);
  writeStubIssues(f, ISSUES_NO_EDGES);
  stubState(f, {});
  const ok = runLedger(f, 'snapshot-init', ['--spec', '#7042', '--tickets', '7043,7044,7045'], withGlab(f));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /票集边界=init-list/);
  assert.deepEqual(lsIssues(f), [
    '7043-transcription-pure-fns.md',
    '7044-sync-command.md',
    '7045-claim-subcommand.md',
  ]);

  // 皆空诊断按 GitLab 兜底链逐层生成：未声明的 sub-issues 层不进入诊断
  const f2 = makeFixture(t);
  writeStubIssues(f2, ISSUES_NO_EDGES);
  stubState(f2, {});
  const empty = runLedger(f2, 'snapshot-init', ['--spec', '#7042'], withGlab(f2));
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /Parent 反查无子票/);
  assert.match(empty.stdout, /init 票号清单/);
  assert.doesNotMatch(empty.stdout, /sub-issues/);
  assert.equal(fs.existsSync(f2.tracker), false, '拒绝即零落盘');
});

test('snapshot-init（gitlab）：分组/项目前缀引用（tools/meta#7042）同过契约形态解析', (t) => {
  const f = makeFixture(t);
  writeStubIssues(f, ISSUES);
  stubState(f, {});
  const r = runLedger(f, 'snapshot-init', ['--spec', `${GITLAB_PROJECT}#7042`], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /票集边界=parent-edges/);
  const specText = fs.readFileSync(path.join(f.tracker, 'spec.md'), 'utf8');
  assert.match(specText, new RegExp(`^Source: ${reEscape(srcUrl(7042))}$`, 'm'), 'Source 行取 issue.web_url（契约原址形态校验）');
});

// ====================================================================
// 同步（GitLab 形态）：note 先行再 close 的等价序列（closeWithComment=false 不丢评论）
// ====================================================================

// 恒定同步场景：合并票 7043（Comments 有 SHA）、升级票 7046（Comments 有原因）、
// 在途票 7045（无事实，不是同步对象）、spec 母票 7042（closing 收尾评论）。
function seedSealFixture(f) {
  fs.mkdirSync(path.join(f.tracker, 'issues'), { recursive: true });
  fs.writeFileSync(
    path.join(f.tracker, 'spec.md'),
    [
      '# Spec: GitLab tracker 一等支持',
      '',
      `Source: ${srcUrl(7042)}`,
      '',
      '**Type:** spec',
      '',
      'spec 正文',
      '',
      '## Comments',
      '',
      '- closing: 已交付：票 7043 合并于主分支，MR !12 待审。',
    ].join('\n') + '\n',
  );
  fs.rmSync(path.join(f.tracker, 'issues'), { recursive: true, force: true });
  fs.mkdirSync(path.join(f.tracker, 'issues'), { recursive: true });
  const wTicket = (num, slug, extra = {}) => {
    const lines = [`# ${num}: ${slug}`, '', `**Status:** ${extra.status ?? 'claimed'}`, '', '**Blocked by:** —'];
    if (extra.comments?.length) lines.push('', '## Comments', '', ...extra.comments.map((c) => `- ${c}`));
    fs.writeFileSync(path.join(f.tracker, 'issues', `${num}-${slug}.md`), lines.join('\n') + '\n');
  };
  wTicket('7043', 'merged', { status: 'resolved', comments: [`merge SHA: ${SHA_A}`] });
  wTicket('7045', 'in-flight', { status: 'claimed' });
  wTicket('7046', 'escalated', { status: 'claimed', comments: ['escalate: 预算用尽'] });
  stubState(f, {
    7042: { state: 'open', assignees: [], comments: [] },
    7043: { state: 'open', assignees: [], comments: [] },
    7045: { state: 'open', assignees: [], comments: [] },
    7046: { state: 'open', assignees: [], comments: [] },
  });
}

test('sync seal（gitlab）：合并票 note 先行再 close、升级票 note 保持开放、spec 母票 note 先行再 close', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 7043), {
    state: 'closed',
    assignees: [],
    comments: [`Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  });
  assert.deepEqual(stateOf(f, 7046), {
    state: 'open',
    assignees: [],
    comments: [`Escalated: 预算用尽\n\n${MARK('escalate')}`],
  });
  assert.deepEqual(stateOf(f, 7042), {
    state: 'closed',
    assignees: [],
    comments: [`已交付：票 7043 合并于主分支，MR !12 待审。\n\n${MARK('closing')}`],
  });
  assert.deepEqual(stateOf(f, 7045), { state: 'open', assignees: [], comments: [] }, '在途票不惊动 tracker');
  assert.equal(viewCmds(f).length, 3, '只拉同步对象的状态（在途票 7045 不发请求）');
  assert.match(r.stdout, /同步完成：5 个动作/);
  assert.match(r.stdout, /✓ close 7043/);
  assert.match(r.stdout, /✓ comment 7046/);
  assert.match(r.stdout, /✓ close 7042/);
  assert.match(r.stdout, /清理 tracker 快照/);
});

test('sync seal（gitlab）：桩日志验 note-then-close 时序，且 close 不携带评论参数', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const log = calls(f);
  const mergeNote = log.findIndex((l) => l.includes('issue note 7043 --message') && l.includes('merge SHA'));
  const mergeClose = log.findIndex((l) => /(^|\s)issue close 7043(\s|$)/.test(l));
  assert.ok(mergeNote !== -1 && mergeClose !== -1, '合并票 note 与 close 调用真实发生');
  assert.ok(mergeNote < mergeClose, `note 先行再 close（${mergeNote} < ${mergeClose}）`);
  const closeNote = log.findIndex((l) => l.includes('issue note 7042 --message') && l.includes('已交付：票 7043'));
  const closeMs = log.findIndex((l) => /(^|\s)issue close 7042(\s|$)/.test(l));
  assert.ok(closeNote !== -1 && closeMs !== -1, 'spec 收尾 note 与 close 调用真实发生');
  assert.ok(closeNote < closeMs, 'spec 收尾同样 note 先行再 close');
  assert.ok(markerNear(rawLog(f), 'issue note 7043 --message ', MARK('merge')), 'note 携带 marker：merge');
  assert.ok(markerNear(rawLog(f), 'issue note 7046 --message ', MARK('escalate')), 'note 携带 marker：escalate');
  assert.ok(markerNear(rawLog(f), 'issue note 7042 --message ', MARK('closing')), 'note 携带 marker：closing');
  assert.doesNotMatch(rawLog(f), /issue close[^\n]*--(message|comment)/, 'close 模板不带评论参数');
});

test('sync 幂等重跑（gitlab）：已关不重关、已评不重评——第二次执行零动作零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(first.status, 0, first.stdout);
  const before = writes(f);

  const second = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  assert.equal(writes(f), before, '重跑不产生任何新写入');
  assert.equal(stateOf(f, 7043).comments.length, 1, '评论不重复');
  assert.equal(stateOf(f, 7046).comments.length, 1);
});

test('sync 幂等重跑（gitlab）：人改写/翻译正文后重跑零动作（只认 marker）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const first = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(first.status, 0, first.stdout);

  // 模拟人类改写：正文换译写、追加补充——只留 marker（HTML 注释人类不可见）
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues['7043'].comments = [`Merged (merge commit: ${SHA_A.slice(0, 7)}).\n\n<!-- matt-implement:${RUN}:merge -->`];
  s.issues['7046'].comments = ['Escalated: budget exhausted.\n\n<!-- matt-implement:demo:escalate -->'];
  s.issues['7042'].comments = ['Delivered.\n\n<!-- matt-implement:demo:closing -->'];
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const before = writes(f);
  const second = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /已同步：无待推送动作/);
  assert.equal(writes(f), before, '改写正文后重跑：零动作零写入');
});

test('sync 部分同步续作（gitlab）：spec 收尾 close 失败 → 重跑只补 spec 的 note+close，其余零重复', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r1 = runLedger(f, 'sync', [], { ...withGlab(f), GLAB_STUB_FAIL_WRITE: '7042' });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout, /同步失败/);
  assert.match(r1.stdout, /未完成/);
  // 已完成的部分真实生效：7043 已关且已评、7046 已评
  assert.equal(stateOf(f, 7043).state, 'closed');
  assert.equal(stateOf(f, 7043).comments.length, 1);
  assert.equal(stateOf(f, 7046).comments.length, 1);
  assert.equal(stateOf(f, 7042).state, 'open', '未完成动作不落任何状态');

  // 重跑：规划器看到已推送的痕迹 → 只补 spec 母票 note+close（先评后关各一次）
  const before = writes(f);
  const r2 = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r2.status, 0, r2.stdout);
  assert.match(r2.stdout, /同步完成/);
  assert.equal(stateOf(f, 7042).state, 'closed');
  assert.equal(stateOf(f, 7043).comments.length, 1, '已完成部分不重复');
  assert.equal(stateOf(f, 7046).comments.length, 1, '已完成部分不重复');
  assert.equal(writes(f) - before, 2, '重跑只补 spec 的 note + close 两个动作');
});

test('sync 部分同步续作（gitlab）：合并票被抢跑 close、评论未推 → 重跑只补评不重关', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  s.issues['7043'].state = 'closed';
  fs.writeFileSync(f.stateFile, JSON.stringify(s));

  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 7043), {
    state: 'closed',
    assignees: [],
    comments: [`Merged (merge SHA: ${SHA_A})\n\n${MARK('merge')}`],
  }, '已关不重关，补评论恰一次');
  assert.match(r.stdout, /同步完成/);
});

// ====================================================================
// abandon（GitLab 形态）：留评说明 + 撤占坑（update --unassign）
// ====================================================================

// #16：真实 init + 外部 PATH 桩故障；不模拟编排器的封账/ready/停止 child 决定。
function seedAbandonFixture(f) {
  seedSealFixture(f);
  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['7042'].assignees = ['alice', 'bob'];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
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
  const r = runLedger(f, 'init', ['--branch', 'feat/demo', '--branch-base', 'main',
    '--baseline-sha', baseline, '--spec', path.join(f.tracker, 'spec.md'), '--test-command', 'npm test']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.writeFileSync(path.join(f.runtime, 'notes.md'), '用户明确放弃；未完成票保留，代码与验证证据已保存。\n');
}

function runEvidence(f) {
  return Object.fromEntries([
    'events.jsonl', 'ledger.md', 'notes.md', 'tracker/spec.md',
    ...lsIssues(f).map((name) => `tracker/issues/${name}`),
  ].map((name) => [name, fs.readFileSync(path.join(f.runtime, name), 'utf8')]));
}

function assertOpenEvidence(f, before) {
  assert.deepEqual(runEvidence(f), before, 'sync 不修改事件、台账、笔记或快照（失败与成功都可核查）');
  assert.match(before['ledger.md'], /state: running/);
  const events = before['events.jsonl'].trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.type === 'close' || (e.type === 'pr' && e.payload.state === 'ready')),
    '放弃同步不封账、不标 ready');
}

const ABANDON_ARGS = ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户明确放弃，保留未完成项'];

function assertAbandonTicketsUntouched(f) {
  for (const num of [7043, 7045, 7046]) {
    assert.deepEqual(stateOf(f, num), { state: 'open', assignees: [], comments: [] },
      `abandon 不同步票 ${num}，包括未完成票与远程延迟的已合并票`);
  }
  assert.doesNotMatch(rawLog(f), /issue (view|close|note|update) (7043|7045|7046)\b/);
  assert.doesNotMatch(rawLog(f), /issue close |\bmr\b/);
}

test('sync abandon（gitlab）：说明失败保持开放与占坑；重试补 note 和撤占坑，不执行 seal/ready', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = runLedger(f, 'sync', ABANDON_ARGS, { ...withGlab(f), GLAB_STUB_FAIL_WRITE: '7042:note' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：comment 7042/);
  assert.match(failed.stdout, /已完成（0\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 7042), { state: 'open', assignees: ['alice', 'bob'], comments: [] });
  assert.doesNotMatch(rawLog(f), /--unassign/, '说明失败不提前撤占坑');
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  const offset = rawLog(f).length;
  const retried = runLedger(f, 'sync', ABANDON_ARGS, withGlab(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：2 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  assert.deepEqual(stateOf(f, 7042), {
    state: 'open', assignees: ['bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  const retryLog = rawLog(f).slice(offset);
  assert.equal((retryLog.match(/issue note 7042 /g) ?? []).length, 1);
  assert.equal((retryLog.match(/issue update 7042 --unassign alice/g) ?? []).length, 1);
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);
});

test('sync abandon（gitlab）：撤占坑失败保留 note 与开放状态；重试只 unassign，之后零动作', (t) => {
  const f = makeFixture(t);
  seedAbandonFixture(f);
  const before = runEvidence(f);
  const failed = runLedger(f, 'sync', ABANDON_ARGS, { ...withGlab(f), GLAB_STUB_FAIL_WRITE: '7042:update' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /同步失败：unassign 7042/);
  assert.match(failed.stdout, /已完成（1\/2）/);
  assert.doesNotMatch(failed.stdout, /清理指引/);
  assert.deepEqual(stateOf(f, 7042), {
    state: 'open', assignees: ['alice', 'bob'],
    comments: [`This run has been abandoned: 用户明确放弃，保留未完成项\n\n${MARK('abandon')}`],
  });
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  const state = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
  state.issues['7042'].comments = [`用户已终结此 run；未完成范围仍开放。\n\n${MARK('abandon')}`];
  fs.writeFileSync(f.stateFile, JSON.stringify(state));
  const offset = rawLog(f).length;
  const retried = runLedger(f, 'sync', ABANDON_ARGS, withGlab(f));
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /同步完成：1 个动作/);
  assert.doesNotMatch(retried.stdout, /PR 标 ready/);
  const retryLog = rawLog(f).slice(offset);
  assert.doesNotMatch(retryLog, /issue (note|close) /);
  assert.equal((retryLog.match(/issue update 7042 --unassign alice/g) ?? []).length, 1);
  assert.deepEqual(stateOf(f, 7042), { ...state.issues['7042'], assignees: ['bob'] });
  assertOpenEvidence(f, before);
  assertAbandonTicketsUntouched(f);

  const afterRetry = rawLog(f).length;
  const again = runLedger(f, 'sync', ABANDON_ARGS, withGlab(f));
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.doesNotMatch(rawLog(f).slice(afterRetry), /issue (close|note|update) /);
  assertOpenEvidence(f, before);
});

test('sync abandon（gitlab）：note 先行留评、撤占坑走 update --unassign；重跑零动作', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  stubState(f, { 7042: { state: 'open', assignees: ['alice'], comments: [] } });
  const r = runLedger(f, 'sync', ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 7042), {
    state: 'open',
    assignees: [],
    comments: [`This run has been abandoned: 用户拍板放弃：终审 not_ready\n\n${MARK('abandon')}`],
  });
  const log = calls(f);
  const note = log.findIndex((l) => l.includes('issue note 7042 --message') && l.includes('This run has been abandoned'));
  const unassign = log.findIndex((l) => /(^|\s)issue update 7042 --unassign alice(\s|$)/.test(l));
  assert.ok(note !== -1 && unassign !== -1 && note < unassign, '放弃同样 note 先行再撤占坑');
  assert.ok(markerNear(rawLog(f), 'issue note 7042 --message ', MARK('abandon')), '放弃留评携带 marker：abandon');
  assert.match(r.stdout, /✓ comment 7042/);
  assert.match(r.stdout, /✓ unassign 7042（alice）/);

  const before = writes(f);
  const again = runLedger(f, 'sync', ['--mode', 'abandon', '--claimant', 'alice', '--reason', '用户拍板放弃：终审 not_ready'], withGlab(f));
  assert.equal(again.status, 0);
  assert.match(again.stdout, /已同步：无待推送动作/);
  assert.equal(writes(f), before, '放弃重跑零写入');
});

test('sync abandon（gitlab）：占坑者已不在（他人已释占）→ 只留说明', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  stubState(f, { 7042: { state: 'open', assignees: [], comments: [] } });
  const r = runLedger(f, 'sync', ['--mode', 'abandon', '--claimant', 'alice', '--reason', '改期重跑'], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 7042).assignees, []);
  assert.equal(stateOf(f, 7042).comments.length, 1);
  assert.doesNotMatch(rawLog(f), /--unassign/);
});

// ====================================================================
// MR 收尾时序：同步须在收尾件标 ready 之前（pr 事件语义不变，GitLab 形态同条执行）
// ====================================================================

test('sync 拒绝（gitlab）：收尾件已标 ready（pr --state ready 已入账）——同步须在标 ready 之前', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'ready' } },
  ]);
  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /PR 已标 ready/);
  assert.match(r.stdout, /之前/);
  assert.equal(calls(f).length, 0, '拒绝面零 tracker 触碰');
});

test('sync 放行（gitlab）：opened-draft（MR 草稿中）不拦同步——同步先于 MR 标 ready', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  writeEvents(f, [
    { type: 'init', seq: 1 },
    { type: 'pr', seq: 2, payload: { state: 'opened-draft' } },
  ]);
  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /同步完成/);
});

// ====================================================================
// claim（GitLab 形态）：先读状态再 update --assignee，冲突不覆盖
// ====================================================================

test('claim（gitlab）成功：先读状态无人占坑 → update --assignee @me 落桩状态', (t) => {
  const f = makeFixture(t);
  stubState(f, { 7042: { state: 'open', assignees: [], comments: [] } });
  const r = runLedger(f, 'claim', ['--spec', '#7042'], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(stateOf(f, 7042).assignees, ['@me'], 'tracker 桩状态：占坑落 assignee');
  const log = calls(f);
  assert.ok(log.some((l) => /^issue view 7042 /.test(l)), '先读状态再写入');
  assert.ok(log.some((l) => l.startsWith('issue update 7042 --assignee @me')), 'claim 走契约 claim 模板');
});

test('claim（gitlab）冲突：他人已在位 → 拒绝并点名在位者，不覆盖（无 claim 写入）', (t) => {
  const f = makeFixture(t);
  stubState(f, { 7042: { state: 'open', assignees: ['bob'], comments: [] } });
  const r = runLedger(f, 'claim', ['--spec', srcUrl(7042)], withGlab(f));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /占坑冲突/);
  assert.match(r.stdout, /bob/);
  assert.deepEqual(stateOf(f, 7042).assignees, ['bob'], '他人占坑零覆盖');
  assert.equal((rawLog(f).match(/--assignee/g) ?? []).length, 0, '冲突路径无 claim 写入');
});

test('claim/sync（gitlab）local 契约与缺 setup 产物：显式停下不猜测', (t) => {
  const localFixture = makeFixture(t, { trackerDoc: readFixture('issue-tracker-local.md') });
  const rl = runLedger(localFixture, 'claim', ['--spec', '7042']);
  assert.equal(rl.status, 1);
  assert.match(rl.stdout, /tracker=local 无 tracker 写面/);

  const noDoc = makeFixture(t, { trackerDoc: null });
  const rn = runLedger(noDoc, 'claim', ['--spec', '7042']);
  assert.equal(rn.status, 1);
  assert.match(rn.stdout, /setup-matt-pocock-skills/);
});

// ====================================================================
// 原址解析（GitLab 形态）：路径形态识别、不认域名——同步面不在 GitHub 域名假设下
// ====================================================================

test('sync（gitlab）：Source 行按 /-/issues/N 路径形态解析母票号（任意域名都不阻碍拉取）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(viewCmds(f).sort(), ['-R tools/meta issue view 7042', '-R tools/meta issue view 7043', '-R tools/meta issue view 7046'], '同步对象精准定位（自建实例路径形态）');
});

// ====================================================================
// 拒绝面（GitLab 形态）：缺快照、已封账、参数缺省、快照形态不合格、拉取失败
// ====================================================================

test('sync 拒绝（gitlab）：快照不存在 / 缺 spec.md / 已封账——零 tracker 触碰', (t) => {
  const f = makeFixture(t);
  const noSnap = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(noSnap.status, 1);
  assert.match(noSnap.stdout, /快照不存在/);
  assert.equal(calls(f).length, 0);

  seedSealFixture(f);
  fs.rmSync(path.join(f.tracker, 'spec.md'));
  const noSpec = runLedger(f, 'sync', [], withGlab(f));
  assert.equal(noSpecOk(noSpec), true);
  function noSpecOk(r) {
    return r.status === 1 && r.stdout.length > 0;
  }

  const f2 = makeFixture(t);
  seedSealFixture(f2);
  writeEvents(f2, [{ type: 'init', seq: 1 }, { type: 'close', seq: 9 }]);
  const closed = runLedger(f2, 'sync', [], withGlab(f2));
  assert.equal(closed.status, 1);
  assert.match(closed.stdout, /已封账/);
  assert.equal(calls(f2).length, 0);
});

test('sync 拉取失败（gitlab）：整体中止、零写入', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  const r = runLedger(f, 'sync', [], { ...withGlab(f), GLAB_STUB_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /拉取失败/);
  assert.equal(writes(f), 0, '零写入（规划先行，失败不推送）');
  assert.equal(stateOf(f, 7043).state, 'open');
});

test('sync 拒绝（gitlab）：abandon 缺 claimant/reason、mode 非法、未知旗标（exit 2 用法拒绝）', (t) => {
  const f = makeFixture(t);
  seedSealFixture(f);
  stubState(f, { 7042: { state: 'open', assignees: [], comments: [] } });
  const noClaimant = runLedger(f, 'sync', ['--mode', 'abandon', '--reason', 'r'], withGlab(f));
  assert.equal(noClaimant.status, 2);
  assert.match(noClaimant.stdout, /--claimant/);
  const noReason = runLedger(f, 'sync', ['--mode', 'abandon', '--claimant', 'alice'], withGlab(f));
  assert.equal(noReason.status, 2);
  assert.match(noReason.stdout, /--reason/);
  const badMode = runLedger(f, 'sync', ['--mode', 'push'], withGlab(f));
  assert.equal(badMode.status, 2);
  assert.match(badMode.stdout, /--mode 非法/);
  const bogus = runLedger(f, 'sync', ['--bogus', 'x'], withGlab(f));
  assert.equal(bogus.status, 2);
  assert.match(bogus.stdout, /未知旗标 --bogus/);
  assert.equal(calls(f).length, 0);
});
