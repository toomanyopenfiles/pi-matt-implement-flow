'use strict';

// /matt-flow-config 的纯逻辑层（无 pi 依赖、无 UI、文件访问全部可注入）。
// UI 接线在 extensions/matt-flow-config.js；本文件只回答「改什么、怎么合并、
// 生效值是什么」。

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ID = 'pi-matt-implement-flow';
const ROLES = ['coder', 'reviewer', 'final-reviewer'];
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// --- 流程配置（settings.json 顶层自定义节） ---
// 本包自己的流程开关，只在 pi-matt-implement-flow 内生效——绝不写 subagents.*
// 等平台键，平台对未知顶层键直接忽略。生效语义（方案乙）：run 启动时由编排器把
// 生效值作为 init 事件旗标冻结进台账，此后 ledger 校验按快照执行，中途改配置
// 不影响进行中的 run。
const FLOW_SECTION = 'mattImplementFlow';
const FLOW_DEFAULTS = { reviewer: true, maxFixRounds: 2, maxConcurrent: 3 };
const FLOW_KEYS = Object.keys(FLOW_DEFAULTS);

// 三个 agent frontmatter 的 run 级墙钟默认（每个 dispatch child 一个死线，
// fix-resume 继承同一 frontmatter）。平台不设时是 30 分钟。
const AGENT_TIMEOUT_MS = 3600000;

// SKILL.md 派发模板里 gate verify 条目的显式超时。平台常量
// DEFAULT_VERIFY_TIMEOUT_MS = 120_000 且不可配置，只能 per-entry 覆盖。
const GATE_VERIFY_TIMEOUT_MS = 600000;

// 补丁哨兵：出现在 patch 值上 = 删除该键（回退到更低的优先级层）。
const CLEAR = Symbol('flow-config.clear');

// agent 全名 —— settings 覆盖键必须是注册时的运行时全名（包 agent 的
// agent.name 就是 `package.localName`）。
function fullName(role) {
  return `${PACKAGE_ID}.${role}`;
}

// --- 路径解析（镜像 pi-subagents 的实际读取位置；写错地方 = 配置静默不生效） ---

// 用户级 settings 所在目录：PI_CODING_AGENT_DIR（支持 "~" 与 "~/…"），
// 否则 <home>/<configDirName>/agent。镜像 getAgentDir()。
function resolveAgentDir(env = {}, home = '', configDirName = '.pi') {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured === '~') return home;
  if (configured && configured.startsWith('~/')) return path.join(home, configured.slice(2));
  return configured || path.join(home, configDirName, 'agent');
}

function userSettingsPath(env, home, configDirName) {
  return path.join(resolveAgentDir(env, home, configDirName), 'settings.json');
}

