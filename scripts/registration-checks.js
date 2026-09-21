'use strict';

// 包注册不变量的纯校验逻辑。
// 所有 checker 都接收注入的数据/存在性谓词，不直接碰文件系统——
// 因此「模拟破坏」只需喂假想的 fixture，绝不改动真实文件。

const fs = require('node:fs');
const path = require('node:path');

const PKG_ROOT = path.resolve(__dirname, '..');

// 常量单一来源：agent 角色表与超时契约值来自 flow-config-core，避免两处漂移。
const { ROLES, AGENT_TIMEOUT_MS, GATE_VERIFY_TIMEOUT_MS } = require('./flow-config-core.js');

// 三个 agent 的名字（不含包前缀）。包全名 = `${packageName}.${agentName}`。
const AGENT_NAMES = ROLES;

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

// —— 不变量 6：coder 简报契约的 worktree 现实块（P1-1）。
// 提示词契约没有机械执法点，唯一可自动测的外部行为面是 SKILL.md 的内容不变量：
// Worktree reality 块存在、编排笔记指针退役、软围栏句按用户裁定原句存在。
const WORKTREE_REALITY_HEADING = '## Worktree reality';
const RETIRED_NOTES_POINTER = 'Notes (read if present)';
const SOFT_FENCE_SENTENCE =
  'Other tickets under .scratch/ and anything else in the main repo are context, not scope — never implement them.';

// 内容不变量的共用预处与：按空白归一化后匹配，锁定措辞原句、容忍模板内折行。
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ');
}

function checkCoderBriefWorktreeReality(skillText) {
  const problems = [];
  const normalized = normalizeWhitespace(skillText);
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

// —— 不变量 7：Round 0 的环境勘测步骤（P1-1 票 02）——勘测结论属散文，归宿是编排
// 笔记「环境事实」节，永不进事件流。锚点限定在 Round 0 小节内：步骤漂出 Round 0
// 或小节被删时检查照样红；锚点字符串是步骤名与节的定名。
function checkRound0EnvSurvey(skillText) {
  const start = skillText.indexOf('### Round 0');
  if (start === -1) {
    return ['SKILL.md is missing the "### Round 0" section'];
  }
  const end = skillText.indexOf('\n### ', start + 1);
  const normalized = normalizeWhitespace(end === -1 ? skillText.slice(start) : skillText.slice(start, end));
  const missing = ['Environment survey', '环境事实'].filter((s) => !normalized.includes(s));
  return missing.length === 0
    ? []
    : [
        `SKILL.md Round 0 is missing the environment-survey step (read .gitignore, write the 环境事实 section of the orchestration notes; missing anchors: ${missing.join(', ')})`,
      ];
}

// —— 不变量 8：ledger 脚本存在——机械台账协议的唯一写面必须随包交付（ADR-0001）。
const LEDGER_SCRIPT = 'scripts/ledger.js';
function checkLedgerScript({ isFile = isFileAt } = {}) {
  return isFile(LEDGER_SCRIPT)
    ? []
    : [`ledger script missing: ${LEDGER_SCRIPT} — the mechanical-ledger protocol's only write surface`];
}

// —— 不变量 9：pi.extensions 声明与 /matt-flow-config 扩展文件。
// 谓词为 path-only（与兄弟 checker 同形），默认绑定包根。
function checkExtensionRegistration(manifest, {
  isFile = (p) => isFileAt(PKG_ROOT, p),
  isDir = (p) => isDirAt(PKG_ROOT, p),
} = {}) {
  const problems = [];
  const declared = manifest?.pi?.extensions ?? [];
  if (!Array.isArray(declared) || declared.length === 0) {
    problems.push('package.json: pi.extensions must declare at least one extension path');
    return problems;
  }
  for (const entry of declared) {
    if (typeof entry !== 'string') {
      problems.push(`pi.extensions entry is not a string path: ${JSON.stringify(entry)}`);
      continue;
    }
    // 条目可以是文件或目录（pi manifest 两者都合法）；相对路径以包根为基准。
    if (!isFile(entry) && !isDir(entry)) {
      problems.push(`pi.extensions entry points at a missing path: ${entry}`);
    }
  }
  return problems;
}

const EXTENSION_SCRIPT = 'extensions/matt-flow-config.js';
function checkFlowConfigExtension({ isFile = (p) => isFileAt(PKG_ROOT, p) } = {}) {
  return isFile(EXTENSION_SCRIPT)
    ? []
    : [`flow-config extension missing: ${EXTENSION_SCRIPT} — /matt-flow-config is its registration surface`];
}

// —— 不变量 10：超时契约：三个 agent 各自声明 1h run 死线，
// SKILL.md 派发模板的 gate verify 条目显式 10 分钟（平台常量 120s 不可配，只能 per-entry 覆盖）。
function checkAgentTimeoutFrontmatter(frontmatter, agentName) {
  if (!frontmatter) return [`missing agent file for "${agentName}"`];
  return frontmatter.timeoutMs === String(AGENT_TIMEOUT_MS)
    ? []
    : [
        `agent "${agentName}" frontmatter must declare timeoutMs: ${AGENT_TIMEOUT_MS} (1h run deadline; platform default without it is 30 min), got: ${frontmatter.timeoutMs ?? '(missing)'}`,
      ];
}

function checkAgentTimeouts(agentFrontmatter) {
  const problems = [];
  for (const agentName of AGENT_NAMES) {
    problems.push(...checkAgentTimeoutFrontmatter(agentFrontmatter[agentName], agentName));
  }
  return problems;
}

const GATE_VERIFY_ANCHOR = `verify: [{ id: "gate", command: "npm test", timeoutMs: ${GATE_VERIFY_TIMEOUT_MS} }]`;
function checkGateVerifyTimeout(skillText) {
  return skillText.includes(GATE_VERIFY_ANCHOR)
    ? []
    : [
        `SKILL.md coder dispatch template must pin the gate verify timeout verbatim: ${GATE_VERIFY_ANCHOR} (platform verify default is a fixed 120 s and not configurable)`,
      ];
}

// —— 不变量 11：验收契约软化——意见型证据字段处置的单一真相。
// 派发 acceptance 的 evidence 清单里 residual-risks（纯意见型、无 git 对应物）从强制降为建议：
// 它不再参与「证据缺失 → run 拒收」的集合，因此纯文档票不会因漏填一个字段被平台拒收。
// 三处契约文本（evidence 数组、Acceptance Contract 的 Rules 句、fix follow-up 简报）必须同口径，
// 这里机械锁定其中两处：清单本身（不含 residual-risks，其余五项原样）与 Rules 句的执法集合。
const ADVISORY_EVIDENCE_FIELD = 'residual-risks';
const DISPATCHED_EVIDENCE_FIELDS = [
  'changed-files',
  'tests-added',
  'commands-run',
  'validation-output',
  'no-staged-files',
];
const RULES_ENFORCEMENT_PATTERN = /missing evidence from the dispatched set \(([^)]*)\) rejects the run/;

