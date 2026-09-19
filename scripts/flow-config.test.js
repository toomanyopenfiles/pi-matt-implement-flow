'use strict';

// flow-config 核心逻辑自检：/matt-flow-config 的纯逻辑层（scripts/flow-config-core.js）。
// 注册不变量（pi.extensions / agent timeoutMs / gate verify anchor）在 self-check.test.js。
// 对包目录只读；「模拟破坏」只喂假想 fixture。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  CLEAR,
  ROLES,
  THINKING_LEVELS,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  fullName,
  resolveAgentDir,
  userSettingsPath,
  findProjectRoot,
  projectSettingsPath,
  readSettingsFile,
  serializeSettings,
  mergeOverrides,
  mergeScopedOverrides,
  overrideFor,
  resolveEffective,
  applyPatch,
  withAgentOverride,
  withFlowConfig,
  flowSectionFor,
  resolveFlowConfigDetailed,
  FLOW_SECTION,
  FLOW_DEFAULTS,
  renderPatchPreview,
  extractFrontmatterFields,
  buildShowView,
} = require('./flow-config-core.js');
const { PKG_ROOT, readText } = require('./registration-checks.js');

// --- 路径解析 ---

test('resolveAgentDir mirrors getAgentDir: default, PI_CODING_AGENT_DIR, "~", "~/sub"', () => {
  assert.equal(resolveAgentDir({}, '/home/u', '.pi'), path.join('/home/u', '.pi', 'agent'));
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '/custom/dir' }, '/home/u', '.pi'), '/custom/dir');
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '~' }, '/home/u', '.pi'), '/home/u');
  assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: '~/sub' }, '/home/u', '.pi'), path.join('/home/u', 'sub'));
  assert.equal(
    userSettingsPath({ PI_CODING_AGENT_DIR: '/custom/dir' }, '/home/u', '.pi'),
    path.join('/custom/dir', 'settings.json'),
  );
});

test('findProjectRoot: nearest ancestor with .pi or .agents wins; home never counts', () => {
  const dirs = new Set(['/proj', '/proj/.pi', '/proj/deep', '/proj/deep/other/.agents']);
  const isDir = dirs.has.bind(dirs);
  assert.equal(findProjectRoot('/proj/deep/other', { configDirName: '.pi', homeDir: '/home/u', isDir }), '/proj/deep/other');
  assert.equal(findProjectRoot('/proj/deep', { configDirName: '.pi', homeDir: '/home/u', isDir }), '/proj');
  assert.equal(findProjectRoot('/proj', { configDirName: '.pi', homeDir: '/home/u', isDir }), '/proj');
  assert.equal(projectSettingsPath('/proj/deep', { configDirName: '.pi', homeDir: '/home/u', isDir }), path.join('/proj', '.pi', 'settings.json'));
  assert.equal(projectSettingsPath('/proj/deep/other', { configDirName: '.pi', homeDir: '/home/u', isDir }), path.join('/proj/deep/other', '.pi', 'settings.json'));
});

test('findProjectRoot: no candidate → null; cwd inside home with its own .pi still counts', () => {
  const isDir = () => false;
  assert.equal(findProjectRoot('/somewhere', { configDirName: '.pi', homeDir: '/home/u', isDir }), null);
  const homeWorkDirs = new Set(['/home/u/work/.pi']);
  assert.equal(
    findProjectRoot('/home/u/work', { configDirName: '.pi', homeDir: '/home/u', isDir: homeWorkDirs.has.bind(homeWorkDirs) }),
    '/home/u/work',
  );
});