// 项目根发现（镜像 pi-subagents findProjectRootCandidates + findConfiguredProjectRoot）：
// 候选 = 从 cwd 向上、各含 <configDirName>/ 或 .agents/ 目录的祖先（home 本身不算）。
// 默认策略 nearest = 最近候选；某个候选的 settings 声明
// subagents.projectRootResolution === "git-root" 时改用 git 根。判定顺序完全镜像平台：
// 从最近候选向上扫策略——先遇 "nearest" 即取最近；遇 "git-root" 记下策略根并停；
// 然后 git 根必须在策略根及以上的候选里，否则策略根本身是 git 根就用它，再否则退回最近。
function defaultIsDir(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function defaultFindGitRoot(cwd) {
  let currentDir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(currentDir, '.git'))) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function findProjectRoot(cwd, {
  configDirName = '.pi',
  homeDir,
  isDir = defaultIsDir,
  exists = fs.existsSync,
  readSettings = (settingsPath) => readSettingsFile(settingsPath),
  findGitRoot = defaultFindGitRoot,
} = {}) {
  const homeResolved = homeDir ? path.resolve(homeDir) : null;
  const candidates = [];
  let currentDir = path.resolve(cwd);
  for (;;) {
    if (homeResolved && currentDir === homeResolved) break;
    if (
      isDir(path.join(currentDir, configDirName)) ||
      isDir(path.join(currentDir, '.agents'))
    ) {
      candidates.push(currentDir);
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  const nearest = candidates[0];
  if (!nearest) return null;

  let policyRoot;
  let policyRootIndex = -1;
  for (const [index, candidate] of candidates.entries()) {
    const settings = readSettings(path.join(candidate, configDirName, 'settings.json'));
    const mode = settings?.subagents?.projectRootResolution;
    if (mode === 'nearest') return nearest;
    if (mode === 'git-root') {
      policyRoot = candidate;
      policyRootIndex = index;
      break;
    }
  }
  if (!policyRoot) return nearest;

  const gitRoot = findGitRoot(cwd);
  const gitCandidate = gitRoot
    ? candidates.slice(policyRootIndex).find((candidate) => candidate === path.resolve(gitRoot))
    : undefined;
  const policyRootIsGitRoot = exists(path.join(policyRoot, '.git')) ? policyRoot : undefined;
  return gitCandidate ?? policyRootIsGitRoot ?? nearest;
}

function projectSettingsPath(cwd, options) {
  const root = findProjectRoot(cwd, options);
  if (!root) return null;
  return path.join(root, options?.configDirName ?? '.pi', 'settings.json');
}

// --- 流程配置读取 / 合并 / 写换（纯函数；非法值宽容回退默认，不阻塞 run 启动） ---

// 单层 settings 的 flow 节规范化：只认已知键；reviewer 须布尔，数值键须 >=1 整数，
// 其余一律忽略（手改写坏不应炸掉流程；向导是唯一常规写入口，写入值必然合法）。
function flowSectionFor(settings) {
  const raw = settings?.[FLOW_SECTION];
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of FLOW_KEYS) {
    const v = raw[key];
    if (key === 'reviewer') {
      if (typeof v === 'boolean') out.reviewer = v;
    } else if (Number.isInteger(v) && v >= 1) {
      out[key] = v;
    }
  }
  return out;
}

// 分层解析：project 逐字段赢 user，缺省键回退 FLOW_DEFAULTS。
// 返回 { values, sources }：values 是完整生效配置，sources 每键标 'default'|'user'|'project'。
function resolveFlowConfigDetailed(userSettings = {}, projectSettings = {}) {
  const user = flowSectionFor(userSettings);
  const project = flowSectionFor(projectSettings);
  const values = {};
  const sources = {};
  for (const key of FLOW_KEYS) {
    if (key in project) {
      values[key] = project[key];
      sources[key] = 'project';
    } else if (key in user) {
      values[key] = user[key];
      sources[key] = 'user';
    } else {
      values[key] = FLOW_DEFAULTS[key];
      sources[key] = 'default';
    }
  }
  return { values, sources };
}

// 把 patch 应用到 settings 顶层的 flow 节；CLEAR 删键（回退默认）。返回新 settings，
// 不改动入参；节为空则整节退场——与 withAgentOverride 同一写换纪律。
function withFlowConfig(settings, patch) {
  const next = { ...settings };
  const section = { ...(next[FLOW_SECTION] ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === CLEAR) delete section[key];
    else section[key] = value;
  }
  if (Object.keys(section).length > 0) next[FLOW_SECTION] = section;
  else delete next[FLOW_SECTION];
  return next;
}

// --- settings 读写（薄 IO；解析失败抛可读错误，绝不静默重建） ---

function readSettingsFile(filePath, { readFileSync = fs.readFileSync, existsSync = fs.existsSync } = {}) {
  if (!filePath || !existsSync(filePath)) return {};
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read settings file ${filePath}: ${error.message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`settings file is not valid JSON: ${filePath} — fix it by hand first (${error.message})`);
  }
}

// 与 pi-subagents profiles 写回格式一致：2 空格缩进 + 结尾换行。
function serializeSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function writeSettingsFile(filePath, settings, { mkdirSync = fs.mkdirSync, writeFileSync = fs.writeFileSync } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeSettings(settings), 'utf8');
}

