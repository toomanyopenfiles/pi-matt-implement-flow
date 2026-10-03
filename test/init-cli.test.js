'use strict';

// 票 04：契约驱动的 run 初始化——init 子命令黑盒测试（接缝③：真实调用 ledger CLI，
// 断言退出码、stdout、事件流增量）。契约解析由 setup 产物驱动（tracker-contract-core，
// 判型细节在接缝①的纯函数测试里）：CLI 面只测外部行为——
//   - 三种 setup 产物 → init 自动选中对应契约预设，tracker 字段照旧入账（事件格式零迁移）
//   - 缺 setup 产物 → 指引运行 /setup-matt-pocock-skills，停下（exit 1）
//   - 范本认不出 → 「仅支持三种」，停下（exit 1）
//   - --tracker 旗标被硬拒（硬枚举分支删除：不再要求也不接受）
//   - 与 sync-fixture 同一套 PATH 桩纪律：github/gitlab 的快照黑盒在 snapshot-cli.test.js
//     已覆盖（识别结果驱动后续行为 = 同一 runtime 里 snapshot-init/sync 沿用既有拒绝面）

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, '../scripts/ledger.js');
const FIXTURES = path.resolve(__dirname, 'fixtures');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const LOCAL_DOC = read('issue-tracker-local.md');
const EDITED_LOCAL_DOC = read('issue-tracker-local-edited.md');
const GITHUB_DOC = read('issue-tracker-github.md');
const GITLAB_DOC = read('issue-tracker-gitlab.md');
const TRIAGE_CANONICAL = read('triage-labels-canonical.md');
const TRIAGE_CUSTOM = read('triage-labels-custom.md');

// --- fixture 临时仓：本地票文件 + docs/agents/ setup 产物（判型输入）---

function sh(dir, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`fixture 命令失败: ${cmd}\n${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function writeTicketFile(dir, num, title, { status = 'ready-for-agent', type = null, blockedBy = null } = {}) {
  const lines = [`# ${num}: ${title}`, '', `**Status:** ${status}`, ''];
  if (type) lines.push(`**Type:** ${type}`, '');
  lines.push(`**Blocked by:** ${blockedBy ?? '—'}`, '');
  fs.writeFileSync(path.join(dir, `.scratch/demo/issues/${num}-x.md`), lines.join('\n'));
}

