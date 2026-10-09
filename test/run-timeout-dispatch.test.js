'use strict';

// 执行生产 workflow 函数体，只替换平台派发边界；不启动模型、不跑门禁。
// CLI → 模板参数替换仍模拟编排器动作，不证明模型会执行配置读取指令。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const axisScript = fs.readFileSync(path.join(ROOT, 'scripts/axis-axes.js'), 'utf8');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDir = path.join(root, 'user');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(userDir);
  fs.mkdirSync(path.join(projectDir, '.pi'), { recursive: true });
  return { root, userDir, projectDir };
}

function setTimeoutValue(f, value) {
  fs.writeFileSync(path.join(f.projectDir, '.pi', 'settings.json'), JSON.stringify({
    mattImplementFlow: { agentTimeoutMs: value },
  }));
}

function resolve(f) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/flow-config-cli.js'),
    'run-timeout', '--cwd', f.projectDir, '--settings-paths'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PI_CODING_AGENT_DIR: f.userDir },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function dispatchBoundary() {
  const items = [];
  const runs = {
    async all(entries) {
      items.push(...entries);
      return entries.map((entry) => ({ key: entry.key, ok: true, runId: entry.key }));
    },
    async run(key, entry) {
      items.push({ key, ...entry });
      return { key, ok: true, runId: key };
    },
  };
  return { runs, items };
}

test('all fresh top-level workflow templates send the latest A → B value to the dispatch boundary', async (t) => {
  const f = fixture(t);
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const blocks = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  const fresh = blocks.filter((block) => /agent:\s*"pi-matt-implement-flow\./.test(block));
  assert.equal(fresh.length, 4, 'ticket coder/reviewer, integration fixer, final fixer');
  // These two documented dispatch shapes have no fenced template of their own.
  const final = skill.match(/dispatch `pi-matt-implement-flow\.final-reviewer` with `([^`]+)`, `(timeoutMs: RUN_TIMEOUT_MS)`/);
  const fallback = skill.match(/dispatched as `(worktree: true, baseRef: "refs\/heads\/ticket-<NN>", acceptance: false, timeoutMs: RUN_TIMEOUT_MS)`/);
  assert.ok(final && fallback, 'final reviewer and integrity fallback must remain testable dispatch shapes');
  const shapes = [
    ...fresh,
    `const RUN_TIMEOUT_MS = 14400000; await runs.run("final", { agent: "pi-matt-implement-flow.final-reviewer", ${final[1]}, ${final[2]} });`,
    `const RUN_TIMEOUT_MS = 14400000; await runs.run("fallback", { agent: "pi-matt-implement-flow.coder", ${fallback[1]} });`,
  ];
  const previous = [];
  for (const expected of [3600000, 28800000]) {
    setTimeoutValue(f, expected);
    const latest = resolve(f);
    for (const script of shapes) {
      const boundary = dispatchBoundary();
      // Explicitly model the orchestrator's documented substitution step.
      const generated = script.replace('const RUN_TIMEOUT_MS = 14400000;', `const RUN_TIMEOUT_MS = ${latest.timeoutMs};`);
      await new AsyncFunction('runs', generated)(boundary.runs);
      assert.ok(boundary.items.length > 0);
      assert.ok(boundary.items.every((item) => item.timeoutMs === expected));
      for (const item of boundary.items) {
        if (item.gate) assert.equal(item.gate.timeoutMs, 600000, 'test gate budget is independent');
      }
      if (expected === 3600000) previous.push(...boundary.items);
    }
  }
  assert.ok(previous.every((item) => item.timeoutMs === 3600000), 'later config does not mutate prior dispatch parameters');
});

test('the actual retained-resume template sends no timeout override after a settings change', async (t) => {
  const f = fixture(t);
  setTimeoutValue(f, 28800000);
  assert.equal(resolve(f).timeoutMs, 28800000);
  const skill = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');
  const resume = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((m) => m[1]).find((block) => block.includes('resume:'));
  assert.ok(resume);
  const boundary = dispatchBoundary();
  await new AsyncFunction('runs', resume)(boundary.runs);
  assert.equal(boundary.items.length, 1);
  assert.equal(boundary.items[0].resume, '<coderRunId>');
  assert.equal(Object.hasOwn(boundary.items[0], 'timeoutMs'), false);
  assert.equal(Object.hasOwn(boundary.items[0], 'maxRuntimeMs'), false);
});

test('axis script refuses missing or invalid deadlines before launching either child', async () => {
  for (const timeoutMs of [undefined, false, 0, -1, 1.5, '14400000', 2147483648]) {
    const boundary = dispatchBoundary();
    await assert.rejects(new AsyncFunction('args', 'runs', axisScript)({
      agent: 'pi-matt-implement-flow.reviewer', standards: 'standards', spec: 'spec', timeoutMs,
    }, boundary.runs), /timeoutMs.*positive integer.*2147483647/);
    assert.deepEqual(boundary.items, []);
  }
});

test('axis dispatches use B after a reviewer started with A, for both reviewer roles', async (t) => {
  const f = fixture(t);
  for (const role of ['reviewer', 'final-reviewer']) {
    setTimeoutValue(f, 7200000);
    const parent = resolve(f);
    setTimeoutValue(f, 28800000);
    const latest = resolve(f);
    const boundary = dispatchBoundary();
    const result = await new AsyncFunction('args', 'runs', axisScript)({
      agent: `pi-matt-implement-flow.${role}`, context: 'fork',
      standards: 'Read-only standards review', spec: 'Read-only spec review',
      timeoutMs: latest.timeoutMs,
    }, boundary.runs);
    assert.equal(parent.timeoutMs, 7200000, 'an already-started parent retains its launch value');
    assert.deepEqual(boundary.items.map(({ key, timeoutMs }) => ({ key, timeoutMs })), [
      { key: 'standards', timeoutMs: 28800000 }, { key: 'spec', timeoutMs: 28800000 },
    ]);
    assert.ok(boundary.items.every((item) => item.agent === `pi-matt-implement-flow.${role}`));
    assert.deepEqual(result.map((r) => r.key), ['standards', 'spec']);
  }
});
