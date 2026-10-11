#!/usr/bin/env node
'use strict';
// ============================================================================
// 真实模型验收入口的唯一受支持入口（票 34）。
//
//   node test/e2e/accept.js                     预检 + 计划展示（无模型调用）
//   node test/e2e/accept.js --json              同上，机器可读
//   node test/e2e/accept.js --run               请求执行；无有效授权即拒绝
//   node test/e2e/accept.js --approve <哈希>    授权本批计划并执行真实模型调用
//   node test/e2e/accept.js --approve -         从 stdin 读入授权哈希
//   node test/e2e/accept.js --clean [...]       按保留策略清理运行产物
//
// 默认行为不启动模型：请求执行但没有针对本批计划的明确授权（--approve <计划哈希>）
// 时，入口在模型调用边界之前拒绝执行；非交互环境（stdin 不是终端）缺授权同样拒绝，
// 不会把"沉默"当成同意。普通实现授权 / 票据授权不是模型调用授权。
//
// 退出码：0 通过（或预检完成、未执行）；1 拒绝（未授权/授权不匹配）；2 用法或配置
// 错误；3 未达验收（失败/无法判定/额度耗尽/未运行）；4 取消。
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const planLib = require('./lib/plan');
const execLib = require('./lib/execute');
const retention = require('./lib/retention');

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_ACCEPTED = 3;
const EXIT_CANCELLED = 4;

const USAGE = `用法:
  node test/e2e/accept.js [选项]

选项:
  --json                     机器可读输出（计划模式输出计划 JSON，执行模式输出结果 JSON）
  --run                      请求执行本批；没有有效授权即拒绝（不会因为"没说不"而执行）
  --scenario <id>[,<id>…]    只选择这些场景（默认：清单内全部）
  --model <provider/id>      模型（默认 ${planLib.DEFAULT_MODEL}）
  --thinking <level>         thinking 级别：${planLib.THINKING_LEVELS.join(' / ')}（默认 ${planLib.DEFAULT_THINKING}）
  --runs <n>                 每个场景的重复次数（默认 1）
  --retries <n>              每个场景的重试额度，计入调用上限（默认 0）
  --call-cap <n>             本批模型调用上限（默认 = 计划内调用数）
  --baseline <git-ref>       对照基线：做优化前后对照时指名
  --candidate <git-ref>      被测阶段候选（基线 / 原样搬迁 / 最终候选）：记入计划与内容标识，
                             与工作区内容不一致时如实标注；换候选要重新授权
  --out <dir>                证据目录（默认 .scratch/e2e-runs/<runId>）
  --approve <hash|->         明确授权与该哈希一致的这一批计划；- 表示从 stdin 读入
  --clean                    按保留策略清理证据目录
  --keep-days <n>            --clean 的保留天数（默认 14）
  --force                    --clean 时连失败/未完成/取消的运行一并删除
  -h, --help                 帮助

默认不调用模型：先看计划，再复制计划里的授权哈希执行 --approve。
`;

// ---------------------------------------------------------------- 参数解析

class UsageError extends Error {}

