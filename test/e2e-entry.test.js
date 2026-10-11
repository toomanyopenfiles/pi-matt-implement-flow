'use strict';

// 票 34：真实模型验收入口（test/e2e/accept.js）的黑盒护栏测试。
//
// 被测面 = 进程边界上的入口行为（argv / env / 退出码 / stdout / 产物文件）。
// 一切模型调用在调用边界上被替换为桩：桩平台二进制（test/fixtures/e2e-stub-pi.js）
// 与桩探针（test/fixtures/e2e-stub-probe.js，经 test/fixtures/e2e-stub-scenarios.js
// 声明）。本文件永不为护栏付费，也不证明任何真实模型行为。
//
// 验证层级：CLI 黑盒。边界：不证明真实模型能从主干找到指令、不证明平台真实派发形态、
// 不证明真实 provider 可用性——那些属于需要人工授权的真实模型批次。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO_ROOT, 'test', 'e2e', 'accept.js');
const REAL_SCENARIOS = path.join(REPO_ROOT, 'test', 'e2e', 'scenarios.js');
const STUB_SCENARIOS = path.join(REPO_ROOT, 'test', 'fixtures', 'e2e-stub-scenarios.js');
const STUB_PI = path.join(REPO_ROOT, 'test', 'fixtures', 'e2e-stub-pi.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-entry-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

let seq = 0;
const caseDir = () => fs.mkdtempSync(path.join(tmpRoot, `case-${seq++}-`));

// ---------------------------------------------------------------- 调用边界装置

// 桩装置：桩平台二进制 + 桩场景模块 + 两份调用日志 + 独立 TMPDIR。
// TMPDIR 独立的意义：真实探针一旦被启动就会在那里 mkdtemp 出证据目录，
// 于是"零调用"断言同时覆盖入口与探针两层。
function harness({ scenarios = [{ id: 'stub-a', mode: 'pass' }], realScenarios = false } = {}) {
  const dir = caseDir();
  const piLog = path.join(dir, 'pi.jsonl');
  const probeLog = path.join(dir, 'probe.jsonl');
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const piBin = path.join(dir, 'pi');
  fs.copyFileSync(STUB_PI, piBin);
  fs.chmodSync(piBin, 0o755);

  const env = {
    ...process.env,
    ...(realScenarios ? {} : { PI_E2E_SCENARIOS: STUB_SCENARIOS, STUB_SCENARIOS: JSON.stringify(scenarios) }),
    PI_E2E_PI_BIN: piBin,
    STUB_PI_LOG: piLog,
    STUB_LOG: probeLog,
    TMPDIR: tmpdir,
  };
  const lines = (file) => (fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);
  return {
    dir,
    env,
    tmpdir,
    out: path.join(dir, 'out'),
    piCalls: () => lines(piLog),
    probeCalls: () => lines(probeLog),
    // 模型调用 = 任何非 `--version` 的平台调用；预检里的 `--version` 不是模型调用。
    modelCalls: function modelCalls() {
      return this.piCalls().filter((c) => !c.argv.includes('--version') && !c.argv.includes('-v'));
    },
  };
}

function runEntry(h, args, { input = '', env = {}, timeout = 120000 } = {}) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: { ...h.env, ...env },
    input, // 管道 stdin = 非交互环境
    encoding: 'utf8',
    timeout,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const planJson = (h, args = [], opts = {}) => {
  const r = runEntry(h, [...args, '--json'], opts);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return { ...r, doc: JSON.parse(r.stdout) };
};

// ====================================================================
// 预检与计划展示：默认无模型调用
// ====================================================================

test('预检/计划模式：默认只展示计划，零模型调用、零探针启动，退出码 0', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }, { id: 'stub-b', mode: 'fail' }] });
  const r = runEntry(h, ['--out', h.out]);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /预检/);
  assert.match(r.stdout, /计划/);
  assert.match(r.stdout, /实际模型调用/, '计划模式必须说明自己不会启动模型');
  assert.equal(h.probeCalls().length, 0, '计划模式不启动探针');
  assert.equal(h.modelCalls().length, 0, '计划模式不产生模型调用');
  assert.equal(fs.readdirSync(h.tmpdir).length, 0, '计划模式不创建探针证据目录');
  assert.equal(fs.existsSync(h.out), false, '计划模式不创建证据目录');
});