// --- 覆盖合并与生效解析 ---

// 逐字段合并：user 先应用、project 后应用，project 字段赢、user 独有字段保留
// （镜像 applyCustomAgentOverrides 的 user→project 叠加顺序）。
function mergeOverrides(userOverride, projectOverride) {
  return { ...(userOverride ?? {}), ...(projectOverride ?? {}) };
}

// 按作用域合并：scopedOverride = 正在编辑的那一层，otherOverride = 另一层。
// 最终语义永远是 project 逐字段赢 user，与调用方传参与否无关——
// 位置参数（user, project）很容易传反（第二轮 review P1），所以调用方一律用本函数。
function mergeScopedOverrides({ scope, scopedOverride, otherOverride }) {
  return scope === 'project'
    ? mergeOverrides(otherOverride, scopedOverride)
    : mergeOverrides(scopedOverride, otherOverride);
}

function overrideFor(settings, role) {
  const overrides = settings?.subagents?.agentOverrides;
  if (!overrides || typeof overrides !== 'object') return undefined;
  const value = overrides[fullName(role)];
  return value && typeof value === 'object' ? value : undefined;
}

// 展示用生效解析：覆盖层（false = 显式清除）→ frontmatter 包默认 → 继承。
function resolveEffective(frontmatter = {}, merged = {}) {
  let model;
  if (merged.model === false) model = { value: null, source: 'cleared (inherit)' };
  else if (typeof merged.model === 'string' && merged.model.trim()) model = { value: merged.model.trim(), source: 'settings override' };
  else if (frontmatter.model) model = { value: frontmatter.model, source: 'package frontmatter' };
  else model = { value: null, source: 'inherit (parent session / subagents.defaultModel)' };

  let thinking;
  if (merged.thinking === false) thinking = { value: null, source: 'cleared' };
  else if (typeof merged.thinking === 'string' && merged.thinking.trim()) thinking = { value: merged.thinking.trim(), source: 'settings override' };
  else if (frontmatter.thinking) thinking = { value: frontmatter.thinking, source: 'package frontmatter' };
  else thinking = { value: null, source: 'parent default' };

  return { model, thinking };
}

