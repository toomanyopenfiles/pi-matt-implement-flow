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

// —— 不变量 10：超时契约：三个 agent 各自声明 1h run 死线；
// SKILL.md 派发模板的 gate 对象显式 10 分钟（平台常量 120s 不可配，只能 per-entry 覆盖；断锚 1/7 钉死）。
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
  checkCoderDispatchTypedGate,
  checkDispatchSchemaMatchesSource,
  checkFixLoopHandRun,
  checkBriefsNoReportDuties,
  checkGateCommandFlags,
  checkHardRulesRetained,
  checkPureVerdictGateAndEscalation,
  checkNoIsolationBriefs,
};

// —— 票 02 断锚：typed gate 派发形态（8 条）。检查器吃 SKILL.md / agents/coder.md
// 文本；schema 副本比对吃票 01 模块导出的真源（调用方 require 后传入），文档副本漂移即红。

function sectionBetween(text, startMarker, endMarker) {
  const s = text.indexOf(startMarker);
  if (s === -1) return null;
  if (!endMarker) return text.slice(s);
  const e = text.indexOf(endMarker, s + startMarker.length);
  return e === -1 ? text.slice(s) : text.slice(s, e);
}

// —— 断锚 1：票据 coder 派发块为 typed gate JSON 形态；acceptance 对象（非 false）
// 与 outputSchema 不再出现于派发面（平台互斥铁律：结构化输出源唯一）。
function checkCoderDispatchTypedGate(skillText) {
  const section = sectionBetween(skillText, '### Each round', '### Verify');
  if (section === null) return ['SKILL.md is missing the "### Each round" section'];
  const normalized = normalizeWhitespace(section);
  const problems = [];
  for (const anchor of [
    'gate: {',
    'output: "json"',
    `timeoutMs: ${GATE_VERIFY_TIMEOUT_MS}`,
    'mechanical-report.js',
    'required: ["headSha", "testResult", "changedFiles", "validationOutput"]',
  ]) {
    if (!normalized.includes(anchor)) {
      problems.push(`SKILL.md coder dispatch is missing the typed-gate anchor: ${anchor}`);
    }
  }
  // 旧形状只在派发代码块内禁用——解释散文仍可点名互斥铁律。
  const fence = section.match(/```js\n([\s\S]*?)\n```/);
  if (!fence) {
    problems.push('SKILL.md coder dispatch carries no fenced ```js dispatch block');
  } else {
    const block = normalizeWhitespace(fence[1]);
    for (const pattern of [/acceptance\s*:\s*\{/, /outputSchema/, /report\s*:\s*"on"/, /verify\s*:\s*\[/]) {
      if (pattern.test(block)) {
        problems.push(
          `SKILL.md coder dispatch still carries the old dispatch shape (${pattern}) — acceptance objects and outputSchema are retired from the dispatch face`
        );
      }
    }
  }
  return problems;
}

// —— 断锚 2：schema 副本与票 01 真源逐字一致（调用方 require 机械报告模块导出后传入）。
function extractFencedJsonCopy(text) {
  const m = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!m) return { error: 'no fenced ```json schema copy' };
  try {
    return { doc: JSON.parse(m[1]) };
  } catch (e) {
    return { error: `fenced \`\`\`json schema copy is not valid JSON: ${e.message}` };
  }
}

function checkDispatchSchemaMatchesSource(skillText, source) {
  const { doc, error } = extractFencedJsonCopy(skillText);
  if (error) {
    return [
      `SKILL.md carries ${error} — the dispatch schema copy must stay verbatim-identical to scripts/mechanical-report.js`,
    ];
  }
  const problems = [];
  if (JSON.stringify(doc) !== JSON.stringify(source.schema)) {
    problems.push(
      'SKILL.md dispatch schema copy drifted from the ticket-01 source (scripts/mechanical-report.js REPORT_SCHEMA) — the copy must stay verbatim-identical'
    );
  }
  const names = (source.fields ?? []).map((f) => f.name);
  if (JSON.stringify(doc.required ?? null) !== JSON.stringify(names)) {
    problems.push(
      `SKILL.md dispatch schema required list does not match the source field table [${names.join(', ')}]`
    );
  }
  return problems;
}

// —— 断锚 3：修复轮 = 编排者在 coder 保留 worktree 手跑同一条脚本命令
//（stdout 即该轮报告、退出码即该轮 gate；--base 恒为票基点；零报告职责）。
function checkFixLoopHandRun(skillText) {
  const section = sectionBetween(skillText, '### Fix loop', '### Merge');
  if (section === null) return ['SKILL.md is missing the "### Fix loop" section'];
  const normalized = normalizeWhitespace(section);
  const problems = [];
  for (const anchor of [
    'mechanical-report.js',
    '--base',
    'retained worktree',
    "stdout is that round's report",
    "exit code is that round's gate",
  ]) {
    if (!normalized.includes(anchor)) {
      problems.push(`SKILL.md fix loop is missing the hand-run anchor: ${anchor}`);
    }
  }
  for (const forbidden of [
    'acceptanceReport',
    'structured_output',
    'outputSchema',
    'stored acceptance contract',
    'treat the result as the gate',
  ]) {
    if (normalized.includes(forbidden)) {
      problems.push(`SKILL.md fix loop still carries the old fix-loop wording: ${forbidden}`);
    }
  }
  return problems;
}

// —— 断锚 4：简报（Briefs）与 coder agent 定义零报告职责——模型不再手写任何报告。
function checkBriefsNoReportDuties(skillText, coderAgentText) {
  const section = sectionBetween(skillText, '## Briefs', '## Hard rules');
  if (section === null) return ['SKILL.md is missing the "## Briefs" section'];
  const problems = [];
  const normalized = normalizeWhitespace(section);
  for (const token of ['acceptanceReport', 'structured_output', 'outputSchema', '## Acceptance Contract']) {
    if (normalized.includes(token)) {
      problems.push(`SKILL.md briefs still carry a report duty: ${token} — the model never hand-writes reports`);
    }
  }
  if (!normalized.includes('commit everything')) {
    problems.push('SKILL.md briefs lost the "commit everything" close-out duty');
  }
  if (coderAgentText !== undefined) {
    const coderNorm = normalizeWhitespace(coderAgentText);
    for (const token of ['acceptanceReport', 'structured_output', 'outputSchema', 'SIBLING']) {
      if (coderNorm.includes(token)) {
        problems.push(`agents/coder.md still carries the old contract wording: ${token}`);
      }
    }
    if (!coderNorm.includes('No handwritten reports')) {
      problems.push('agents/coder.md is missing the "No handwritten reports" clause');
    }
  }
  return problems;
}

// —— 断锚 5：每条机械报告 gate 命令都带 --base 与 --test-command。
// 只收以 node <this-package>/scripts/mechanical-report.js 起手的命令行——散文提及不算命令。
function checkGateCommandFlags(skillText) {
  const commands =
    skillText.match(/node <this-package>\/scripts\/mechanical-report\.js[^\n]*/g) ?? [];
  if (commands.length === 0) {
    return [
      'SKILL.md carries no mechanical-report gate command (`node <this-package>/scripts/mechanical-report.js …`)',
    ];
  }
  const problems = [];
  for (const cmd of commands) {
    for (const flag of ['--base', '--test-command']) {
      if (!cmd.includes(flag)) {
        problems.push(`SKILL.md gate command is missing ${flag}: ${cmd.trim()}`);
      }
    }
  }
  return problems;
}

// —— 断锚 6：既有硬规则断言保留（改写不得顺手删硬规则）。
function checkHardRulesRetained(skillText) {
  const section = sectionBetween(skillText, '## Hard rules', null);
  if (section === null) return ['SKILL.md is missing the "## Hard rules" section'];
  const normalized = normalizeWhitespace(section);
  const problems = [];
  for (const anchor of [
    'ticket-NN',
    'Fix budget then escalate',
    'blocked',
    'approved',
    'Never hand-write or edit the ledger or the event stream',
  ]) {
    if (!normalized.includes(anchor)) {
      problems.push(`SKILL.md hard rules lost an existing clause: ${anchor}`);
    }
  }
  return problems;
}

// —— 断锚 7：无隔离修复者（集成修复者 / 终审修复者）挂纯判定 gate
//（command + timeoutMs，无 output/schema）+ 连红 2 次停下升级给用户。
function checkPureVerdictGateAndEscalation(skillText) {
  const problems = [];
  const pureGateAnchor = `gate: { command: "<testCommand>", timeoutMs: ${GATE_VERIFY_TIMEOUT_MS} }`;
  for (const [name, start, end] of [
    ['merge/integration', '### Merge', '### Final gate'],
    ['final gate', '### Final gate', '## Briefs'],
  ]) {
    const section = sectionBetween(skillText, start, end);
    if (section === null) {
      problems.push(`SKILL.md is missing the "${start}" section`);
      continue;
    }
    const normalized = normalizeWhitespace(section);
    if (!normalized.includes(pureGateAnchor)) {
      problems.push(`SKILL.md ${name} section is missing the pure-verdict gate: ${pureGateAnchor}`);
    }
    for (const body of [...normalized.matchAll(/gate:\s*\{([^}]*)\}/g)].map((m) => m[1])) {
      if (/output|schema/.test(body)) {
        problems.push(`SKILL.md ${name} pure-verdict gate must not carry output/schema: gate: {${body}}`);
      }
    }
    for (const anchor of ['two consecutive reds', 'escalate to the user']) {
      if (!normalized.includes(anchor)) {
        problems.push(`SKILL.md ${name} section is missing the escalation anchor: ${anchor}`);
      }
    }
  }
  return problems;
}