test('计划展示：被测版本、场景、对照、模型/provider/thinking、平台版本、次数、调用上限、并发、超时、重试、费用、写入范围', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const { doc } = planJson(h);

  assert.equal(doc.schema, 'e2e-plan-1');
  assert.match(doc.approvalHash, /^[0-9a-f]{12}$/, '计划携带可复制的授权哈希');

  const plan = doc.plan;
  assert.equal(plan.target.name, 'pi-matt-implement-flow');
  assert.equal(plan.target.version, JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version);
  assert.match(plan.target.headSha, /^[0-9a-f]{40}$/, '被测版本绑定提交');
  assert.equal(plan.platform.model, 'opencode-go/muse-spark-1.3-contributor');
  assert.equal(plan.platform.thinking, 'high');
  assert.equal(plan.platform.version, '9.9.9-stub', '平台版本来自无模型调用的版本探测');
  assert.equal(plan.comparison.mode, 'none');
  assert.equal(plan.scenarios.length, 1);
  assert.equal(plan.scenarios[0].id, 'stub-a');
  assert.equal(plan.scenarios[0].runs, 1, '次数在计划里');
  assert.equal(plan.scenarios[0].attemptTimeoutMs, 30000, '超时在计划里');
  assert.equal(plan.scenarios[0].concurrency, 1, '并发在计划里');
  assert.equal(plan.counts.plannedCalls, 1);
  assert.equal(plan.counts.callCap, 1);
  assert.equal(plan.counts.retryBudget, 0);
  assert.equal(plan.cost.estimate, 'unknown', '无法估算时明确说明');
  assert.match(plan.cost.note, /不是精确金额上限/, '不把调用数/超时宣称为金额上限');
  assert.equal(plan.guardrail.kind, 'mis-trigger-prevention');
  assert.match(plan.guardrail.note, /不是权限隔离|不构成权限隔离/, '不宣称不可绕过');
  assert.match(plan.writeScope.files, /临时|证据/);
  assert.match(plan.writeScope.network, /provider|无/);
  assert.equal(plan.writeScope.remoteWrites, '无');
});

test('计划哈希：同一批参数可复现；范围漂移（场景/次数/模型/超时/额度/对照）即改哈希', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }, { id: 'stub-b', mode: 'pass' }] });
  const base = planJson(h).doc.approvalHash;
  assert.equal(planJson(h).doc.approvalHash, base, '同样输入两次得到同一哈希');

  const drift = [
    ['--scenario', 'stub-a'],
    ['--runs', '2'],
    ['--retries', '1'],
    ['--call-cap', '9'],
    ['--model', 'other/model'],
    ['--thinking', 'low'],
    ['--baseline', 'HEAD~1'],
  ];
  for (const args of drift) {
    const hash = planJson(h, args).doc.approvalHash;
    assert.notEqual(hash, base, `${args.join(' ')} 属于批准范围，改了就换哈希`);
  }
});

test('场景清单声明局部探针性质：计划不得把平台契约探针宣称为完整 reviewer 或流程 E2E', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const { doc } = planJson(h);
  const s = doc.plan.scenarios[0];
  assert.equal(s.level, 'platform-contract-probe');
  assert.match(s.claim, /不是真实模型验收/, '场景自带边界声明');
});

// ====================================================================
// 授权门：无明确授权一律在模型调用边界之前拒绝
// ====================================================================

