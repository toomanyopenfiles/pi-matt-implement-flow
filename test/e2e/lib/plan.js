'use strict';
// ============================================================================
// 真实模型验收的「计划」层：把一批将要发生的真实模型调用整理成一份可展示、
// 可授权、可复现的机械计划。
//
// 承重约定：
//   - 计划里只有本次批准范围内的机械事实：被测版本、场景、对照、模型/provider/
//     thinking、平台版本、次数、调用上限、并发、超时、重试额度、费用说明、写入范围。
//   - 授权哈希 = 对计划做稳定序列化后的 sha256 前缀。范围一变哈希就变，旧授权
//     自动失效（新增场景、改次数、换模型、抬额度都要重新授权）。
//   - 计划本身不产生任何模型调用：平台版本用无模型的 `--version` 探测，不可得时
//     诚实记为 unknown。
// ============================================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { spawnSync } = require('node:child_process');

const PLAN_SCHEMA = 'e2e-plan-1';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SCENARIOS_FILE = path.join(REPO_ROOT, 'test', 'e2e', 'scenarios.js');
const DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';
const DEFAULT_THINKING = 'high';

// 费用与护栏的负空间裁定：这些是误触发护栏，不是权限隔离，也不是金额上限。
const COST_NOTE = '无法估算：本入口不建模 provider 价格、不读取账单；调用数、超时与重试额度是误触发护栏，不是精确金额上限。';
const GUARDRAIL_NOTE = '授权是误触发护栏：阻止未获明确授权的批次启动模型调用。它不是权限隔离，拥有相同 shell 权限的调用方可以绕过入口直接调用模型。';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// ---------------------------------------------------------------- 稳定序列化

// 键序无关的序列化：计划字段顺序变化不得改变授权哈希。
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function approvalHashOf(plan) {
  return crypto.createHash('sha256').update(stableStringify(plan)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------- 被测版本与平台

function readPackage() {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  return { name: pkg.name, version: pkg.version };
}

function gitTarget() {
  const pkg = readPackage();
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });
  const headSha = rev.status === 0 ? rev.stdout.trim() : 'unknown';
  const dirty = status.status === 0 ? status.stdout.trim().length > 0 : null;
  return { name: pkg.name, version: pkg.version, headSha, dirty };
}

// 平台版本探测：`--version` 是纯本地调用，不发模型请求、不需要凭证。
function probePlatform({ binary }) {
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
  const version = r.status === 0 && (r.stdout || '').trim() ? (r.stdout || '').trim().split('\n')[0] : 'unknown';
  return { binary, version };
}

// ---------------------------------------------------------------- 场景清单

const REQUIRED_SCENARIO_FIELDS = ['id', 'title', 'probe', 'callsPerRun', 'timeoutMs', 'level', 'claim', 'writes'];

function loadScenarioModule(env) {
  const file = env.PI_E2E_SCENARIOS ? path.resolve(env.PI_E2E_SCENARIOS) : DEFAULT_SCENARIOS_FILE;
  const mod = require(file);
  if (!mod || !Array.isArray(mod.scenarios) || mod.scenarios.length === 0) {
    throw new Error(`场景模块没有 scenarios 数组: ${file}`);
  }
  const seen = new Set();
  for (const s of mod.scenarios) {
    for (const f of REQUIRED_SCENARIO_FIELDS) {
      if (s[f] == null) throw new Error(`场景 ${s.id || '?'} 缺字段 ${f}（${file}）`);
    }
    if (seen.has(s.id)) throw new Error(`场景 id 重复: ${s.id}（${file}）`);
    seen.add(s.id);
    if (!Number.isInteger(s.callsPerRun) || s.callsPerRun < 0) throw new Error(`场景 ${s.id} 的 callsPerRun 必须是非负整数`);
    if (!Number.isInteger(s.timeoutMs) || s.timeoutMs <= 0) throw new Error(`场景 ${s.id} 的 timeoutMs 必须是正整数`);
  }
  return { file, scenarios: mod.scenarios };
}

