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

const candidateLib = require('./candidate');

const PLAN_SCHEMA = 'e2e-plan-1';
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_SCENARIOS_FILE = path.join(REPO_ROOT, 'test', 'e2e', 'scenarios.js');
const DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';
const DEFAULT_THINKING = 'high';

// 调用额度的单位：探针按模型调用计；流程场景按平台会话计（会话内的子派发不逐个计入
// 护栏额度，费用以 provider 账单为准）。单位进计划、进授权哈希。
const CALLS_UNIT_NOTE = '调用上限单位按场景声明：model-call = 每次真实模型调用；session = 平台会话（一次会话内部的子派发不逐个计入护栏额度，费用以 provider 账单为准）。两种单位都不宣称为精确金额上限。';

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
    platform, target, scenariosFile, candidateRef,
  } = opts;

  let candidate = null;
  if (candidateRef) {
    const resolved = candidateLib.resolveCandidate({ ref: candidateRef });
    const stage = require('../flow-scenarios').stageOf(resolved.ref, resolved.sha);
    candidate = { ...resolved, stage: stage.stage, stageNote: stage.note };
  }

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
    callsUnit: s.callsUnit || 'model-call',
    retries,
    attemptsPerRun: 1 + retries,
    attemptTimeoutMs: s.timeoutMs,
    concurrency: 1,
    writes: s.writes,
    // 场景装置与被判对象：都进授权哈希（范围变了就得重新授权）。
    fixture: s.fixture || null,
    brief: s.brief || null,
    judgement: s.judgement || null,
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
    candidate: candidate
      ? {
        ref: candidate.ref,
        sha: candidate.sha,
        stage: candidate.stage,
        match: candidate.match,
        contentId: candidate.contentId,
        refContentId: candidate.refContentId,
        mismatched: candidate.mismatched,
        note: `${candidate.note} ${candidate.stageNote}`,
      }
      : null,
    platform: { binary: platform.binary, version: platform.version, model, thinking },
    comparison: {
      mode: baseline || candidate ? 'before-after' : 'none',
      baseline: baseline || null,
      candidate: candidate ? candidate.ref : null,
      note: candidateLib.comparisonNote({ baseline, candidate: candidate ? candidate.ref : null }),
    },
    scenarios: entries,
    counts: {
      scenarios: entries.length,
      plannedCalls,
      plannedAttempts: entries.reduce((n, s) => n + s.runs * s.attemptsPerRun, 0),
      callCap: cap,
      retryBudget: retries,
      concurrency: 1,
      callsUnitNote: CALLS_UNIT_NOTE,
    },
    feasibility: {
      partial,
      note: partial
        ? `调用上限 ${cap} 低于计划内调用数 ${plannedCalls}：只执行装进额度的部分，其余重复记为未运行（不会超限调用）`
        : '计划内调用数不超过批准额度',
    },
    policy: {
      note: '顺序执行。每次重复最多 1+重试额度 次尝试，重试只用于无法判定的尝试；明确失败即停止该场景剩余重复；额度耗尽或取消立即停止新增调用，未运行的重复记为 not-run，整批不判通过。',
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
    // 对照条件：记录并尽量固定模型、thinking、平台、任务书、fixture、权限与环境；
    // 固定不了的（provider 侧实际模型版本、平台子会话与网络出口）如实列出。
    pinned: {
      model,
      thinking,
      platformBinary: platform.binary,
      platformVersion: platform.version,
      scenariosFile: displayPath(scenariosFile),
      node: process.version,
      os: `${process.platform}-${process.arch}`,
      taskBrief: entries.every((s) => s.brief)
        ? '每场景任务书内容固定并哈希进计划（不指路）'
        : '场景自带探针输入（无导航任务书）',
      fixture: entries.some((s) => s.fixture)
        ? '每场景独立临时项目，fixed 初始状态与清单哈希进计划'
        : '无场景装置',
      permissions: 'fixture 在临时目录，PATH 上的 gh / glab 是记录桩；不授予额外权限，会话按其自身权限运行',
      environment: '调用方环境随批次传递；候选、fixture 与任务书标识进授权哈希',
      notFrozen: [
        'provider 侧模型的实际版本与路由（入口只能按标识记录）',
        '平台已安装的包来源：本入口不安装任何候选，被测候选需由调用方按受支持方式安装',
        '平台子会话的内部形态与网络出口',
        '宿主时钟与并发调度（影响耗时，不影响判定口径）',
      ],
    },
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
  if (plan.candidate) {
    lines.push(`阶段候选   ${plan.candidate.ref} @ ${plan.candidate.sha.slice(0, 12)}（stage ${plan.candidate.stage}，内容标识 ${plan.candidate.contentId.slice(0, 12)}${plan.candidate.match ? '' : '，与工作区不一致'}）`);
    lines.push(`           ${plan.candidate.note}`);
  } else {
    lines.push('阶段候选   未命名（结果只绑定工作区 HEAD，不声称检验了任何已登记阶段）');
  }
  lines.push(`对照范围   ${plan.comparison.mode === 'none' ? '无' : (plan.comparison.candidate || '') + (plan.comparison.baseline ? `（基线 ${plan.comparison.baseline}）` : '')} —— ${plan.comparison.note}`);
  lines.push(`平台       ${plan.platform.binary} ${plan.platform.version}；模型 ${plan.platform.model}；thinking ${plan.platform.thinking}`);
  lines.push(`场景（${plan.scenarios.length}）`);
  for (const s of plan.scenarios) {
    lines.push(`  - ${s.id}  [${s.level}]  次数 ${s.runs}，每次最多 ${s.attemptsPerRun} 次尝试，调用 ${s.callsPerRun}/次，共 ${s.plannedCalls}，超时 ${Math.round(s.attemptTimeoutMs / 1000)}s，并发 ${s.concurrency}`);
    lines.push(`      ${s.title}`);
    lines.push(`      边界：${s.claim}`);
    lines.push(`      写入：文件 ${s.writes.files}；网络 ${s.writes.network}；远程 ${s.writes.remote}`);
    if (s.fixture) lines.push(`      fixture：${s.fixture.id}（tracker 桩 ${s.fixture.trackerStub}，测试命令 ${s.fixture.testCommand}，哈希 ${s.fixture.sha256.slice(0, 12)}）`);
    if (s.brief) lines.push(`      任务书：${s.brief.id}（哈希 ${s.brief.sha256.slice(0, 12)}；不指路：任务书不出现指令文档路径）`);
    if (s.judgement) {
      lines.push(`      判定：动作前读取 ${s.judgement.requiredReadsBefore.length} 项；安全边界 ${s.judgement.safety.join('、') || '无'}；角色职责 ${s.judgement.roleDuties.join('、') || '无'}${s.judgement.readOnly ? '；只读推演' : ''}`);
    }
  }
  lines.push(`调用上限   ${plan.counts.callCap}（计划内 ${plan.counts.plannedCalls}；计划尝试上限 ${plan.counts.plannedAttempts} 次，并发 ${plan.counts.concurrency}）`);
  lines.push(`计费单位   ${plan.counts.callsUnitNote}`);
  if (plan.pinned) {
    lines.push(`对照条件   模型 ${plan.pinned.model}（thinking ${plan.pinned.thinking}）；平台 ${plan.pinned.platformBinary} ${plan.pinned.platformVersion}；Node ${plan.pinned.node}；平台面 ${plan.pinned.os}`);
    lines.push(`           ${plan.pinned.taskBrief}；${plan.pinned.fixture}`);
    lines.push(`           权限与环境 ${plan.pinned.permissions}；${plan.pinned.environment}`);
    lines.push(`           未固定：${plan.pinned.notFrozen.join('；')}`);
  }
  if (plan.feasibility.partial) lines.push(`额度提示   ${plan.feasibility.note}`);
  lines.push(`重试额度   ${plan.counts.retryBudget} 次/重复（重试计入调用上限；只用于无法判定的尝试）`);
  lines.push(`执行策略   ${plan.policy.note}`);
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
  CALLS_UNIT_NOTE,
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
