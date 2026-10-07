'use strict';

// 共享 fixture 基元（从 test/ledger-cli.test.js 提取的真实重复）：临时 git 仓 + 票文件 +
// setup 产物铺底，以及 add/build/check 黑盒入口。被测脚本路径可注入：
// 包级系统回归把 MATT_IMPLEMENT_LEDGER 指到 npm tarball 解包出的包内 scripts/ledger.js，
// 源码级测试缺省仍指向仓库 scripts/（测试专用开关，不是生产钩子）。

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LEDGER = process.env.MATT_IMPLEMENT_LEDGER || path.resolve(__dirname, '../../scripts/ledger.js');

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

function makeFixture(t, { tickets = true, remote = null, trackerDoc = 'issue-tracker-local.md' } = {}) {
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
  // setup 产物（票 04）：ledger-cli.test 的默认铺底按 local 范本判型——契约识别的判型输入，
  // 复用 test/fixtures 的既有范本 / 词表 fixture；trackerDoc 可换 github 等预设范本。
  const fixturesDir = __dirname;
  fs.mkdirSync(path.join(dir, 'docs/agents'), { recursive: true });
  fs.copyFileSync(path.join(fixturesDir, trackerDoc), path.join(dir, 'docs/agents/issue-tracker.md'));
  fs.copyFileSync(path.join(fixturesDir, 'triage-labels-canonical.md'), path.join(dir, 'docs/agents/triage-labels.md'));
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

// --- 标准运行铺底：init（契约驱动子命令）+ dispatch/settled/verdict ---
// extra：追加 init 旗标（如票集边界 --tickets）；不传则维持零旗标的形态。
// fixture 仓默认带 docs/agents/issue-tracker.md（local 范本）——契约识别的判型输入。
function initRun(f, extra = {}) {
  f.git('checkout -q -b feat/demo');
  const r = initAll(f, {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
    ...extra,
  });
  assert.equal(r.status, 0, r.stdout);
  return r;
}

// init 子命令的二跑（重复记账执法面的探针）：同一 fixture 上再执行一次 init。
function initRun2nd(f) {
  return initAll(f, {
    branch: 'feat/demo',
    'branch-base': 'main',
    'baseline-sha': f.baseline(),
    spec: '.scratch/demo/spec.md',
    'test-command': 'npm test',
  });
}

// init 子命令（票 04 契约驱动）：tracker 不再是旗标——setup 产物识别，无 initRun 之外的铺底。
// opts.env 可注入 PATH（prProbe 桩等 PATH 注入用例，票 05 起探测走契约模板仍认 PATH 桩）。
function initAll(f, flags = {}, { env } = {}) {
  const args = ['init', '--runtime-dir', f.runtime];
  for (const [k, v] of Object.entries(flags)) {
    if (v === undefined) continue;
    args.push(`--${k}`);
    if (v !== '') args.push(String(v));
  }
  return ledger(args, { cwd: f.dir, env });
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


module.exports = {
  sh,
  writeTicketFile,
  makeFixture,
  ledger,
  addAll,
  readEvents,
  readLedger,
  initRun,
  initRun2nd,
  initAll,
  makeWorktree,
  mergeTicket,
};
