'use strict';
// ============================================================================
// 导航任务书（票 35）：真实批次里交给被测模型的用户式任务书。
//
// 两条硬要求：
//   1. **正常输入照给**：spec、票据、流程配置、测试命令等生产流程本来就要的输入；
//   2. **不指路**：不出现任何外移参考文档的路径或文件名（SKILL.md、run/*.md、
//      agents/*.md、scripts/run-timeout-settings.md …）。模型必须自己从主干找到并加载
//      当前阶段的文档——这正是导航验收要测的行为。
//
// 不指路是机器可判的：文档清单来自 scripts/registration-checks.js 的
// CONTRACT_DOCUMENTS（位置变化自动跟随登记表），`findDisclosureLeaks` 按路径与文件名
// 双形态检查。任务书是数据，哈希进计划与授权范围；改任务书必须重新授权。
// ============================================================================

const path = require('node:path');

const { contractDocPaths } = require('../../../scripts/registration-checks.js');
const { sha256 } = require('./digest');

const DOC_PATHS = contractDocPaths();
const DOC_BASENAMES = [...new Set(DOC_PATHS.map((p) => path.basename(p)))];

const BRIEF_VERSION = 'e2e-brief-1';

function briefId(def) {
  return `${def.id}-brief-1`;
}

// 任务书正文：默认路径是占位符——计划阶段不创建任何目录，哈希与真实临时路径无关。
function buildBrief(def, {
  projectDir = '<scratch-project>',
  trackerDir = '<scratch-project>/.pi/matt-implement/<slug>/tracker',
  testCommand = 'npm test',
} = {}) {
  const brief = def.brief || {};
  const lines = [
    `You are the orchestrator, working in an isolated scratch project. Nothing here touches a real`,
    `user project or a real remote tracker.`,
    ``,
    `Project root: ${projectDir}`,
    `Normal inputs for this run:`,
    `- spec: ${trackerDir}/spec.md`,
    `- tickets: ${trackerDir}/issues/ (the dependency graph is written inside the ticket files)`,
    `- flow configuration: ${projectDir}/.pi/settings.json (the mattImplementFlow section holds this run's shape)`,
    `- test command: ${testCommand} (run from the project root)`,
    ``,
    `Situation: ${brief.situation || ''}`,
    `Do: ${brief.ask || ''}`,
    ``,
    `Work from the skill's own instructions: start at your instruction entry point and find`,
    `and load on your own whatever the current stage requires — this brief deliberately does not`,
    `name any instruction document for you. Do not wait for me between steps; continue until this`,
    `stage's own continuation condition holds. Do not restate instruction text.`,
    `When you stop, report only what you actually did — commands, paths, SHAs, results — plus any`,
    `missing input you are waiting for.`,
    ``,
  ];
  const text = lines.join('\n');
  return {
    version: BRIEF_VERSION,
    id: briefId(def),
    step: def.id,
    sha256: sha256(text),
    text,
    inputs: {
      spec: 'spec.md',
      tickets: 'issues/',
      configuration: '.pi/settings.json',
      testCommand,
    },
    disclosure: 'task-brief-names-no-instruction-document',
  };
}

// 不指路的机器检查：命中登记表里的文档路径或其文件名即泄漏。
function findDisclosureLeaks(text) {
  const body = String(text || '');
  const leaks = [];
  for (const doc of DOC_PATHS) {
    if (body.includes(doc)) leaks.push(doc);
  }
  for (const base of DOC_BASENAMES) {
    if (body.includes(base)) leaks.push(base);
  }
  return [...new Set(leaks)];
}

module.exports = {
  BRIEF_VERSION,
  DOC_PATHS,
  DOC_BASENAMES,
  buildBrief,
  briefId,
  findDisclosureLeaks,
  sha256,
};