function parseDispatchedEvidenceFields(skillText) {
  const match = skillText.match(/evidence:\s*\[([^\]]*)\]/);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
}

function normalizeEvidenceFields(fields) {
  return [...fields].map((f) => f.trim()).filter(Boolean).sort();
}

function checkAcceptanceEvidenceContract(skillText) {
  const problems = [];
  const dispatched = parseDispatchedEvidenceFields(skillText);
  if (!dispatched) {
    return [
      'SKILL.md coder dispatch carries no parseable acceptance evidence list (`evidence: [...]`) — the dispatched evidence contract has no mechanical anchor',
    ];
  }
  if (dispatched.includes(ADVISORY_EVIDENCE_FIELD)) {
    problems.push(
      `SKILL.md dispatch evidence list still enforces the advisory field "${ADVISORY_EVIDENCE_FIELD}" — the opinion-type field must stay out of the missing-evidence-rejects-the-run set`
    );
  }
  if (normalizeEvidenceFields(dispatched).join(',') !== normalizeEvidenceFields(DISPATCHED_EVIDENCE_FIELDS).join(',')) {
    problems.push(
      `SKILL.md dispatch evidence list drifted from the softened contract — expected [${DISPATCHED_EVIDENCE_FIELDS.join(', ')}], got [${dispatched.join(', ')}]`
    );
  }
  const enforced = (normalizeWhitespace(skillText).match(RULES_ENFORCEMENT_PATTERN) ?? [])[1];
  if (enforced === undefined) {
    problems.push(
      'SKILL.md Acceptance Contract Rules sentence no longer names the enforced evidence set (`missing evidence from the dispatched set (<fields>) rejects the run`) — the sentence must stay in one voice with the dispatched list'
    );
  } else {
    const enforcedFields = enforced.split(/\s*,\s*/);
    if (normalizeEvidenceFields(enforcedFields).join(',') !== normalizeEvidenceFields(dispatched).join(',')) {
      problems.push(
        `SKILL.md Acceptance Contract Rules sentence disagrees with the dispatched evidence list — sentence enforces [${enforcedFields.join(', ')}], dispatch declares [${dispatched.join(', ')}]`
      );
    }
  }
  return problems;
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
  checkRound0EnvSurvey,
  LEDGER_SCRIPT,
  checkLedgerScript,
  EXTENSION_SCRIPT,
  checkExtensionRegistration,
  checkFlowConfigExtension,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  checkAgentTimeouts,
  checkGateVerifyTimeout,
  DISPATCHED_EVIDENCE_FIELDS,
  ADVISORY_EVIDENCE_FIELD,
  checkAcceptanceEvidenceContract,
};