test('findProjectRoot: projectRootResolution "nearest" short-circuits, "git-root" jumps to the git root candidate', () => {
  const dirs = new Set(['/repo', '/repo/.pi', '/repo/sub/pkg/.pi']);
  const isDir = dirs.has.bind(dirs);
  const base = { configDirName: '.pi', homeDir: '/home/u', isDir };
  const gitRoot = () => '/repo';

  // 无策略 → nearest
  assert.equal(findProjectRoot('/repo/sub/pkg', { ...base, findGitRoot: gitRoot }), '/repo/sub/pkg');

  // nearest 声明在最近候选 → 即便有 git 根也取 nearest
  const nearestPolicy = (p) => (p === '/repo/sub/pkg/.pi/settings.json' ? { subagents: { projectRootResolution: 'nearest' } } : {});
  assert.equal(findProjectRoot('/repo/sub/pkg', { ...base, readSettings: nearestPolicy, findGitRoot: gitRoot }), '/repo/sub/pkg');

  // git-root 声明 → 取 git 根候选（平台语义：配置锚定仓库根）
  const gitPolicy = (p) => (p === '/repo/sub/pkg/.pi/settings.json' ? { subagents: { projectRootResolution: 'git-root' } } : {});
  assert.equal(findProjectRoot('/repo/sub/pkg', { ...base, readSettings: gitPolicy, findGitRoot: gitRoot }), '/repo');

  // git-root 声明但 git 根不是候选 → 退回 nearest（平台同义）
  assert.equal(findProjectRoot('/repo/sub/pkg', { ...base, readSettings: gitPolicy, findGitRoot: () => '/elsewhere' }), '/repo/sub/pkg');

  // git-root 声明、无 git 根，但策略根本身含 .git → 策略根
  const policyDirs = new Set(['/repo/sub/.pi', '/repo/sub/pkg/.pi']);
  assert.equal(
    findProjectRoot('/repo/sub/pkg', {
      configDirName: '.pi',
      homeDir: '/home/u',
      isDir: policyDirs.has.bind(policyDirs),
      readSettings: (p) => (p === '/repo/sub/.pi/settings.json' ? { subagents: { projectRootResolution: 'git-root' } } : {}),
      findGitRoot: () => null,
      exists: (p) => p === '/repo/sub/.git',
    }),
    '/repo/sub',
  );
});

// --- 覆盖合并与生效解析 ---

test('mergeOverrides: project fields win per-field; user-only fields survive', () => {
  const merged = mergeOverrides({ model: 'a/x', thinking: 'high' }, { model: 'b/y' });
  assert.deepEqual(merged, { model: 'b/y', thinking: 'high' });
  assert.deepEqual(mergeOverrides(undefined, { model: 'b/y' }), { model: 'b/y' });
  assert.deepEqual(mergeOverrides({ model: 'a/x' }, undefined), { model: 'a/x' });
});

test('mergeScopedOverrides: the edited scope is named, project still beats user regardless of position', () => {
  const userOv = { model: 'user/model', thinking: 'high' };
  const projectOv = { model: 'project/model' };
  // 编辑 project 层：project 字段赢，user 独有字段保留
  assert.deepEqual(
    mergeScopedOverrides({ scope: 'project', scopedOverride: projectOv, otherOverride: userOv }),
    { model: 'project/model', thinking: 'high' },
  );
  // 编辑 user 层：project 仍然是最终赢家
  assert.deepEqual(
    mergeScopedOverrides({ scope: 'user', scopedOverride: userOv, otherOverride: projectOv }),
    { model: 'project/model', thinking: 'high' },
  );
  // 另一层不存在
  assert.deepEqual(mergeScopedOverrides({ scope: 'user', scopedOverride: userOv, otherOverride: undefined }), userOv);
});

test('regression (round-2 review P1): the confirm preview must not let the non-edited layer win', () => {
  // 场景：user 已有 model=a/x，本次在 project 层写 model=b/y —— 生效值必须是 b/y
  const projectEdit = resolveEffective(
    {},
    mergeScopedOverrides({ scope: 'project', scopedOverride: { model: 'b/y' }, otherOverride: { model: 'a/x' } }),
  );
  assert.equal(projectEdit.model.value, 'b/y');
  // 反向：在 user 层写 c/z，project 层的 b/y 仍然赢
  const userEdit = resolveEffective(
    {},
    mergeScopedOverrides({ scope: 'user', scopedOverride: { model: 'c/z' }, otherOverride: { model: 'b/y' } }),
  );
  assert.equal(userEdit.model.value, 'b/y');
});

test('resolveEffective: override > frontmatter > inherit; false means explicitly cleared', () => {
  assert.deepEqual(resolveEffective({ thinking: 'high' }, { model: 'b/y' }).model, { value: 'b/y', source: 'settings override' });
  assert.deepEqual(resolveEffective({ thinking: 'high' }, {}).thinking, { value: 'high', source: 'package frontmatter' });
  assert.deepEqual(resolveEffective({}, {}).model, { value: null, source: 'inherit (parent session / subagents.defaultModel)' });
  assert.equal(resolveEffective({ thinking: 'max' }, { thinking: false }).thinking.value, null);
  assert.equal(resolveEffective({}, { model: false }).model.source, 'cleared (inherit)');
});