function makeFixture(t, { trackerDoc = LOCAL_DOC, triageDoc = TRIAGE_CANONICAL, skipTrackerDoc = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email t@example.com && git config user.name T');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  sh(dir, 'git add -A && git commit -qm baseline');
  fs.mkdirSync(path.join(dir, '.scratch/demo/issues'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.scratch/demo/spec.md'), '# demo spec\n');
  writeTicketFile(dir, '01', '自检基线');
  writeTicketFile(dir, '02', 'README 速览', { blockedBy: '01' });
  if (!skipTrackerDoc) {
    fs.mkdirSync(path.join(dir, 'docs/agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/agents/issue-tracker.md'), trackerDoc);
    if (triageDoc) fs.writeFileSync(path.join(dir, 'docs/agents/triage-labels.md'), triageDoc);
  }
  return {
    dir,
    runtime: path.join(dir, '.pi/matt-implement/demo'),
    bin: null,
    run: (args, extraEnv = {}) => {
      const env = { ...process.env, ...extraEnv };
      if (t.bin) env.PATH = `${t.bin}${path.delimiter}${process.env.PATH}`;
      const r = spawnSync(process.execPath, [LEDGER, ...args], { cwd: dir, encoding: 'utf8', env });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    standards: {},
    git: (cmd) => sh(dir, `git ${cmd}`),
    baseline: () => sh(dir, 'git rev-parse HEAD'),
  };
}

const initRun = (f, extraArgs = []) =>
  f.run(['init', '--runtime-dir', f.runtime, ...extraArgs]);

// ====================================================================
// 三种 setup 产物：识别 → 对应契约预设 → init 入账（事件格式与 tracker 字段零迁移）
// ====================================================================

test('init（local 范本）：自动识别 local tracker，事件 payload 与旧 add init 形态一致', (t) => {
  const f = makeFixture(t);
  assert.equal(initRun(f, ['--branch', 'feat/demo', '--branch-base', 'main']).status, 1, '缺必选参数 → 拒绝（tracker 不在必选参数里）');
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo',
    '--branch-base', 'main',
    '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md',
    '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=local/, '识别结果与后续行为的驱动源，记账展示必须点名');
  const eventsPath = path.join(f.runtime, 'events.jsonl');
  const events = fs.readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.v, 3, '信封版本随事件分类学（事件格式零迁移）');
  assert.equal(e.seq, 1);
  assert.equal(e.type, 'init');
  assert.deepEqual(e.payload, {
    branch: 'feat/demo',
    branchBase: 'main',
    baselineSha: f.baseline(),
    spec: '.scratch/demo/spec.md',
    testCommand: 'npm test',
    tracker: 'local',
  }, 'tracker 字段值语义照旧——账本与审计工具照常渲染');
  assert.equal(e.head, f.baseline(), 'HEAD 锚点由脚本盖（LLM 不提供时间/序号）');
  const ledger = fs.readFileSync(path.join(f.runtime, 'ledger.md'), 'utf8');
  assert.match(ledger, /tracker: local/);
  assert.match(ledger, /state: running/);
});

test('init（local 范本，用户编辑过正文）：判型只依赖 H1 + 锚点，正文编辑不影响识别', (t) => {
  const f = makeFixture(t, { trackerDoc: EDITED_LOCAL_DOC });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=local/);
});

test('init（github 范本）：识别 github 契约——tracker 字段照旧入账（零迁移）', (t) => {
  const f = makeFixture(t, { trackerDoc: GITHUB_DOC });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=github/);
  const e = JSON.parse(fs.readFileSync(path.join(f.runtime, 'events.jsonl'), 'utf8').trim());
  assert.equal(e.type, 'init');
  assert.equal(e.payload.tracker, 'github');
  const ledger = fs.readFileSync(path.join(f.runtime, 'ledger.md'), 'utf8');
  assert.match(ledger, /tracker: github/);
});

test('init（gitlab 范本）：识别 gitlab 契约（事件格式与 tracker 字段语义照旧）', (t) => {
  const f = makeFixture(t, { trackerDoc: GITLAB_DOC });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=gitlab/);
  const e = JSON.parse(fs.readFileSync(path.join(f.runtime, 'events.jsonl'), 'utf8').trim());
  assert.equal(e.payload.tracker, 'gitlab');
});

test('init（custom triage 词表）：词表映射拉取时钉死，不改变识别与默认形态', (t) => {
  const f = makeFixture(t, { triageDoc: TRIAGE_CUSTOM });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=local/);
});

test('init（缺 triage-labels.md）：合法常态——canonical 默认并注记，照常识别', (t) => {
  const f = makeFixture(t, { trackerDoc: LOCAL_DOC, triageDoc: null });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tracker=local/);
});

// ====================================================================
// 两种错误路径：缺 setup 产物 → 指引运行 setup；认不出 → 「仅支持三种」。都停下不降级
// ====================================================================

test('init 拒绝：缺 setup 产物 → 指引运行 /setup-matt-pocock-skills，退出码 1，不降级不落账', (t) => {
  const f = makeFixture(t, { skipTrackerDoc: true });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /setup-matt-pocock-skills/, '指引点名 setup 命令');
  assert.match(r.stdout, /issue-tracker\.md/, '点名缺的文档');
  assert.doesNotMatch(r.stdout, /tracker=/, '识别失败 → 没有 tracker 可展示');
  assert.ok(!fs.existsSync(path.join(f.runtime, 'events.jsonl')), '识别失败 → 全不落账');
});

test('init 拒绝：范本认不出 → 「仅支持三种」显式停下，退出码 1，不落账', (t) => {
  const f = makeFixture(t, {
    trackerDoc: '# Issue tracker: Jira\n\nIssues live in Jira. Use `jira` CLI.\n\n## Conventions\n\n- one dir one feature\n',
  });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /仅支持.*local.*github.*gitlab/, '点名仅支持的三种范本');
  assert.match(r.stdout, /jira/i, '点名认不出的范本（范本标题归一后展示）');
  assert.doesNotMatch(r.stdout, /tracker=/);
  assert.ok(!fs.existsSync(path.join(f.runtime, 'events.jsonl')));
});