// —— 断锚 8：第五套无隔离修复简报存在且零报告职责；无隔离简报只剩修复收尾职责。
function checkNoIsolationBriefs(skillText) {
  const briefs = sectionBetween(skillText, '## Briefs', '## Hard rules');
  if (briefs === null) return ['SKILL.md is missing the "## Briefs" section'];
  const problems = [];
  const normalized = normalizeWhitespace(briefs);
  if (!normalized.includes('five brief templates')) {
    problems.push(
      'SKILL.md path rule still counts four brief templates — the no-isolation final-fixer brief is the fifth'
    );
  }
  if (!briefs.includes('### Final fixer (no isolation)')) {
    problems.push('SKILL.md is missing the fifth brief: "### Final fixer (no isolation)"');
  }
  for (const [name, start, end] of [
    ['integration fixer', '### Integration fixer', '### Final fixer'],
    ['final fixer', '### Final fixer', '## Hard rules'],
  ]) {
    const sub = sectionBetween(briefs, start, end);
    if (sub === null) {
      problems.push(`SKILL.md is missing the "${start}" brief`);
      continue;
    }
    const subNorm = normalizeWhitespace(sub);
    for (const token of ['acceptanceReport', 'structured_output', 'outputSchema', 'Acceptance Contract']) {
      if (subNorm.includes(token)) {
        problems.push(`SKILL.md ${name} brief still carries a report duty: ${token}`);
      }
    }
    if (!subNorm.includes('commit on the feature branch')) {
      problems.push(`SKILL.md ${name} brief lost the close-out duty: commit on the feature branch`);
    }
  }
  return problems;
}