function parseArgs(argv) {
  const args = {
    mode: 'run', json: false, run: false, scenario: null, model: planLib.DEFAULT_MODEL,
    thinking: planLib.DEFAULT_THINKING, runs: 1, retries: 0, callCap: null,
    baseline: null, candidate: null, out: null, approve: null, keepDays: 14, force: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} 缺参数值`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.mode = 'help'; }
    else if (a === '--json') args.json = true;
    else if (a === '--run') args.run = true;
    else if (a === '--scenario') { args.scenario = need(i, a).split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--model') { args.model = need(i, a); i++; }
    else if (a === '--thinking') { args.thinking = need(i, a); i++; }
    else if (a === '--runs') { args.runs = intArg(need(i, a), a, 1); i++; }
    else if (a === '--retries') { args.retries = intArg(need(i, a), a, 0); i++; }
    else if (a === '--call-cap') { args.callCap = intArg(need(i, a), a, 0); i++; }
    else if (a === '--baseline') { args.baseline = need(i, a); i++; }
    else if (a === '--candidate') { args.candidate = need(i, a); i++; }
    else if (a === '--out') { args.out = need(i, a); i++; }
    else if (a === '--approve') { args.approve = need(i, a); i++; }
    else if (a === '--clean') args.mode = 'clean';
    else if (a === '--keep-days') { args.keepDays = intArg(need(i, a), a, 0); i++; }
    else if (a === '--force') args.force = true;
    else throw new UsageError(`未知参数: ${a}（除 --approve <计划哈希> 外，任何"同意"字样都不构成模型调用授权）`);
  }
  return args;
}

function intArg(raw, flag, min) {
  if (!/^\d+$/.test(raw)) throw new UsageError(`${flag} 需要非负整数，收到 ${raw}`);
  const n = Number(raw);
  if (n < min) throw new UsageError(`${flag} 至少为 ${min}，收到 ${raw}`);
  return n;
}

// ---------------------------------------------------------------- 证据目录

function newRunId() {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const rand = Math.random().toString(16).slice(2, 6);
  return `${ts}-${rand}`;
}

function resolveArtifactsDir(args, runId) {
  return args.out ? path.resolve(args.out) : path.join(planLib.REPO_ROOT, '.scratch', 'e2e-runs', runId);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------- 授权读取

// `--approve -` 或交互式确认时读一行；非交互 stdin 读完即拒绝（空输入 ≠ 同意）。
function readApprovalLine() {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stdin.setEncoding('utf8');
      let buf = '';
      process.stdin.on('data', (c) => { buf += c; });
      process.stdin.on('end', () => resolve(buf.split('\n')[0].trim()));
      process.stdin.resume();
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('输入计划授权哈希（回车＝拒绝）: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resolveApproval(args, approvalHash) {
  let provided = args.approve;
  if (provided == null && args.run && process.stdin.isTTY) {
    process.stdout.write(`${planLib.renderPlan({ plan: args.plan, approvalHash, artifactsDir: args.artifactsDir, invocation: args.invocation, state: '等待授权' })}\n`);
    provided = await readApprovalLine();
  }
  if (provided === '-') provided = await readApprovalLine();
  if (provided == null || provided === '') {
    return { ok: false, provided: null, reason: `缺少本批计划的明确授权：普通实现授权 / 票据授权不是模型调用授权，请用 --approve ${approvalHash} 明确授权这一批` };
  }
  if (provided !== approvalHash) {
    return { ok: false, provided, reason: `授权不匹配：提供值与本批计划的授权哈希 ${approvalHash} 不一致（范围变了就重新授权，不会自动沿用旧授权）` };
  }
  return { ok: true, provided };
}

// ---------------------------------------------------------------- main

async function main(argv, env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n\n${USAGE}`);
      return EXIT_USAGE;
    }
    throw err;
  }

  if (args.mode === 'help') {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.force && args.mode !== 'clean') {
    process.stderr.write('--force 只用于 --clean（授权执行没有强制开关）\n');
    return EXIT_USAGE;
  }
  if (!planLib.THINKING_LEVELS.includes(args.thinking)) {
    process.stderr.write(`thinking 级别非法: ${args.thinking}（可选 ${planLib.THINKING_LEVELS.join(' / ')}）\n`);
    return EXIT_USAGE;
  }
  if (args.mode === 'clean') {
    const root = args.out ? path.resolve(args.out) : retention.defaultRunsRoot();
    const report = retention.cleanRuns({ root, keepDays: args.keepDays, force: args.force });
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : retention.renderCleanReport(report));
    return EXIT_OK;
  }

  const runId = newRunId();
  const artifactsDir = resolveArtifactsDir(args, runId);
  const invocation = `node ${planLib.displayPath(path.resolve(__filename))}`;

  let loaded;
  let built;
  try {
    loaded = planLib.loadScenarioModule(env);
    built = planLib.buildPlan({
      scenarios: loaded.scenarios,
      selection: args.scenario,
      model: args.model,
      thinking: args.thinking,
      runs: args.runs,
      retries: args.retries,
      callCap: args.callCap,
      baseline: args.baseline,
      candidateRef: args.candidate,
      platform: planLib.probePlatform({ binary: env.PI_E2E_PI_BIN || 'pi' }),
      target: planLib.gitTarget(),
      scenariosFile: loaded.file,
    });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return EXIT_USAGE;
  }

  const { plan, approvalHash } = built;
  const view = { schema: planLib.PLAN_SCHEMA, approvalHash, artifactsDir, plan };

  if (!args.run && args.approve == null) {
    process.stdout.write(args.json
      ? `${JSON.stringify(view, null, 2)}\n`
      : planLib.renderPlan({ plan, approvalHash, artifactsDir, invocation, state: '预检：未执行任何场景，未产生任何模型调用' }));
    if (args.json) process.stderr.write(`预检完成：未授权，无模型调用。授权哈希 ${approvalHash}\n`);
    return EXIT_OK;
  }

  const approval = await resolveApproval({ ...args, plan, artifactsDir, invocation }, approvalHash);
  if (!approval.ok) {
    process.stderr.write(`拒绝执行：${approval.reason}\n`);
    process.stderr.write(`未产生任何模型调用；授权入口：${invocation} --approve ${approvalHash}\n`);
    try {
      writeJson(path.join(artifactsDir, 'refusal.json'), {
        schema: 'e2e-refusal-1',
        at: new Date().toISOString(),
        status: 'refused',
        reason: approval.reason,
        approvalHash,
        approveProvidedMatches: false,
        ranAnyModelCall: false,
        plan,
      });
    } catch { /* 拒绝记录尽力而为，不能因此放行 */ }
    return EXIT_REFUSED;
  }

  // 授权通过：只执行这一批计划。所有产物先脱敏再落盘。
  const sanitize = execLib.createSanitizer(env);
  const results = await execLib.executeBatch({ plan, approvalHash, artifactsDir, runId, env, sanitize });
  const json = sanitize(`${JSON.stringify(results, null, 2)}\n`);
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, 'results.json'), json);
  process.stdout.write(args.json ? json : sanitize(execLib.renderResults(results)));
  if (!args.json) process.stderr.write(`结果：${results.status}；证据 ${path.join(artifactsDir, 'results.json')}\n`);
  return execLib.EXIT_BY_BATCH[results.status] ?? EXIT_NOT_ACCEPTED;
}

module.exports = { main, parseArgs, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, EXIT_NOT_ACCEPTED, EXIT_CANCELLED };

if (require.main === module) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
