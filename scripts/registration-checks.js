'use strict';

// 包注册不变量的纯校验逻辑。
// 所有 checker 都接收注入的数据/存在性谓词，不直接碰文件系统——
// 因此「模拟破坏」只需喂假想的 fixture，绝不改动真实文件。

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..');

// 三个 agent 的名字（不含包前缀）。包全名 = `${packageName}.${agentName}`。
const AGENT_NAMES = ['coder', 'reviewer', 'final-reviewer'];

// --- 读取（只读原语，供测试装配真实包树） ---

function readPackageJson(root = PKG_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function readText(root, relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

function isFileAt(root, relPath) {
  try {
    return fs.statSync(path.resolve(root, relPath)).isFile();
  } catch {
    return false;
  }
}

function isDirAt(root, relPath) {
  try {
    return fs.statSync(path.resolve(root, relPath)).isDirectory();
  } catch {
    return false;
  }
}

// --- frontmatter 最小解析（无 YAML 依赖；只需顶层 key: value 行） ---

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const frontmatter = {};
  for (const line of text.slice(3, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    frontmatter[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return frontmatter;
}

// --- 注册不变量：每条返回问题数组，空数组 = 通过 ---

// 不变量 1：pi.skills 声明的每个字面路径都指向真实存在的文件。
function checkSkillFileRegistration(manifest, { isFile = isFileAt } = {}) {
  const problems = [];
  const declared = manifest?.pi?.skills ?? [];
  if (!Array.isArray(declared) || declared.length === 0) {
    problems.push('package.json: pi.skills must declare at least one skill path');
    return problems;
  }
  for (const entry of declared) {
    if (typeof entry !== 'string') {
      problems.push(`pi.skills entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!isFile(entry)) {
      problems.push(`pi.skills entry points at a missing file: ${entry}`);
    }
  }
  return problems;
}

// 不变量 2：pi.subagents.agents 声明的每个路径都指向真实存在的目录。
function checkAgentDirRegistration(manifest, { isDir = isDirAt } = {}) {
  const problems = [];
  const agents = manifest?.pi?.subagents?.agents;
  if (!Array.isArray(agents)) {
    problems.push('package.json: pi.subagents.agents must be an array of paths');
    return problems;
  }
  if (agents.length === 0) {
    problems.push('package.json: pi.subagents.agents is empty');
  }
  for (const entry of agents) {
    if (typeof entry !== 'string') {
      problems.push(`pi.subagents.agents entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!isDir(entry)) {
      problems.push(`pi.subagents.agents entry points at a missing directory: ${entry}`);
    }
  }
  return problems;
}

// 不变量 3：SKILL.md frontmatter 合法——name 与包名一致、description 存在、模型自动调用禁用。
function checkSkillFrontmatter(frontmatter, packageName) {
  const problems = [];
  if (!frontmatter) {
    return ['SKILL.md has no parseable frontmatter block'];
  }
  if (frontmatter.name !== packageName) {
    problems.push(
      `SKILL.md name "${frontmatter.name ?? '(missing)'}" does not match package name "${packageName}"`
    );
  }
  if (!frontmatter.description) {
    problems.push('SKILL.md frontmatter is missing a description');
  }
  if (frontmatter['disable-model-invocation'] !== 'true') {
    problems.push(
      'SKILL.md frontmatter must set disable-model-invocation: true (skill is orchestrator-only, not for model auto-invocation)'
    );
  }
  return problems;
}

// 不变量 4：三个 agent 文件齐备，且各自以包全名形式声明（name + package，注册名为 `package.name`）。
// 单个 agent 的 frontmatter 校验是纯函数——破坏模拟只喂假想 fixture。
function checkAgentFrontmatter(frontmatter, agentName, packageName) {
  const problems = [];
  if (!frontmatter) {
    return [`missing agent file for "${agentName}"`];
  }
  if (!frontmatter.name) {
    problems.push(`agent "${agentName}" frontmatter is missing its name field`);
  } else if (frontmatter.name !== agentName) {
    problems.push(
      `agent "${agentName}" declares name "${frontmatter.name}", which does not match its file`
    );
  }
  if (!frontmatter.package) {
    problems.push(
      `agent "${agentName}" frontmatter is missing the package field — without it the agent registers under its bare name, colliding with builtin reviewer and user aliases`
    );
  } else if (frontmatter.package !== packageName) {
    problems.push(
      `agent "${agentName}" declares package "${frontmatter.package}", which does not match package name "${packageName}"`
    );
  }
  return problems;
}

function checkAgentRegistration(agentFrontmatter, packageName) {
  const problems = [];
  for (const agentName of AGENT_NAMES) {
    problems.push(...checkAgentFrontmatter(agentFrontmatter[agentName], agentName, packageName));
  }
  return problems;
}

// 不变量 5：test 脚本存在且调用 node 内建测试跑器。
function checkTestScript(manifest) {
  const problems = [];
  const testScript = manifest?.scripts?.test;
  if (!testScript) {
    problems.push('package.json: no "test" script defined');
    return problems;
  }
  if (!/\bnode\b.*--test|--test.*\bnode\b/.test(testScript)) {
    problems.push(
      `package.json: test script "${testScript}" does not invoke node's built-in test runner (--test)`
    );
  }
  return problems;
}

// 不变量 6：coder 简报契约的 worktree 现实块（P1-1）。
// 提示词契约没有机械执法点，唯一可自动测的外部行为面是 SKILL.md 的内容不变量：
// Worktree reality 块存在、编排笔记指针退役、软围栏句按用户裁定原句存在。
const WORKTREE_REALITY_HEADING = '## Worktree reality';
const RETIRED_NOTES_POINTER = 'Notes (read if present)';
const SOFT_FENCE_SENTENCE =
  'Other tickets under .scratch/ and anything else in the main repo are context, not scope — never implement them.';

function checkCoderBriefWorktreeReality(skillText) {
  const problems = [];
  // 软围栏句按空白归一化匹配：锁定措辞原句，容忍模板内的换行折行。
  const normalized = skillText.replace(/\s+/g, ' ');
  if (!skillText.includes(WORKTREE_REALITY_HEADING)) {
    problems.push('SKILL.md is missing the "## Worktree reality" block in the coder brief');
  }
  if (skillText.includes(RETIRED_NOTES_POINTER)) {
    problems.push(
      'SKILL.md still points coders at the orchestration notes ("Notes (read if present)") — the pointer is retired: coders never read the orchestration notes'
    );
  }
  if (!normalized.includes(SOFT_FENCE_SENTENCE)) {
    problems.push(
      'SKILL.md is missing the user-adjudicated soft-fence sentence ("…are context, not scope — never implement them") — do not reword or drop it'
    );
  }
  return problems;
}

// 不变量 7：ledger 脚本存在——机械台账协议的唯一写面必须随包交付（ADR-0001）。
const LEDGER_SCRIPT = 'scripts/ledger.js';
function checkLedgerScript({ isFile = isFileAt } = {}) {
  return isFile(LEDGER_SCRIPT)
    ? []
    : [`ledger script missing: ${LEDGER_SCRIPT} — the mechanical-ledger protocol's only write surface`];
}

module.exports = {
  PKG_ROOT,
  AGENT_NAMES,
  readPackageJson,
  readText,
  isFileAt,
  isDirAt,
  parseFrontmatter,
  checkSkillFileRegistration,
  checkAgentDirRegistration,
  checkSkillFrontmatter,
  checkAgentFrontmatter,
  checkAgentRegistration,
  checkTestScript,
  checkCoderBriefWorktreeReality,
  LEDGER_SCRIPT,
  checkLedgerScript,
};