// 相对仓库根的展示路径；仓库外（测试桩）保留绝对路径，便于复核到底跑了什么。
function displayPath(file) {
  const rel = path.relative(REPO_ROOT, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

function resolveProbe(scenario) {
  return path.isAbsolute(scenario.probe) ? scenario.probe : path.join(REPO_ROOT, scenario.probe);
}

// ---------------------------------------------------------------- 计划构造

function buildPlan(opts) {
  const {
    scenarios, selection, model, thinking, runs, retries, callCap, baseline,
    platform, target, scenariosFile,
  } = opts;

  const chosen = selection == null || selection.length === 0
    ? scenarios
    : selection.map((id) => {
      const hit = scenarios.find((s) => s.id === id);
      if (!hit) throw new Error(`未知场景: ${id}`);
      return hit;
    });

  const entries = chosen.map((s) => ({
    id: s.id,
    title: s.title,
    level: s.level,
    claim: s.claim,
    probe: displayPath(resolveProbe(s)),
    args: s.args || [],
    runs,
    plannedCalls: s.callsPerRun * runs,
    callsPerRun: s.callsPerRun,
    retries,
    maxAttempts: runs + retries,
    attemptTimeoutMs: s.timeoutMs,
    concurrency: 1,
    writes: s.writes,
  }));

  const plannedCalls = entries.reduce((n, s) => n + s.plannedCalls, 0);
  const cap = callCap == null ? plannedCalls : callCap;
  if (!Number.isInteger(cap) || cap < 0) {
    throw new Error(`调用上限必须是非负整数，收到 ${cap}`);
  }
  const partial = cap < plannedCalls;

  const files = [...new Set(entries.flatMap((s) => [s.writes.files]))].join('；');
  const network = [...new Set(entries.flatMap((s) => [s.writes.network]))].join('；');
  const remote = [...new Set(entries.flatMap((s) => [s.writes.remote]))].join('；');

  const plan = {
    schema: PLAN_SCHEMA,
    target,
    platform: { binary: platform.binary, version: platform.version, model, thinking },
    comparison: {
      mode: baseline ? 'before-after' : 'none',
      baseline: baseline || null,
      note: baseline
        ? `对照基线 ${baseline}：优化前后在可比条件下各自运行，结果分列`
        : '本轮不做优化前后对照：只记录被测版本；需要对照时用 --baseline 指名基线',
    },
    scenarios: entries,
    counts: {
      scenarios: entries.length,
      plannedCalls,
      plannedAttempts: entries.reduce((n, s) => n + s.maxAttempts, 0),
      callCap: cap,
      retryBudget: retries,
      concurrency: 1,
    },
    feasibility: {
      partial,
      note: partial
        ? `调用上限 ${cap} 低于计划内调用数 ${plannedCalls}：只执行装进额度的部分，其余场景记为未运行（不会超限调用）`
        : '计划内调用数不超过批准额度',
    },
    cost: { estimate: 'unknown', note: COST_NOTE },
    guardrail: { kind: 'mis-trigger-prevention', note: GUARDRAIL_NOTE },
    writeScope: {
      files: entries.length ? files : '（无场景）',
      network: entries.length ? network : '（无场景）',
      remoteWrites: entries.length ? remote : '（无场景）',
      artifacts: '证据目录 + 每次尝试的日志（仓库内被 git 忽略的运行目录，或 --out 指定目录）；不进源码提交面、不进 npm 包',
    },
    harness: { scenariosFile: displayPath(scenariosFile), node: process.version },
  };

  return { plan, approvalHash: approvalHashOf(plan) };
}

// ---------------------------------------------------------------- 计划展示

function renderPlan({ plan, approvalHash, artifactsDir, invocation, state }) {
  const lines = [];
  lines.push('══ 真实模型验收入口（预检：无模型调用）══');
  lines.push('本入口默认只做预检与计划展示，本批不会产生实际模型调用；');
  lines.push('要执行真实模型调用，必须对本计划明确授权：--approve <哈希>。');
  lines.push('');
  lines.push(`执行状态   ${state || '预检：未执行任何场景，未产生任何模型调用'}`);
  lines.push(`被测版本   ${plan.target.name} ${plan.target.version} @ ${plan.target.headSha}${plan.target.dirty ? '（工作区有未提交改动）' : ''}`);
  lines.push(`对照范围   ${plan.comparison.mode === 'none' ? '无' : plan.comparison.baseline} —— ${plan.comparison.note}`);
  lines.push(`平台       ${plan.platform.binary} ${plan.platform.version}；模型 ${plan.platform.model}；thinking ${plan.platform.thinking}`);
  lines.push(`场景（${plan.scenarios.length}）`);
  for (const s of plan.scenarios) {
    lines.push(`  - ${s.id}  [${s.level}]  次数 ${s.runs}，调用 ${s.callsPerRun}/次，共 ${s.plannedCalls}，超时 ${Math.round(s.attemptTimeoutMs / 1000)}s，并发 ${s.concurrency}`);
    lines.push(`      ${s.title}`);
    lines.push(`      边界：${s.claim}`);
    lines.push(`      写入：文件 ${s.writes.files}；网络 ${s.writes.network}；远程 ${s.writes.remote}`);
  }
  lines.push(`调用上限   ${plan.counts.callCap}（计划内 ${plan.counts.plannedCalls}；计划尝试 ${plan.counts.plannedAttempts} 次，并发 ${plan.counts.concurrency}）`);
  if (plan.feasibility.partial) lines.push(`额度提示   ${plan.feasibility.note}`);
  lines.push(`重试额度   ${plan.counts.retryBudget}（重试计入调用上限；明确的产品失败不重试）`);
  lines.push(`费用       ${plan.cost.estimate} —— ${plan.cost.note}`);
  lines.push(`护栏       ${plan.guardrail.kind} —— ${plan.guardrail.note}`);
  lines.push(`写入范围   文件 ${plan.writeScope.files}`);
  lines.push(`           网络 ${plan.writeScope.network}`);
  lines.push(`           远程写 ${plan.writeScope.remoteWrites}`);
  lines.push(`           产物 ${plan.writeScope.artifacts}`);
  lines.push('');
  lines.push(`证据目录   ${artifactsDir}`);
  lines.push(`授权哈希   ${approvalHash}`);
  lines.push('');
  lines.push('明确授权本批（复制上面的哈希）：');
  lines.push(`  ${invocation} --approve ${approvalHash}`);
  lines.push('从 stdin 送入哈希亦可：--approve -（非交互环境缺授权即拒绝，普通实现授权不算模型调用授权）');
  return `${lines.join('\n')}\n`;
}

module.exports = {
  PLAN_SCHEMA,
  REPO_ROOT,
  DEFAULT_SCENARIOS_FILE,
  DEFAULT_MODEL,
  DEFAULT_THINKING,
  THINKING_LEVELS,
  COST_NOTE,
  GUARDRAIL_NOTE,
  stableStringify,
  approvalHashOf,
  gitTarget,
  probePlatform,
  loadScenarioModule,
  displayPath,
  resolveProbe,
  buildPlan,
  renderPlan,
};