// 把 patch 应用到单个 agent 的覆盖对象；CLEAR 值删键；结果为空则整个覆盖
// 对象退场（undefined）。返回新对象，不改动入参。
function applyPatch(override, patch) {
  const next = { ...(override ?? {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === CLEAR) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

// 返回写入后的完整 settings 新对象（不改动入参）。patch 传 null = 删除该
// agent 的整个覆盖键。只触碰 subagents.agentOverrides 下我们自己的全名键。
function withAgentOverride(settings, role, patch) {
  const next = { ...settings };
  const subagents = { ...(next.subagents ?? {}) };
  const overrides = { ...(subagents.agentOverrides ?? {}) };
  if (patch === null) delete overrides[fullName(role)];
  else {
    const updated = applyPatch(overrides[fullName(role)], patch);
    if (updated === undefined) delete overrides[fullName(role)];
    else overrides[fullName(role)] = updated;
  }
  if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides;
  else delete subagents.agentOverrides;
  if (Object.keys(subagents).length > 0) next.subagents = subagents;
  else delete next.subagents;
  return next;
}

// --- 展示与 diff（纯字符串，供 UI 层 confirm/appendEntry 直接使用） ---

function describeOverride(override) {
  if (!override) return '(no override)';
  const parts = [];
  if ('model' in override) parts.push(`model=${override.model === false ? '(cleared)' : override.model}`);
  if ('thinking' in override) parts.push(`thinking=${override.thinking === false ? '(cleared)' : override.thinking}`);
  for (const key of Object.keys(override)) {
    if (key !== 'model' && key !== 'thinking') parts.push(`${key}=${JSON.stringify(override[key])}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(empty)';
}

// 生成 confirm 用的人类可读 diff（只列被 patch 触碰的字段）。
function renderPatchPreview(patch, { role, scopeLabel }) {
  const lines = [`[${scopeLabel}] ${fullName(role)}`];
  for (const [key, value] of Object.entries(patch)) {
    if (value === CLEAR) lines.push(`  ${key}: (removed — falls back to the lower layer)`);
    else lines.push(`  ${key}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

// agent frontmatter 里与本功能相关的三个字段（行式 key: value，够用即可）。
function extractFrontmatterFields(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const fields = {};
  for (const line of text.slice(3, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (key === 'model' || key === 'thinking' || key === 'timeoutMs') {
      fields[key] = line.slice(i + 1).trim();
    }
  }
  return fields;
}

// show 视图（两节式，全英文文案）：
//   Flow 节 —— mattImplementFlow 生效值 + 来源（default/user/project）+ 一句作用说明；
//   Agents 节 —— 三角色各一行：生效 model / thinking 及其来源层。
// parentModel = 当前会话模型（继承时生效目标），供展示而非推断。纯函数。
const FLOW_HINTS = {
  reviewer:
    'per-ticket two-axis review + fix loop; off = merge straight after the platform gate (final-reviewer still runs)',
  maxFixRounds: 'fix attempts per ticket; only meaningful when reviewer=on',
  maxConcurrent: 'parallel coders; /pi-matt-implement-flow <N> wins',
};

function buildShowView({ frontmatterByRole = {}, userSettings = {}, projectSettings = {}, userPath, projectPath, parentModel } = {}) {
  const { values: flow, sources: flowSources } = resolveFlowConfigDetailed(userSettings, projectSettings);
  const lines = [];
  lines.push('matt-implement-flow — current resolution');
  if (parentModel) lines.push(`parent session model (inherit target): ${parentModel}`);
  lines.push('');
  lines.push(`Flow (settings key "${FLOW_SECTION}"; project wins user per field)`);
  const keyWidth = Math.max(...FLOW_KEYS.map((k) => k.length));
  for (const key of FLOW_KEYS) {
    const shown = typeof flow[key] === 'boolean' ? (flow[key] ? 'on' : 'off') : String(flow[key]);
    lines.push(`  ${key.padEnd(keyWidth)}  ${shown.padEnd(4)} [${flowSources[key]}]  ${FLOW_HINTS[key]}`);
  }
  const scopeParts = [];
  if (projectPath) scopeParts.push(`project → ${projectPath}`);
  if (userPath) scopeParts.push(`user → ${userPath}`);
  if (scopeParts.length) lines.push(`  scope: ${scopeParts.join(' · ')}`);
  lines.push('');
  lines.push('Agents (effective model / thinking)');
  for (const role of ROLES) {
    const fm = frontmatterByRole[role] ?? {};
    const effective = resolveEffective(fm, mergeOverrides(overrideFor(userSettings, role), overrideFor(projectSettings, role)));
    lines.push(
      `  ${fullName(role).padEnd(39)} model=${effective.model.value ?? '(inherit)'} [${effective.model.source}], ` +
        `thinking=${effective.thinking.value ?? '(default)'} [${effective.thinking.source}]`
    );
  }
  return lines.join('\n');
}

module.exports = {
  CLEAR,
  PACKAGE_ID,
  ROLES,
  THINKING_LEVELS,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  FLOW_SECTION,
  FLOW_DEFAULTS,
  FLOW_KEYS,
  flowSectionFor,
  resolveFlowConfigDetailed,
  withFlowConfig,
  fullName,
  resolveAgentDir,
  userSettingsPath,
  findProjectRoot,
  projectSettingsPath,
  readSettingsFile,
  serializeSettings,
  writeSettingsFile,
  mergeOverrides,
  mergeScopedOverrides,
  overrideFor,
  resolveEffective,
  applyPatch,
  withAgentOverride,
  describeOverride,
  renderPatchPreview,
  extractFrontmatterFields,
  buildShowView,
};
