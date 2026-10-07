'use strict';

// GitHub 形态同步 fixture（从 test/sync-cli.test.js 提取的真实重复）：tracker 快照直落 +
// 有状态 gh 桩（PATH 注入）+ sync 黑盒入口 + marker 断言助手。被测脚本路径可注入：
// 包级系统回归以 MATT_IMPLEMENT_LEDGER 指到 tarball 解包出的包内 scripts/ledger.js
// （测试专用开关，非生产钩子）。

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { GH_STUB } = require('./gh-stub');

const LEDGER = process.env.MATT_IMPLEMENT_LEDGER || path.resolve(__dirname, '../../scripts/ledger.js');

// 票 02：同步幂等机器 marker——run 标识 = --runtime-dir 目录名（fixture 恒 'demo'）。
const RUN = 'demo';
const MARK = (kind) => `<!-- matt-implement:${RUN}:${kind} -->`;

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
    fs.copyFileSync(path.join(__dirname, trackerDoc), path.join(dir, 'docs/agents/issue-tracker.md'));
    fs.copyFileSync(path.join(__dirname, 'triage-labels-canonical.md'), path.join(dir, 'docs/agents/triage-labels.md'));
  }
  const runtime = path.join(dir, '.pi/matt-implement/demo');
  const tracker = path.join(runtime, 'tracker');
  fs.mkdirSync(path.join(tracker, 'issues'), { recursive: true });
  return { dir, bin, runtime, tracker, stateFile: path.join(dir, 'gh-state.json'), logFile: path.join(dir, 'gh-log.txt'), eventsPath: path.join(runtime, 'events.jsonl'), ledgerPath: path.join(runtime, 'ledger.md') };
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

module.exports = {
  LEDGER, RUN, MARK, SHA_A,
  makeFixture, writeSpec, writeTicket, stubState, sync, withGh,
  rawLog, callLog, reEscape, markerNear, stateOf, isViewCall,
};