test('init 拒绝：triage-labels.md 违约（label 重复）→ ADR-0006 错误（文件+行+列+期望），不落账', (t) => {
  const f = makeFixture(t, {
    trackerDoc: LOCAL_DOC,
    triageDoc: [
      '# Triage Labels',
      '',
      '| Label in mattpocock/skills | Label in our tracker |',
      '| --- | --- |',
      '| `needs-triage` | `todo` |',
      '| `needs-info` | `todo` |',
      '| `ready-for-agent` | `ai` |',
      '| `ready-for-human` | `human` |',
      '| `wontfix` | `never` |',
      '',
    ].join('\n'),
  });
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
  ]);
  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /label 重复/);
  assert.match(out, /第 \d+ 行第 \d+ 列/);
  assert.match(out, /全表唯一/);
  assert.ok(!fs.existsSync(path.join(f.runtime, 'events.jsonl')), '契约解析在任何写入前失败——零半成品');
});

// ====================================================================
// --tracker 旗标：不要求也不接受——硬枚举分支删除
// ====================================================================

test('init 拒绝 --tracker 旗标（旧双轨配置废除）：schema 层未知旗标，退出码 1，不落账', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const r = initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test',
    '--tracker', 'gitlab', // 无中生有的 tracker 旗标：识别结果以 setup 产物为准，不接受重复声明
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /--tracker/);
  assert.match(r.stdout, /setup 产物|issue-tracker\.md/, '错误文案点名配置单源（契约驱动：识别是唯一来源）');
  assert.ok(!fs.existsSync(path.join(f.runtime, 'events.jsonl')), '被拒的旗标不入账');
});

test('add init 不再存在：init 只能以 init 子命令记账；unknown-flag 对任何事件皆拒', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  const r = f.run(['add', 'init', '--runtime-dir', f.runtime, '--branch', 'feat/demo']);
  assert.equal(r.status, 1, 'init 不是 add 的事件类型（唯一写面移动到 init 子命令）');
  assert.match(r.stdout, /init/);
  const nonInit = f.run([
    'add', 'dispatch', '--runtime-dir', f.runtime,
    '--ticket', '01', '--key', 't-01', '--run-id', 'aaaaaaaa', '--tracker', 'github',
  ]);
  assert.equal(nonInit.status, 1, '--tracker 对任何事件都不是合法旗标（离开 init 状态机执法面，schema 层拒绝）');
  assert.match(nonInit.stdout, /--tracker/);
});

// ====================================================================
// local 契约：快照/同步为无操作，全流程行为零变化（含在途 run 续跑）
// ====================================================================

test('in-flight resume + ticket-set boundary：init 之后 ledger 的既有面照常运转（行为零变化）', (t) => {
  const f = makeFixture(t);
  f.git('checkout -q -b feat/demo');
  assert.equal(initRun(f, [
    '--branch', 'feat/demo', '--branch-base', 'main', '--baseline-sha', f.baseline(),
    '--spec', '.scratch/demo/spec.md', '--test-command', 'npm test', '--tickets', '01,02',
  ]).status, 0);
  const r = f.run([
    'add', 'dispatch', '--runtime-dir', f.runtime, '--ticket', '01', '--key', 't-01', '--run-id', 'aaaaaaaa',
  ]);
  assert.equal(r.status, 0, r.stdout);
  const boundary = f.run([
    'add', 'dispatch', '--runtime-dir', f.runtime, '--ticket', '03', '--key', 't-03', '--run-id', 'bbbbbbbb',
  ]);
  assert.equal(boundary.status, 1, '票集边界（init 冻结票号清单）外票同样在契约驱动的 run 里被拒');
  assert.match(boundary.stdout, /票集边界/);
  const check = f.run(['check', '--runtime-dir', f.runtime]);
  assert.equal(check.status, 0, check.stdout);
});