test('请求执行但无授权（非交互）：在模型调用边界之前拒绝，退出码 1，留拒绝记录', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const r = runEntry(h, ['--run', '--out', h.out]);

  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /授权/);
  assert.match(r.stderr, /模型调用授权/, '说明普通实现授权不算模型调用授权');
  assert.equal(h.probeCalls().length, 0, '未授权不启动探针');
  assert.equal(h.modelCalls().length, 0, '未授权不产生模型调用');
  assert.equal(fs.readdirSync(h.tmpdir).length, 0, '未授权不创建探针证据目录');

  const refusal = JSON.parse(fs.readFileSync(path.join(h.out, 'refusal.json'), 'utf8'));
  assert.equal(refusal.status, 'refused');
  assert.match(refusal.reason, /授权/);
  assert.match(refusal.approvalHash, /^[0-9a-f]{12}$/);
  assert.equal(refusal.ranAnyModelCall, false);
});

test('伪授权不算授权：普通同意字样、来源不明的哈希、别的批次的哈希都拒绝', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const other = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }, { id: 'stub-b', mode: 'pass' }] });
  const otherHash = planJson(other).doc.approvalHash; // 另一个批准范围（多了场景）的合法哈希

  for (const approve of ['yes', 'approved', 'ticket 34 approved', 'lgtm', 'deadbeefdead', otherHash]) {
    const r = runEntry(h, ['--approve', approve, '--out', h.out]);
    assert.equal(r.status, 1, `--approve ${approve} 应被拒绝：${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /拒绝|不匹配/, `拒绝理由可见：--approve ${approve}`);
  }
  assert.equal(h.probeCalls().length, 0);
  assert.equal(h.modelCalls().length, 0);
});

test('--approve - 从 stdin 读入哈希；不匹配即拒绝，未知"同意"类参数是用法错误', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });

  const denied = runEntry(h, ['--approve', '-', '--out', h.out], { input: 'no thanks\n' });
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.equal(h.probeCalls().length, 0);

  for (const flag of ['--yes', '--approve-all', '--force-run']) {
    const r = runEntry(h, [flag]);
    assert.equal(r.status, 2, `${flag} 不是授权入口，应为用法错误：${r.stdout}${r.stderr}`);
  }
  assert.equal(h.modelCalls().length, 0);

  const empty = runEntry(h, ['--approve', '-', '--out', h.out], { input: '\n' });
  assert.equal(empty.status, 1, '空输入＝未授权');
});

test('凭证不是授权：无授权时拒绝路径不读取、不需要任何凭证', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const env = { OPENAI_API_KEY: 'sk-unused-should-not-matter', ANTHROPIC_API_KEY: '' };
  const r = runEntry(h, ['--run', '--out', h.out], { env });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(h.modelCalls().length, 0);

  const precheck = runEntry(h, ['--out', h.out], { env });
  assert.equal(precheck.status, 0, '预检既不要求也不使用凭证');
  assert.equal(h.modelCalls().length, 0);
});

// ====================================================================
// 限定批次执行：只跑批准范围，额度是护栏
// ====================================================================

const readResults = (h) => JSON.parse(fs.readFileSync(path.join(h.out, 'results.json'), 'utf8'));

function execute(h, args, { extra = [], input = '', env = {} } = {}) {
  const { doc } = planJson(h, args);
  const r = runEntry(h, [...args, '--approve', doc.approvalHash, ...extra], { input, env });
  return { ...r, hash: doc.approvalHash, plan: doc.plan };
}

test('授权限定批次：只运行批准范围内的场景，实际调用数如实计入，退出码 0', () => {
  const h = harness({
    scenarios: [
      { id: 'stub-a', mode: 'pass' },
      { id: 'stub-b', mode: 'pass', calls: 2 },
      { id: 'stub-c', mode: 'pass' },
    ],
  });
  const r = execute(h, ['--scenario', 'stub-a,stub-b', '--out', h.out, '--json']);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(h.probeCalls().map((c) => c.scenario), ['stub-a', 'stub-b'], '批准范围外的场景不得启动');
  assert.equal(h.modelCalls().length, 0, '桩探针不调用平台；真实批次才调用');

  const results = readResults(h);
  assert.equal(results.status, 'passed');
  assert.equal(results.budget.callCap, 3);
  assert.equal(results.budget.usedCalls, 3, '实际调用数 = 1 + 2');
  assert.deepEqual(results.scenarios.map((s) => [s.id, s.status, s.calls]), [['stub-a', 'pass', 1], ['stub-b', 'pass', 2]]);
  assert.equal(results.plan.approvalHash, r.hash, '证据绑定获批计划');
  assert.equal(JSON.parse(r.stdout).status, 'passed', '--json 输出结果');
});

test('范围漂移必须重新授权：加场景/改次数/换模型/抬额度都不能沿用旧授权', () => {
  const h = harness({
    scenarios: [{ id: 'stub-a', mode: 'pass' }, { id: 'stub-b', mode: 'pass' }, { id: 'stub-c', mode: 'pass' }],
  });
  const approved = ['--scenario', 'stub-a,stub-b', '--out', h.out];
  const oldHash = planJson(h, approved).doc.approvalHash;

  const drifted = [
    ['--scenario', 'stub-a,stub-b,stub-c', '--out', h.out],
    ['--scenario', 'stub-a,stub-b', '--out', h.out, '--runs', '2'],
    ['--scenario', 'stub-a,stub-b', '--out', h.out, '--model', 'other/model'],
    ['--scenario', 'stub-a,stub-b', '--out', h.out, '--thinking', 'low'],
    ['--scenario', 'stub-a,stub-b', '--out', h.out, '--call-cap', '9'],
  ];
  for (const args of drifted) {
    const r = runEntry(h, [...args, '--approve', oldHash]);
    assert.equal(r.status, 1, `漂移必须重新授权：${args.join(' ')}`);
    assert.match(r.stderr, /授权不匹配/);
  }

  // 真实远程写入属于批准范围：场景声明变了，计划与哈希都要跟着变。
  const one = { id: 'stub-a', mode: 'pass' };
  const single = planJson(h, [], { env: { STUB_SCENARIOS: JSON.stringify([one]) } }).doc;
  const remote = planJson(h, [], {
    env: {
      STUB_SCENARIOS: JSON.stringify([
        { ...one, writes: { files: '临时目录', network: '无', remote: '真实 tracker 写入' } },
      ]),
    },
  }).doc;
  assert.equal(single.plan.writeScope.remoteWrites, '无');
  assert.match(remote.plan.writeScope.remoteWrites, /真实 tracker 写入/, '计划展示远程写入范围');
  assert.notEqual(remote.approvalHash, single.approvalHash, '新增真实远程写入需要重新授权');
  assert.equal(h.probeCalls().length, 0, '漂移拒绝同样发生在模型调用边界之前');
  assert.equal(h.modelCalls().length, 0);
});

test('额度耗尽：不启动新调用，未运行的场景不判通过，退出码 3', () => {
  const h = harness({
    scenarios: [{ id: 'stub-a', mode: 'pass' }, { id: 'stub-b', mode: 'pass' }, { id: 'stub-c', mode: 'pass' }],
  });
  const r = execute(h, ['--out', h.out, '--call-cap', '2', '--json']);

  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(h.probeCalls().map((c) => c.scenario), ['stub-a', 'stub-b'], '额度用尽后不再启动调用');
  const results = readResults(h);
  assert.equal(results.status, 'not-accepted');
  assert.equal(results.budget.usedCalls, 2);
  const c = results.scenarios.find((s) => s.id === 'stub-c');
  assert.equal(c.status, 'not-run');
  assert.match(c.reason, /budget|额度/);
  assert.equal(c.calls, 0);
  assert.notEqual(results.status, 'passed', '未运行不得判通过');
});

test('实际调用超出批准额度：整批不判通过并停下等待重新授权', () => {
  const h = harness({
    scenarios: [
      { id: 'stub-a', mode: 'overrun', reportCalls: 3 },
      { id: 'stub-b', mode: 'pass' },
    ],
  });
  const r = execute(h, ['--out', h.out, '--json']);

  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.deepEqual(h.probeCalls().map((c) => c.scenario), ['stub-a'], '超限后不启动后续调用');
  const results = readResults(h);
  assert.equal(results.status, 'not-accepted');
  assert.equal(results.budget.callCap, 2);
  assert.equal(results.budget.usedCalls, 3, '如实记录超出的实际调用数');
  assert.match(results.reason, /额度|budget/);
  assert.equal(results.scenarios.find((s) => s.id === 'stub-b').status, 'not-run');
});

// ====================================================================
// 重试、失败分类与"不得标为通过"
// ====================================================================

test('重试计入额度且只对无法判定的尝试重试：全部尝试保留，实际调用数如实累加', () => {
  const h = harness({ scenarios: [{ id: 'stub-flaky', mode: 'flaky' }] });
  const r = execute(h, ['--out', h.out, '--retries', '1', '--call-cap', '3', '--json']);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(h.probeCalls().map((c) => [c.scenario, c.attempt]), [['stub-flaky', 1], ['stub-flaky', 2]]);
  const results = readResults(h);
  const s = results.scenarios[0];
  assert.equal(s.status, 'pass');
  assert.equal(s.calls, 2, '两次尝试的调用都计入实际调用数');
  assert.deepEqual(s.attempts.map((a) => [a.attempt, a.status, a.kind, a.callsReported]), [
    [1, 'inconclusive', 'infrastructure', 1],
    [2, 'pass', 'none', 1],
  ], '失败尝试不因为后来成功而消失');
  assert.equal(results.budget.usedCalls, 2);
});

test('重试不能绕过额度：额度用尽即停下，未完成不得标为通过', () => {
  const h = harness({ scenarios: [{ id: 'stub-flaky', mode: 'flaky' }] });
  const r = execute(h, ['--out', h.out, '--retries', '3', '--call-cap', '1', '--json']);

  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.equal(h.probeCalls().length, 1, '额度只允许一次尝试，不无限重跑');
  const s = readResults(h).scenarios[0];
  assert.equal(s.status, 'incomplete');
  assert.match(s.reason, /budget|额度/);
  assert.equal(s.attempts.length, 1);
});

test('失败分类：明确失败不重试；装置故障与矛盾报告记为未完成且绝不判通过', () => {
  const h = harness({
    scenarios: [
      { id: 'stub-fail', mode: 'fail' },
      { id: 'stub-crash', mode: 'crash' },
      { id: 'stub-no-result', mode: 'no-result' },
      { id: 'stub-bad-result', mode: 'bad-result' },
      { id: 'stub-mismatch', mode: 'mismatch' },
    ],
  });
  const r = execute(h, ['--out', h.out, '--retries', '1', '--call-cap', '9', '--json']);

  assert.equal(r.status, 3, r.stdout + r.stderr);
  const results = readResults(h);
  assert.equal(results.status, 'not-accepted');
  assert.equal(results.budget.usedCalls, 9, '全部尝试都计入实际调用数');
  const by = Object.fromEntries(results.scenarios.map((s) => [s.id, s]));

  assert.equal(by['stub-fail'].status, 'fail');
  assert.equal(by['stub-fail'].classification, 'product-regression');
  assert.equal(by['stub-fail'].attempts.length, 1, '明确失败不重试（不跑到绿再隐藏失败）');
  assert.match(by['stub-fail'].attempts[0].retryNote, /不重试/);

  for (const id of ['stub-crash', 'stub-no-result', 'stub-bad-result', 'stub-mismatch']) {
    assert.equal(by[id].status, 'incomplete', `${id} 不得判通过`);
    assert.equal(by[id].classification, 'harness', `${id} 归因为测试装置故障`);
    assert.ok(by[id].attempts.length >= 1);
    assert.deepEqual(by[id].attempts.map((a) => a.status), Array(by[id].attempts.length).fill('inconclusive'));
  }
  assert.equal(by['stub-crash'].attempts.length, 2, '装置故障允许在额度内重试一次，以便区分偶发与真实故障');
  assert.equal(by['stub-crash'].attempts[0].exitCode, 7, '保留原始退出码');
  assert.equal(by['stub-mismatch'].attempts.length, 2);
  assert.match(by['stub-mismatch'].attempts[0].reason, /矛盾/);
});

// ====================================================================
// 取消
// ====================================================================

test('取消：停止新增调用、记录直接子进程状态，不假设子代理终止等于后台工作终止', () => {
  const h = harness({
    scenarios: [{ id: 'stub-cancel', mode: 'cancel' }, { id: 'stub-later', mode: 'pass' }],
  });
  const { doc } = planJson(h, ['--out', h.out]);
  const r = runEntry(h, ['--out', h.out, '--approve', doc.approvalHash, '--json'], { timeout: 60000 });

  assert.equal(r.status, 4, `取消退出码应为 4：${r.stdout}${r.stderr}`);
  assert.deepEqual(h.probeCalls().map((c) => c.scenario), ['stub-cancel'], '取消后不再启动新调用');

  const results = readResults(h);
  assert.equal(results.status, 'cancelled');
  assert.match(results.reason, /SIGINT|cancel/);
  const cancelled = results.scenarios.find((s) => s.id === 'stub-cancel');
  assert.equal(cancelled.attempts[0].status, 'cancelled');
  assert.equal(cancelled.attempts[0].endedBy, 'signal:SIGTERM');
  const later = results.scenarios.find((s) => s.id === 'stub-later');
  assert.equal(later.status, 'not-run');
  assert.match(later.reason, /cancelled|取消/);

  assert.equal(results.processes.cancelSignal, 'SIGINT');
  assert.equal(results.processes.children.length, 1);
  assert.equal(results.processes.children[0].aliveAfterClose, false, '直接子进程已终止');
  assert.match(results.processes.note, /不假设/, '不假设子进程终止＝全部后台工作终止');
  assert.match(results.processes.note, /后台/);

  // 已知测试进程：best-effort 扫描要在场，并且如实声明“匹配为空≠后台工作已结束”。
  assert.equal(typeof results.processes.relatedScan.available, 'boolean');
  assert.ok(Array.isArray(results.processes.relatedScan.matches));
  assert.match(results.processes.relatedScan.note, /best-effort|不出现|不等于/);
});


// ====================================================================
// 探针迁移、旧别名与真实场景清单（依旧零花费：平台桩）
// ====================================================================

const PROBE = path.join(REPO_ROOT, 'test', 'e2e', 'probes', 'repro-reviewer-axes.js');

test('双轴探针迁入独立测试区域：旧别名受同一授权入口约束，实测无授权不启动模型', () => {
  assert.ok(fs.existsSync(PROBE), '双轴探针在独立测试区域内');
  assert.equal(fs.existsSync(path.join(REPO_ROOT, 'test', 'repro-reviewer-axes.js')), false, '旧位置不留第二副本');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.repro, 'node test/e2e/accept.js', '旧探针别名指向统一授权入口');
  assert.doesNotMatch(pkg.scripts.test, /test\/e2e/, '默认测试不扫真实模型区域');

  // 真实场景清单 + 桩平台：别名未授权时必须在模型调用边界之前被拒。
  const h = harness({ realScenarios: true });
  const denied = spawnSync('npm', ['run', 'repro', '--', '--run', '--out', h.out], {
    cwd: REPO_ROOT, env: h.env, input: '', encoding: 'utf8', timeout: 120000,
  });
  assert.equal(denied.status, 1, `npm run repro 未授权应被拒：${denied.stdout}${denied.stderr}`);
  assert.match(`${denied.stdout}${denied.stderr}`, /授权/);
  assert.equal(h.modelCalls().length, 0, '别名未授权时不产生模型调用');
  assert.deepEqual(fs.readdirSync(h.tmpdir).filter((n) => n.startsWith('repro-')), [], '别名未授权时不启动探针（探针证据目录一个也不该出现）');

  // 授权后别名确实把这一批带到真实探针（此处平台是桩：探针只能得到"无法判定"）。
  const plan = planJson(h, []);
  const out2 = path.join(h.dir, 'out2');
  const approved = spawnSync('npm', ['run', 'repro', '--', '--approve', plan.doc.approvalHash, '--out', out2, '--json'], {
    cwd: REPO_ROOT, env: h.env, input: '', encoding: 'utf8', timeout: 180000,
  });
  assert.equal(approved.status, 3, `桩平台下不得判通过：${approved.stdout}${approved.stderr}`);
  assert.ok(h.modelCalls().length > 0, '授权后探针真的被启动（模型调用边界到达）');
  const results = JSON.parse(fs.readFileSync(path.join(out2, 'results.json'), 'utf8'));
  assert.equal(results.status, 'not-accepted');
  assert.deepEqual(results.scenarios.map((s) => s.id), ['axes-keyless', 'axes-reviewer', 'axes-final-reviewer']);
  for (const s of results.scenarios) {
    assert.notEqual(s.status, 'pass', `${s.id} 在桩平台下不得判通过`);
    assert.equal(s.status, 'incomplete');
  }
});

test('探针自带边界与绕过说明：声明局部探针性质，直跑时如实记无法判定', () => {
  const help = spawnSync(process.execPath, [PROBE, '--help'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout, /局部平台契约探针/);
  assert.match(help.stdout, /不是完整 reviewer/);
  assert.match(help.stdout, /绕过受支持的授权入口/, '说明直跑会绕过授权入口（非权限隔离）');

  const h = harness({ realScenarios: true });
  const direct = spawnSync(process.execPath, [PROBE, '--only', 'keyless', '--model', 'stub/model'], {
    cwd: REPO_ROOT, env: h.env, encoding: 'utf8', timeout: 60000,
  });
  assert.equal(direct.status, 2, `证据不足应记无法判定而非通过：${direct.stdout}${direct.stderr}`);
  assert.match(direct.stderr, /绕过受支持入口/);
  assert.match(direct.stdout, /INCONCLUSIVE|无法判定/);
});

// ====================================================================
// 证据：脱敏、位置、保留策略
// ====================================================================

const walkFiles = (root, out = []) => {
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    if (fs.statSync(abs).isDirectory()) walkFiles(abs, out);
    else out.push(abs);
  }
  return out;
};

test('证据脱敏：凭证值与完整环境配置不进入计划、日志、结果或输出', () => {
  const secret = 'sk-test-SECRET-0123456789abcdef';
  const h = harness({ scenarios: [{ id: 'stub-secret', mode: 'secret-leak' }] });
  const env = { STUB_SECRET: secret, OPENAI_API_KEY: secret };

  const { doc } = planJson(h, ['--out', h.out], { env });
  assert.ok(!JSON.stringify(doc).includes(secret), '计划不含凭证');
  const r = runEntry(h, ['--out', h.out, '--approve', doc.approvalHash, '--json'], { env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), '输出不含凭证');

  for (const file of walkFiles(h.out)) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes(secret), `${path.relative(REPO_ROOT, file)} 不得包含凭证值`);
  }
  const logText = fs.readFileSync(walkFiles(h.out).find((f) => f.endsWith('.log')), 'utf8');
  assert.match(logText, /<redacted:STUB_SECRET>/, '被抹掉的凭证在日志里留痕，便于复核脱敏确实发生');

  const results = readResults(h);
  assert.equal(results.plan.platform.model, 'opencode-go/muse-spark-1.3-contributor', '脱敏不影响机械事实');
  assert.ok(!JSON.stringify(results).includes(secret));
});

test('产物位置与保留策略：默认落在被 git 忽略的运行目录，失败证据默认保留、--force 才删', () => {
  const h = harness({ scenarios: [{ id: 'stub-a', mode: 'pass' }] });
  const { doc } = planJson(h, []);
  assert.match(doc.artifactsDir, /\.scratch[/\\]e2e-runs[/\\]/);
  const ignored = spawnSync('git', ['check-ignore', '-q', doc.artifactsDir], { cwd: REPO_ROOT });
  assert.equal(ignored.status, 0, '默认产物目录被 git 忽略（运行证据不进源码提交面）');

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.ok(!JSON.stringify(pkg.files).includes('test'), '测试区域与运行证据不进 npm 包');

  const root = path.join(h.dir, 'runs');
  const mkRun = (name, status, ageDays) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ schema: 'e2e-results-1', status }));
    const when = new Date(Date.now() - ageDays * 86400000);
    fs.utimesSync(dir, when, when);
  };
  mkRun('run-pass', 'passed', 30);
  mkRun('run-fail', 'not-accepted', 30);
  mkRun('run-refused', 'refused', 30);
  mkRun('run-recent', 'passed', 1);

  const kept = runEntry(h, ['--clean', '--out', root, '--keep-days', '14']);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'run-pass')), '过期的通过运行按保留期清理');
  assert.ok(fs.existsSync(path.join(root, 'run-recent')), '未过期的不删');
  assert.ok(fs.existsSync(path.join(root, 'run-fail')), '失败证据默认保留：不立刻删唯一证据');
  assert.ok(fs.existsSync(path.join(root, 'run-refused')), '拒绝记录同样保留');
  assert.match(kept.stdout, /保留/);

  const forced = runEntry(h, ['--clean', '--out', root, '--keep-days', '14', '--force']);
  assert.equal(forced.status, 0, forced.stdout + forced.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'run-fail')), '--force 才删失败证据');
  assert.ok(!fs.existsSync(path.join(root, 'run-refused')));
});

// ====================================================================
// 文档、边界与悬空指针
// ====================================================================

const ACCEPTANCE_DOC = path.join(REPO_ROOT, 'docs', 'agents', 'real-model-acceptance.md');

test('运行说明覆盖计划/授权/执行/结果/故障处理，并声明治理边界', () => {
  assert.ok(fs.existsSync(ACCEPTANCE_DOC), '真实模型验收有专门说明');
  const doc = fs.readFileSync(ACCEPTANCE_DOC, 'utf8');
  const sections = [
    [/^#+\s.*[Pp]lan/m, '计划'],
    [/^#+\s.*[Aa]uthoriz/m, '授权'],
    [/^#+\s.*[Ee]xecut/m, '执行'],
    [/^#+\s.*[Rr]esult/m, '结果'],
    [/^#+\s.*[Tt]roubleshoot/m, '故障处理'],
    [/^#+\s.*[Rr]etention|cleanup/i, '保留与清理'],
  ];
  for (const [re, name] of sections) assert.match(doc, re, `说明要有「${name}」一节`);
  assert.match(doc, /mis-trigger|误触发/, '声明护栏防误触发而非权限隔离');
  assert.match(doc, /not a precise|不是.*金额上限|spend cap/i, '不把次数/超时宣称为精确金额上限');

  // 维护者能从贡献者文档找到入口；双语 README 指向同一份说明。
  assert.match(fs.readFileSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'), 'utf8'), /test\/e2e\/accept\.js/);
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    assert.match(fs.readFileSync(path.join(REPO_ROOT, readme), 'utf8'), /real-model-acceptance\.md/, `${readme} 指向运行说明`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.doesNotMatch(pkg.scripts.test, /e2e/, '默认测试命令不把真实模型区域扫进来');
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /node\s+\S*test\/e2e|npm run repro/, '默认 CI 的步骤不调用真实模型入口');
});

test('无悬空指针：旧探针路径与旧别名说明不再出现在文档、包清单或脚本里', () => {
  const skip = new Set(['.git', 'node_modules', '.scratch', '.pi']);
  const self = path.relative(REPO_ROOT, __filename);
  const offenders = [];
  const scan = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = path.relative(REPO_ROOT, abs);
      if (skip.has(name)) continue;
      if (fs.statSync(abs).isDirectory()) { scan(abs); continue; }
      if (rel === self || !/\.(md|js|json|yml)$/.test(name)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('test/repro-reviewer-axes.js') || text.includes('test/repro-*')) offenders.push(rel);
    }
  };
  scan(REPO_ROOT);
  assert.deepEqual(offenders, [], '旧探针路径的引用已随搬迁更新');
});
