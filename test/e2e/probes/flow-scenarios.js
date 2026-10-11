#!/usr/bin/env node
'use strict';
// ============================================================================
// 流程 / 导航 / 角色场景的探针（票 35）。
//
// 定位：真实批次里跑一个场景——独立临时项目（fixture）+ 导航任务书（不指路）+ 新会话，
// 然后把会话与现场事实采成轨迹，交给判定器判定。分级见 test/e2e/flow-scenarios.js：
// 完整执行 / 导航验收 / 受控推演，各自只声明自己能证明的东西。
//
// 受支持入口：`node test/e2e/accept.js`（默认无模型调用，先展示计划，要 --approve
// <计划哈希> 才执行）。本文件也可以直接跑（调试用），但那会绕过受支持的授权入口——
// 护栏防的是误触发，不是权限隔离。
//
// 平台调用形态：以技能入口命令 `/pi-matt-implement-flow <N>` 加载主干，任务书作为随后
// 的正文给出。平台不认这个形态时场景只会记「无法判定」，不会判通过。
//
// 确定性与自检：`--replay <trace.json>` 用合成轨迹走同一套判定并写结果（零模型调用），
// 供确定性自检使用。合成轨迹不是模型验收。
//
// 结果契约（入口执行时经 PI_E2E_RESULT_PATH）：
//   { schema: "e2e-scenario-result-1", scenario, status: pass|fail|inconclusive,
//     kind: none|product-regression|infrastructure|harness|undetermined|baseline-defect,
//     calls: <本场景启动的会话数>, assertions, notes, stage, fixture, brief, trace, judge }
// 退出码：0 通过、1 明确失败（产品回归）、2 无法判定 / 装置故障。
// ============================================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const flowScenarios = require('../flow-scenarios');
const { buildFixture } = require('../lib/flow-fixture');
const { harvestTrace } = require('../lib/trace-harvest');
const { buildBrief } = require('../lib/navigation-brief');
const { judgeTrace } = require('../lib/trace-judge');

const PI_BIN = process.env.PI_E2E_PI_BIN || 'pi';
const DEFAULT_TIMEOUT_S = 3600;

const HELP = `用法:
  node test/e2e/accept.js --scenario <场景>            受支持入口（预检 + 计划，无模型调用）
  node test/e2e/probes/flow-scenarios.js --only <id>   调试直跑（会调用真实模型）

选项:
  --only <id>            场景 id（见 test/e2e/flow-scenarios.js）
  --model <provider/id>  模型（透传给平台）
  --thinking <level>     thinking 级别（透传给平台）
  --timeout <seconds>    单次会话超时上限（默认 ${DEFAULT_TIMEOUT_S}）
  --replay <trace.json>  用合成轨迹走判定并写结果（零模型调用；自检用）
  --json                 机器可读输出
  --dump                 打印完整结果 JSON
  -h, --help             本帮助

分级：完整执行 / 导航验收 / 受控推演——本探针只声明自己能证明的东西，判不了就记无法判定。
`;

function parseArgs(argv) {
  const args = { only: null, model: null, thinking: null, timeout: DEFAULT_TIMEOUT_S, replay: null, json: false, dump: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only') args.only = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--thinking') args.thinking = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--replay') args.replay = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--dump') args.dump = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else { process.stderr.write(`unknown flag: ${a}\n`); process.exit(2); }
  }
  return args;
}

function writeResult(doc) {
  const target = process.env.PI_E2E_RESULT_PATH;
  if (!target) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(doc));
}

function notesOf(judgement) {
  const parts = [judgement.kindNote];
  if (judgement.report.missing.length) parts.push(`缺失：${judgement.report.missing.join('、')}`);
  if (judgement.report.failed.length) parts.push(`失败：${judgement.report.failed.join('、')}`);
  if (judgement.report.undetermined.length) parts.push(`无法判定：${judgement.report.undetermined.join('、')}`);
  if (judgement.report.baselineDefects.length) parts.push(`基线既有缺陷：${judgement.report.baselineDefects.join('、')}`);
  return parts.join('；');
}

function resultOf(def, judgement, extra) {
  return {
    schema: 'e2e-scenario-result-1',
    scenario: def.id,
    level: def.level,
    status: judgement.status,
    kind: judgement.kind,
    calls: extra.calls,
    assertions: judgement.assertions.map(({ id, state, note }) => ({ id, state, note })),
    notes: notesOf(judgement),
    stage: extra.stage || 'unlabeled',
    fixture: extra.fixture || null,
    brief: extra.brief || null,
    trace: extra.trace || null,
    judge: {
      status: judgement.status,
      kind: judgement.kind,
      kindNote: judgement.kindNote,
      findings: judgement.findings,
      report: judgement.report,
    },
  };
}

