'use strict';
// ============================================================================
// 真实模型验收场景清单（数据）——统一受支持入口 test/e2e/accept.js 的默认清单。
//
// 每个场景指明：探针脚本、探针参数、每次运行会发生的真实模型调用数（callsPerRun）、
// 单次尝试超时、验证层级与边界声明、写入范围。入口按此展示计划并要求人工授权；
// 场景本身不自行启动模型，也不读取授权。
//
// 分级说明（不把局部探针冒充完整验收）：
//   platform-contract-probe —— 真实平台上的局部契约探针：在真实 pi + 真实模型上调
//   验某一个平台契约事实。它不是一次完整 reviewer 运行，也不是完整流程 E2E。
//   导航验收（模型能否从主干自行找到披露文档）与完整流程场景属于后续批次。
// ============================================================================

const flowScenarios = require('./flow-scenarios');
const { fixtureFacts, fixtureManifest, judgementSummary } = require('./lib/fixture-spec');
const { buildBrief } = require('./lib/navigation-brief');

const AXES_PROBE = 'test/e2e/probes/repro-reviewer-axes.js';

// 流程 / 导航 / 角色场景：把场景定义翻成入口场景条目，并把 fixture 标识、任务书标识与
// 判定契约摘要一并钉进计划（都不含副作用：只做纯计算，计划阶段不建目录、不跑模型）。
function flowEntry(def) {
  const entry = flowScenarios.scenarioEntry(def);
  const facts = fixtureFacts(def);
  const brief = buildBrief(def);
  return {
    ...entry,
    fixtureFacts: facts,
    fixture: fixtureManifest(def, facts),
    brief: { id: brief.id, version: brief.version, sha256: brief.sha256, inputs: brief.inputs },
    judgement: judgementSummary(def.expectations),
  };
}

const SCENARIOS = [
    {
      id: 'axes-keyless',
      title: '双轴派发契约：runs.all 条目缺 key 被平台拒绝（#6 缺陷 2 的契约事实）',
      probe: AXES_PROBE,
      args: ['--only', 'keyless'],
      callsPerRun: 1,
      timeoutMs: 300000,
      level: 'platform-contract-probe',
      claim: '局部平台契约探针：只调验 runs.all 条目缺 key 被拒。不是完整 reviewer，也不是流程 E2E。',
      writes: { files: '临时会话目录（探针证据，/tmp 下）', network: '模型 provider API（探针会话）', remote: '无' },
    },
    {
      id: 'axes-reviewer',
      title: 'reviewer 定义的双轴时限保证：收场不得抢在两根轴完成之前',
      probe: AXES_PROBE,
      args: ['--only', 'reviewer'],
      callsPerRun: 3,
      timeoutMs: 900000,
      level: 'platform-contract-probe',
      claim: '局部平台契约探针：从一个真实派发提取轴契约并在真实平台实例化。不是完整 reviewer 验收，也不是流程 E2E。',
      writes: { files: '临时会话目录（探针证据，/tmp 下）', network: '模型 provider API（探针会话）', remote: '无' },
    },
    {
      id: 'axes-final-reviewer',
      title: 'final-reviewer 定义的双轴时限保证：收场不得抢在两根轴完成之前',
      probe: AXES_PROBE,
      args: ['--only', 'final-reviewer'],
      callsPerRun: 3,
      timeoutMs: 900000,
      level: 'platform-contract-probe',
      claim: '局部平台契约探针：从一个真实派发提取轴契约并在真实平台实例化。不是完整 final-reviewer 验收，也不是流程 E2E。',
      writes: { files: '临时会话目录（探针证据，/tmp 下）', network: '模型 provider API（探针会话）', remote: '无' },
    },
    ...flowScenarios.ENTRIES.map(flowEntry),
];

module.exports = { scenarios: SCENARIOS };
