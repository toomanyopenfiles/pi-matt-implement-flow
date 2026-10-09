'use strict';

// 运行时限解析 CLI 黑盒测试（issue #26 接缝：「下一次派发生效」的解析面）。
// 真实调用 node scripts/flow-config-cli.js，断言退出码与一行 JSON：
//   - 无覆盖 → 4h 默认值（与 agent frontmatter 同口径）
//   - project 覆盖赢 user 覆盖
//   - 手写非法值不采纳、不写入，明确列入 invalid（0 / false 不是无限时长）
//   - 同一目录改配置后再次调用立即读到新值（= 同一未封账 run 中下一次派发生效）
// 对包目录只读；fixture 只写临时目录。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '../scripts/flow-config-cli.js');
const FLOW_SECTION = 'mattImplementFlow';
const RUN_TIMEOUT_KEY = 'agentTimeoutMs';

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-config-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDir = path.join(root, 'user-agent');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(userDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.pi'), { recursive: true });
  return { root, userDir, projectDir };
}

function runTimeout(fixture, { cwd = fixture.projectDir, settingsPaths = false } = {}) {
  const r = spawnSync(process.execPath, [CLI, 'run-timeout', '--cwd', cwd, ...(settingsPaths ? ['--settings-paths'] : [])], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PI_CODING_AGENT_DIR: fixture.userDir },
  });
  assert.equal(r.status, 0, `CLI failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function writeSettings(filePath, settings) {
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
}

test('no override → the 4h package default, source default', (t) => {
  const f = makeFixture(t);
  assert.deepEqual(runTimeout(f), { timeoutMs: 14400000, source: 'default', invalid: [] });
});

test('project override wins user override; each layer alone resolves with its own source', (t) => {
  const f = makeFixture(t);
  writeSettings(path.join(f.userDir, 'settings.json'), { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 7200000 } });
  assert.deepEqual(runTimeout(f), { timeoutMs: 7200000, source: 'user', invalid: [] });
  writeSettings(path.join(f.projectDir, '.pi', 'settings.json'), { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 3600000 } });
  assert.deepEqual(runTimeout(f), { timeoutMs: 3600000, source: 'project', invalid: [] });
});

test('hand-edited invalid values are ignored with an explicit invalid note — never an infinite run', (t) => {
  const f = makeFixture(t);
  writeSettings(path.join(f.userDir, 'settings.json'), { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 7200000 } });
  writeSettings(path.join(f.projectDir, '.pi', 'settings.json'), { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 0 } });
  const out = runTimeout(f);
  assert.equal(out.timeoutMs, 7200000, 'invalid project value falls back to the user layer');
  assert.equal(out.source, 'user');
  assert.deepEqual(out.invalid, [{ scope: 'project', raw: 0 }]);
  writeSettings(path.join(f.projectDir, '.pi', 'settings.json'), { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 2147483648 } });
  assert.deepEqual(runTimeout(f).invalid, [{ scope: 'project', raw: 2147483648 }]);
});

test('a settings change is visible to the very next resolution (the next dispatch, no re-init)', (t) => {
  const f = makeFixture(t);
  const projectSettings = path.join(f.projectDir, '.pi', 'settings.json');
  writeSettings(projectSettings, { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 3600000 } });
  assert.equal(runTimeout(f).timeoutMs, 3600000);
  writeSettings(projectSettings, { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 7200000 } });
  assert.equal(runTimeout(f).timeoutMs, 7200000, 'value A → B must land at the next dispatch');
  // 清除覆盖 → 恢复默认
  writeSettings(projectSettings, {});
  assert.deepEqual(runTimeout(f), { timeoutMs: 14400000, source: 'default', invalid: [] });
});

test('review briefs can carry the main-repo settings paths, not isolated worktree paths', (t) => {
  const f = makeFixture(t);
  const out = runTimeout(f, { settingsPaths: true });
  assert.deepEqual(out.settingsPaths, {
    user: path.join(f.userDir, 'settings.json'),
    project: path.join(f.projectDir, '.pi', 'settings.json'),
  });
  assert.equal(out.timeoutMs, 14400000);
  const noProject = runTimeout(f, { cwd: f.root, settingsPaths: true });
  assert.equal(noProject.settingsPaths.project, null);
});

test('bad invocation exits non-zero with usage; broken settings JSON fails loud', (t) => {
  const f = makeFixture(t);
  const bad = spawnSync(process.execPath, [CLI, 'freeze'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage:/);
  const badArg = spawnSync(process.execPath, [CLI, 'run-timeout', '--bogus'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(badArg.status, 1);
  assert.match(badArg.stderr, /unknown argument/);
  fs.writeFileSync(path.join(f.projectDir, '.pi', 'settings.json'), '{oops');
  const broken = spawnSync(process.execPath, [CLI, 'run-timeout', '--cwd', f.projectDir], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.userDir },
  });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /run-timeout resolution failed/);
});