const EXIT_BY_STATUS = { pass: 0, fail: 1, inconclusive: 2 };

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const def = flowScenarios.SCENARIOS.find((d) => d.id === args.only);
  if (!def) {
    process.stderr.write(`未知场景: ${args.only}（可选：${flowScenarios.SCENARIOS.map((d) => d.id).join('、')}）\n`);
    process.exit(2);
  }
  const stage = process.env.PI_E2E_STAGE || 'unlabeled';
  if (!process.env.PI_E2E_RESULT_PATH) {
    process.stderr.write('注意：直接跑本探针会绕过受支持入口 test/e2e/accept.js 的授权（护栏防误触发，不是权限隔离）。受支持方式：node test/e2e/accept.js，看计划后用 --approve <哈希> 授权本批。\n');
  }

  // ---- 自检通道：合成轨迹（零模型调用）----
  if (args.replay) {
    let trace;
    try {
      trace = JSON.parse(fs.readFileSync(args.replay, 'utf8'));
    } catch (err) {
      process.stderr.write(`--replay 读取失败: ${err.message}\n`);
      process.exit(2);
    }
    const judgement = judgeTrace({ scenario: def.id, expectations: def.expectations, trace, stage });
    const doc = resultOf(def, judgement, {
      calls: 0,
      stage,
      fixture: { id: def.fixture.id, source: 'synthetic' },
      brief: null,
      trace: { source: 'synthetic', events: (trace.events || []).length, uncertainty: trace.uncertainty || [] },
    });
    writeResult(doc);
    process.stdout.write(`${JSON.stringify(doc, null, args.json || args.dump ? 2 : 0)}\n`);
    process.exit(EXIT_BY_STATUS[judgement.status] ?? 2);
  }

  // ---- 真实批次：fixture + 导航任务书 + 新会话 ----
  let fx;
  try {
    fx = buildFixture(def);
  } catch (err) {
    const judgement = {
      status: 'inconclusive',
      kind: 'harness',
      kindNote: `测试装置故障：fixture 构建失败（${err.message.slice(0, 300)}）——不判通过。`,
      assertions: [{ id: 'fixture-built', state: 'harness', note: err.message.slice(0, 300) }],
      findings: [{ id: 'fixture-built', kind: 'harness', note: err.message.slice(0, 300) }],
      report: { missing: [], failed: [], undetermined: [], baselineDefects: [], notRun: [], passed: [] },
    };
    const doc = resultOf(def, judgement, { calls: 0, stage });
    writeResult(doc);
    process.stderr.write(`${judgement.kindNote}\n`);
    process.exit(2);
  }

  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `flow-session-${def.id}-`));
  const brief = buildBrief(def, {
    projectDir: fx.projectDir,
    trackerDir: fx.trackerDir,
    testCommand: fx.facts.testCommand,
  });
  const sinceTs = Date.now();
  let platform = { status: null, stderr: '', startedAt: new Date(sinceTs).toISOString() };
  let trace;
  try {
    const prompt = `/pi-matt-implement-flow ${fx.facts.maxConcurrent || 2}\n\n${brief.text}`;
    const argv = ['-p', '--mode', 'json', '--session-dir', sessionDir];
    if (args.model) argv.push('--model', args.model);
    if (args.thinking) argv.push('--thinking', args.thinking);
    argv.push(prompt);
    const r = spawnSync(PI_BIN, argv, {
      cwd: fx.projectDir,
      env: { ...process.env, ...fx.env },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: args.timeout * 1000,
    });
    platform = {
      status: r.status,
      signal: r.signal || null,
      timedOut: Boolean(r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message))),
      stderr: String(r.stderr || '').slice(0, 4000),
      startedAt: new Date(sinceTs).toISOString(),
    };
    trace = harvestTrace({ def, fx, sessionDir });
  } catch (err) {
    trace = { schema: 'e2e-trace-1', scenario: def.id, source: 'harvested', fixture: fx.facts, uncertainty: ['platform-run-failed'], events: [] };
    platform.err = err.message.slice(0, 300);
  }

  const judgement = judgeTrace({ scenario: def.id, expectations: def.expectations, trace, stage });
  const doc = resultOf(def, judgement, {
    calls: 1,
    stage,
    fixture: { ...fx.manifest, projectDir: fx.projectDir },
    brief: { id: brief.id, sha256: brief.sha256 },
    trace: {
      source: trace.source,
      sessionDir,
      events: trace.events.length,
      uncertainty: trace.uncertainty || [],
      platform,
    },
  });
  writeResult(doc);

  if (args.json || args.dump) process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
  else {
    const lines = [`══ 场景 ${def.id}（${def.level}）：${judgement.status} [${judgement.kind}] ══`];
    lines.push(`  阶段        ${stage}`);
    lines.push(`  会话        1 次；轨迹事件 ${trace.events.length} 条；采集不确定性 ${(trace.uncertainty || []).join('、') || '无'}`);
    lines.push(`  证据        ${sessionDir}；项目 ${fx.projectDir}`);
    lines.push(`  判定        ${judgement.kindNote}`);
    for (const a of judgement.assertions) lines.push(`      ${a.state === 'pass' ? '✅' : a.state === 'fail' ? '❌' : '⚠️'} ${a.id}${a.note ? ` — ${a.note}` : ''}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  // 清理：证据目录（会话记录）保留给入口证据目录；fixture 项目默认删除（可用 PI_E2E_KEEP_FIXTURE 保留）
  if (!process.env.PI_E2E_KEEP_FIXTURE) fx.cleanup();
  process.exit(EXIT_BY_STATUS[judgement.status] ?? 2);
}

main();
