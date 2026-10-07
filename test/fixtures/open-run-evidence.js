'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LEDGER = path.resolve(__dirname, '../../scripts/ledger.js');

// #16：真实 git baseline + CLI init；env 只保留调用方既有的 PATH 桩环境。
function initOpenRun(f, env) {
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
    cwd: f.dir, encoding: 'utf8', env,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  fs.writeFileSync(path.join(f.runtime, 'notes.md'), '用户明确放弃；未完成票保留，代码与验证证据已保存。\n');
}

function runEvidence(f, issueNames = fs.readdirSync(path.join(f.tracker, 'issues'))) {
  return Object.fromEntries([
    'events.jsonl', 'ledger.md', 'notes.md', 'tracker/spec.md',
    ...issueNames.map((name) => `tracker/issues/${name}`),
  ].map((name) => [name, fs.readFileSync(path.join(f.runtime, name), 'utf8')]));
}

function assertOpenEvidence(after, before) {
  assert.deepEqual(after, before, 'sync 不修改事件、台账、笔记或快照（失败与成功都可核查）');
  assert.match(before['ledger.md'], /state: running/);
  const events = before['events.jsonl'].trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(!events.some((e) => e.type === 'close' || (e.type === 'pr' && e.payload.state === 'ready')),
    '放弃同步不封账、不标 ready');
}

module.exports = { initOpenRun, runEvidence, assertOpenEvidence };