test('overrideFor reads subagents.agentOverrides by full runtime name', () => {
  const settings = { subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x' } } } };
  assert.deepEqual(overrideFor(settings, 'coder'), { model: 'a/x' });
  assert.equal(overrideFor(settings, 'reviewer'), undefined);
  assert.equal(overrideFor({}, 'coder'), undefined);
});

// --- 补丁与 settings 写换（纯函数，不改入参） ---

test('applyPatch: set, CLEAR deletes, empty result collapses to undefined', () => {
  assert.deepEqual(applyPatch({ model: 'a/x' }, { model: 'b/y' }), { model: 'b/y' });
  assert.deepEqual(applyPatch({ model: 'a/x', thinking: 'high' }, { model: CLEAR }), { thinking: 'high' });
  assert.equal(applyPatch({ model: 'a/x' }, { model: CLEAR }), undefined);
  assert.equal(applyPatch(undefined, { model: CLEAR }), undefined);
});

test('withAgentOverride creates subagents/agentOverrides on demand and does not mutate its input', () => {
  const before = { defaultProvider: 'x' };
  const next = withAgentOverride(before, 'coder', { model: 'a/x' });
  assert.deepEqual(next.subagents.agentOverrides[fullName('coder')], { model: 'a/x' });
  assert.deepEqual(before, { defaultProvider: 'x' }, 'input must stay untouched');
});

test('withAgentOverride null patch removes the whole override; sibling agents and settings survive', () => {
  const settings = {
    subagents: {
      projectRootResolution: 'git-root',
      agentOverrides: {
        [fullName('coder')]: { model: 'a/x' },
        [fullName('reviewer')]: { thinking: 'max' },
      },
    },
  };
  const next = withAgentOverride(settings, 'coder', null);
  assert.equal(next.subagents.agentOverrides[fullName('coder')], undefined);
  assert.deepEqual(next.subagents.agentOverrides[fullName('reviewer')], { thinking: 'max' });
  assert.equal(next.subagents.projectRootResolution, 'git-root');
});

test('withAgentOverride drops an emptied agentOverrides object but keeps unrelated subagents keys', () => {
  const settings = { subagents: { agentScanDirs: ['/x'], agentOverrides: { [fullName('coder')]: { model: 'a/x' } } } };
  const next = withAgentOverride(settings, 'coder', { model: CLEAR });
  assert.equal(next.subagents.agentOverrides, undefined);
  assert.deepEqual(next.subagents.agentScanDirs, ['/x']);
});

test('withAgentOverride patch=null on a missing override is a no-op', () => {
  const next = withAgentOverride({}, 'coder', null);
  assert.deepEqual(next, {});
});

test('readSettingsFile: missing file → {}, broken JSON → friendly error, non-object → {}', () => {
  assert.deepEqual(readSettingsFile(null), {});
  assert.deepEqual(readSettingsFile('/missing.json', { existsSync: () => false }), {});
  assert.throws(
    () => readSettingsFile('/broken.json', { existsSync: () => true, readFileSync: () => '{oops' }),
    /not valid JSON: \/broken\.json — fix it by hand first/,
  );
  assert.deepEqual(
    readSettingsFile('/arr.json', { existsSync: () => true, readFileSync: () => '[1,2]' }),
    {},
  );
});

test('serializeSettings matches the platform write format (2-space indent, trailing newline)', () => {
  assert.equal(serializeSettings({ a: 1 }), '{\n  "a": 1\n}\n');
});

// --- 展示 ---

test('renderPatchPreview lists removals and additions per field', () => {
  const preview = renderPatchPreview({ model: 'a/x', thinking: CLEAR }, { role: 'coder', scopeLabel: 'user' });
  assert.match(preview, /\[user\] pi-matt-implement-flow\.coder/);
  assert.match(preview, /model: "a\/x"/);
  assert.match(preview, /thinking: \(removed/);
});

test('extractFrontmatterFields reads model/thinking/timeoutMs from real agent files', () => {
  const coder = extractFrontmatterFields(readText(PKG_ROOT, 'agents/coder.md'));
  assert.equal(coder.thinking, 'max');
  assert.equal(coder.timeoutMs, String(AGENT_TIMEOUT_MS));
  assert.equal(coder.model, undefined);
});

test('buildShowView renders all three roles, their effective values, and the inherit target', () => {
  const view = buildShowView({
    frontmatterByRole: { coder: { thinking: 'high', timeoutMs: '3600000' } },
    userSettings: { subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x' } } } },
    projectSettings: {},
    userPath: '/u/settings.json',
    projectPath: null,
    parentModel: 'p/parent-model',
  });
  for (const role of ROLES) assert.match(view, new RegExp(fullName(role)));
  assert.match(view, /model=a\/x \[settings override\]/);
  assert.match(view, /parent session model \(inherit target\): p\/parent-model/);
});

test('constants: the documented timeout contract values', () => {
  assert.equal(AGENT_TIMEOUT_MS, 3600000);
  assert.equal(GATE_VERIFY_TIMEOUT_MS, 600000);
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

// --- 流程配置（settings 顶层自定义节） ---

test('flowSectionFor normalizes one layer: boolean reviewer, >=1 integer budgets, junk ignored', () => {
  assert.deepEqual(
    flowSectionFor({ [FLOW_SECTION]: { reviewer: false, maxFixRounds: 3, maxConcurrent: 4 } }),
    { reviewer: false, maxFixRounds: 3, maxConcurrent: 4 },
  );
  assert.deepEqual(
    flowSectionFor({ [FLOW_SECTION]: { reviewer: 'yes', maxFixRounds: 0, maxConcurrent: 2.5, bogus: 1 } }),
    {},
  );
  assert.deepEqual(flowSectionFor({ [FLOW_SECTION]: 'on' }), {});
  assert.deepEqual(flowSectionFor({}), {});
});

test('resolveFlowConfigDetailed: project wins per field, user-only survives, defaults fill the rest', () => {
  const r = resolveFlowConfigDetailed(
    { [FLOW_SECTION]: { reviewer: false, maxConcurrent: 4 } },
    { [FLOW_SECTION]: { maxConcurrent: 5 } },
  );
  assert.deepEqual(r.values, { reviewer: false, maxFixRounds: 2, maxConcurrent: 5 });
  assert.deepEqual(r.sources, { reviewer: 'user', maxFixRounds: 'default', maxConcurrent: 'project' });
  assert.deepEqual(resolveFlowConfigDetailed().values, FLOW_DEFAULTS);
  assert.deepEqual(resolveFlowConfigDetailed().sources, { reviewer: 'default', maxFixRounds: 'default', maxConcurrent: 'default' });
});

test('withFlowConfig creates/updates the section, CLEAR deletes, empty section collapses; input untouched', () => {
  const before = { subagents: {} };
  const next = withFlowConfig(before, { reviewer: false });
  assert.deepEqual(next[FLOW_SECTION], { reviewer: false });
  assert.deepEqual(before, { subagents: {} }, 'input must stay untouched');
  assert.deepEqual(
    withFlowConfig(next, { reviewer: CLEAR, maxFixRounds: 3 }),
    { subagents: {}, [FLOW_SECTION]: { maxFixRounds: 3 } },
  );
  assert.deepEqual(withFlowConfig({ [FLOW_SECTION]: { reviewer: true } }, { reviewer: CLEAR }), {});
});

test('buildShowView renders the Flow section with sources and hints, then agents as one line each', () => {
  const view = buildShowView({
    frontmatterByRole: { coder: { thinking: 'high', timeoutMs: '3600000' } },
    userSettings: {
      [FLOW_SECTION]: { reviewer: false },
      subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x' } } },
    },
    projectSettings: { [FLOW_SECTION]: { maxConcurrent: 4 } },
    userPath: '/u/settings.json',
    projectPath: '/p/.pi/settings.json',
    parentModel: 'p/parent-model',
  });
  assert.match(view, /reviewer\s+off\s+\[user\]\s+per-ticket two-axis review/);
  assert.match(view, /maxFixRounds\s+2\s+\[default\]\s+fix attempts per ticket/);
  assert.match(view, /maxConcurrent\s+4\s+\[project\]\s+parallel coders/);
  assert.match(view, /Agents \(effective model \/ thinking\)/);
  assert.match(view, /model=a\/x \[settings override\]/);
  assert.match(view, /scope: project → \/p\/\.pi\/settings\.json · user → \/u\/settings\.json/);
});
