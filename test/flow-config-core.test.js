'use strict';

// flow-config 核心逻辑自检：/matt-flow-config 的纯逻辑层（scripts/flow-config-core.js）。
// 注册不变量（pi.extensions / agent timeoutMs / gate verify anchor）在 self-check.test.js。
// 对包目录只读；「模拟破坏」只喂假想 fixture。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const {
  CLEAR,
  ROLES,
  THINKING_LEVELS,
  AGENT_TIMEOUT_MS,
  GATE_VERIFY_TIMEOUT_MS,
  RUN_TIMEOUT_KEY,
  MAX_TIMER_DELAY_MS,
  normalizeRunTimeoutMs,
  resolveRunTimeoutDetailed,
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
} = require('../scripts/flow-config-core.js');
const { PKG_ROOT, readText } = require('../scripts/registration-checks.js');

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
  assert.equal(AGENT_TIMEOUT_MS, 14400000);
  assert.equal(GATE_VERIFY_TIMEOUT_MS, 600000);
  assert.equal(MAX_TIMER_DELAY_MS, 2147483647);
  assert.deepEqual(THINKING_LEVELS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

// --- 运行时限（issue #26）：派发时新读的 agentTimeoutMs，不冻结进 init 旗标 ---

test('normalizeRunTimeoutMs mirrors the platform dispatch contract: positive integer, bounded by the Node timer ceiling', () => {
  assert.deepEqual(normalizeRunTimeoutMs(14400000), { ok: true, value: 14400000 });
  assert.deepEqual(normalizeRunTimeoutMs(1), { ok: true, value: 1 });
  assert.deepEqual(normalizeRunTimeoutMs(MAX_TIMER_DELAY_MS), { ok: true, value: MAX_TIMER_DELAY_MS });
  for (const raw of [0, -1, 2.5, '7200000', true, false, null, undefined, NaN, Infinity, MAX_TIMER_DELAY_MS + 1]) {
    const r = normalizeRunTimeoutMs(raw);
    assert.equal(r.ok, false, `must reject ${JSON.stringify(raw)}`);
    assert.match(r.error, /agentTimeoutMs/);
  }
  // 0 / false 不解释为无限时长
  assert.match(normalizeRunTimeoutMs(0).error, /never means "no deadline"/);
  // 超上限点名平台定时器天花板
  assert.match(normalizeRunTimeoutMs(MAX_TIMER_DELAY_MS + 1).error, /2147483647/);
});

test('resolveRunTimeoutDetailed: project wins user, default 4h fills the rest; invalid values never win', () => {
  const user = { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 7200000 } };
  const project = { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 3600000 } };
  assert.deepEqual(resolveRunTimeoutDetailed(user, project), { value: 3600000, source: 'project', invalid: [] });
  assert.deepEqual(resolveRunTimeoutDetailed(user, {}), { value: 7200000, source: 'user', invalid: [] });
  assert.deepEqual(resolveRunTimeoutDetailed(), { value: AGENT_TIMEOUT_MS, source: 'default', invalid: [] });
  // 手写非法值：忽略并记入 invalid，回退下一层 / 默认值（绝不变成无限时长）
  const brokenProject = { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 'abc' } };
  assert.deepEqual(resolveRunTimeoutDetailed(user, brokenProject), {
    value: 7200000,
    source: 'user',
    invalid: [{ scope: 'project', raw: 'abc' }],
  });
  const brokenBoth = { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 0 } };
  assert.deepEqual(resolveRunTimeoutDetailed(brokenBoth, brokenProject), {
    value: AGENT_TIMEOUT_MS,
    source: 'default',
    invalid: [{ scope: 'project', raw: 'abc' }, { scope: 'user', raw: 0 }],
  });
  // 与流程形态键互不干扰
  assert.deepEqual(
    resolveRunTimeoutDetailed({ [FLOW_SECTION]: { reviewer: false, maxConcurrent: 5 } }, {}),
    { value: AGENT_TIMEOUT_MS, source: 'default', invalid: [] },
  );
});

test('a saved change is what the NEXT resolution sees (A → B mid-run, no re-init)', () => {
  let settings = withFlowConfig({}, { [RUN_TIMEOUT_KEY]: 3600000 });
  assert.equal(resolveRunTimeoutDetailed({}, settings).value, 3600000);
  settings = withFlowConfig(settings, { [RUN_TIMEOUT_KEY]: 7200000 });
  assert.deepEqual(resolveRunTimeoutDetailed({}, settings), { value: 7200000, source: 'project', invalid: [] });
  // 清除覆盖 → 恢复默认（已更新的默认值）
  settings = withFlowConfig(settings, { [RUN_TIMEOUT_KEY]: CLEAR });
  assert.deepEqual(resolveRunTimeoutDetailed({}, settings), { value: AGENT_TIMEOUT_MS, source: 'default', invalid: [] });
});

test('buildShowView renders the run deadline with its source and flags ignored invalid values', () => {
  const view = buildShowView({
    frontmatterByRole: {},
    userSettings: { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 7200000 } },
    projectSettings: { [FLOW_SECTION]: { [RUN_TIMEOUT_KEY]: 'oops' } },
    userPath: '/u/settings.json',
    projectPath: '/p/.pi/settings.json',
  });
  assert.match(view, /agentTimeoutMs\s+7200000 ms \(120 min\) \[user\]\s+run deadline per new subagent dispatch/);
  assert.match(view, /ignoring invalid agentTimeoutMs in project settings \("oops"\)/);
  const defaultView = buildShowView({ frontmatterByRole: {}, userSettings: {}, projectSettings: {} });
  assert.match(defaultView, /agentTimeoutMs\s+14400000 ms \(240 min\) \[default\]/);
});

// --- 流程配置（settings 顶层自定义节） ---

test('flowSectionFor ignores historical fix limits while retaining reviewer and concurrency', () => {
  assert.deepEqual(
    flowSectionFor({ [FLOW_SECTION]: { reviewer: false, maxFixRounds: 3, maxConcurrent: 4 } }),
    { reviewer: false, maxConcurrent: 4 },
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
    { [FLOW_SECTION]: { reviewer: false, maxConcurrent: 4, maxFixRounds: 1 } },
    { [FLOW_SECTION]: { maxConcurrent: 5, maxFixRounds: 99 } },
  );
  assert.deepEqual(r.values, { reviewer: false, maxConcurrent: 5 });
  assert.deepEqual(r.sources, { reviewer: 'user', maxConcurrent: 'project' });
  assert.deepEqual(resolveFlowConfigDetailed().values, { reviewer: true, maxConcurrent: 3 });
  assert.deepEqual(FLOW_DEFAULTS, { reviewer: true, maxConcurrent: 3 });
  assert.deepEqual(resolveFlowConfigDetailed().sources, { reviewer: 'default', maxConcurrent: 'default' });
});

test('withFlowConfig creates/updates the section, CLEAR deletes, empty section collapses; input untouched', () => {
  const before = { subagents: {} };
  const next = withFlowConfig(before, { reviewer: false });
  assert.deepEqual(next[FLOW_SECTION], { reviewer: false });
  assert.deepEqual(before, { subagents: {} }, 'input must stay untouched');
  assert.deepEqual(
    withFlowConfig(next, { reviewer: CLEAR, maxConcurrent: 3 }),
    { subagents: {}, [FLOW_SECTION]: { maxConcurrent: 3 } },
  );
  assert.deepEqual(withFlowConfig({ [FLOW_SECTION]: { reviewer: true } }, { reviewer: CLEAR }), {});
  assert.deepEqual(
    withFlowConfig({ [FLOW_SECTION]: { reviewer: true, maxFixRounds: 2 } }, { reviewer: CLEAR }),
    { [FLOW_SECTION]: { maxFixRounds: 2 } },
    'clearing an active setting must not remove a historical key',
  );
});

test('buildShowView renders the Flow section with sources and hints, then agents as one line each', () => {
  const view = buildShowView({
    frontmatterByRole: { coder: { thinking: 'high', timeoutMs: '3600000' } },
    userSettings: {
      [FLOW_SECTION]: { reviewer: false, maxFixRounds: 1 },
      subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x' } } },
    },
    projectSettings: { [FLOW_SECTION]: { maxConcurrent: 4 } },
    userPath: '/u/settings.json',
    projectPath: '/p/.pi/settings.json',
    parentModel: 'p/parent-model',
  });
  assert.match(view, /reviewer\s+off\s+\[user\]\s+per-ticket two-axis review/);
  assert.doesNotMatch(view, /maxFixRounds|fix attempts per ticket|fix budget/);
  assert.match(view, /maxConcurrent\s+4\s+\[project\]\s+parallel coders/);
  assert.match(view, /Agents \(effective model \/ thinking\)/);
  assert.match(view, /model=a\/x \[settings override\]/);
  assert.match(view, /scope: project → \/p\/\.pi\/settings\.json · user → \/u\/settings\.json/);
});

// Load the unchanged extension with only its external pi SDK boundary stubbed.
// Exercise the registered command against real temporary settings files.
async function loadExtension(t, initialSettings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-config-ui-'));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const put = (relative, text) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  for (const [name, exports] of [
    ['pi-coding-agent', "export const CONFIG_DIR_NAME = '.pi';"],
    ['pi-tui', 'export class Box {} export class Text {}'],
  ]) {
    put(`node_modules/@earendil-works/${name}/package.json`, JSON.stringify({ type: 'module', exports: './index.js' }));
    put(`node_modules/@earendil-works/${name}/index.js`, exports);
  }
  put('scripts/flow-config-core.js', readText(PKG_ROOT, 'scripts/flow-config-core.js'));
  const extension = put('extensions/matt-flow-config.mjs', readText(PKG_ROOT, 'extensions/matt-flow-config.js'));
  put('.pi/.keep', ''); // 项目层 settings 的锚点：让 findProjectRoot 找到 <root>
  const settingsPath = put('user/settings.json', serializeSettings(initialSettings));
  process.env.PI_CODING_AGENT_DIR = path.dirname(settingsPath);
  let command;
  (await import(pathToFileURL(extension).href)).default({
    registerEntryRenderer() {},
    registerCommand(name, registered) {
      assert.equal(name, 'matt-flow-config');
      command = registered;
    },
  });
  return { root, command, settingsPath, projectSettingsPath: path.join(root, '.pi', 'settings.json') };
}

test('matt-flow-config UI offers reviewer, concurrency, and the run deadline, and preserves legacy settings on save', async (t) => {
  const { command, settingsPath } = await loadExtension(t, {
    [FLOW_SECTION]: { reviewer: false, maxFixRounds: 1, maxConcurrent: 3, futureKey: 'keep' },
    subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x', thinking: 'high' } } },
    unrelated: true,
  });
  const menus = [];
  const notifications = [];
  await command.handler('', {
    hasUI: true,
    cwd: path.dirname(settingsPath),
    ui: {
      async select(title, choices) {
        menus.push({ title, choices });
        if (title === 'matt-flow-config') return choices.find((s) => s.startsWith('Configure flow options'));
        if (title === 'Where should the override live?') return choices.find((s) => s.startsWith('user'));
        if (title === 'Which flow setting?') return choices.find((s) => s.startsWith('maxConcurrent'));
        return '4';
      },
      async confirm() { return true; },
      notify(message, level) { notifications.push({ message, level }); },
    },
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, 'info');
  const fields = menus.find((menu) => menu.title === 'Which flow setting?').choices;
  assert.equal(fields.length, 3);
  assert.match(fields[0], /^reviewer /);
  assert.match(fields[1], /^maxConcurrent /);
  assert.match(fields[2], /^agentTimeoutMs \(currently 14400000 ms \[default\]\)/);
  assert.doesNotMatch(JSON.stringify(menus), /maxFixRounds|fix budget|Fix attempts per ticket/);
  const saved = readSettingsFile(settingsPath);
  assert.deepEqual(saved, {
    [FLOW_SECTION]: { reviewer: false, maxFixRounds: 1, maxConcurrent: 4, futureKey: 'keep' },
    subagents: { agentOverrides: { [fullName('coder')]: { model: 'a/x', thinking: 'high' } } },
    unrelated: true,
  });
  assert.deepEqual(resolveFlowConfigDetailed(saved).values, { reviewer: false, maxConcurrent: 4 });
});

async function configureRunTimeout(t, initialSettings, { input, clear = false }) {
  const { command, projectSettingsPath } = await loadExtension(t, {});
  if (initialSettings) fs.writeFileSync(projectSettingsPath, serializeSettings(initialSettings));
  const notifications = [];
  await command.handler('', {
    hasUI: true,
    cwd: path.dirname(projectSettingsPath),
    ui: {
      async select(title, choices) {
        if (title === 'matt-flow-config') return choices.find((s) => s.startsWith('Configure flow options'));
        if (title === 'Where should the override live?') return choices.find((s) => s.startsWith('project'));
        if (title === 'Which flow setting?') return choices.find((s) => s.startsWith('agentTimeoutMs'));
        if (title === 'Run deadline for new subagent dispatches') {
          return choices[clear ? 1 : 0];
        }
        return null;
      },
      async input() { return input; },
      async confirm() { return true; },
      notify(message, level) { notifications.push({ message, level }); },
    },
  });
  return { notifications, saved: readSettingsFile(projectSettingsPath) };
}

test('run deadline wizard: minutes convert to milliseconds and save under mattImplementFlow.agentTimeoutMs', async (t) => {
  const { notifications, saved } = await configureRunTimeout(
    t,
    { unrelated: true },
    { input: '120' },
  );
  assert.deepEqual(saved, { [FLOW_SECTION]: { agentTimeoutMs: 7200000 }, unrelated: true });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, 'info');
  assert.match(notifications[0].message, /Effective on the NEXT new subagent dispatch/);
  assert.match(notifications[0].message, /running child keeps its deadline/);
  assert.deepEqual(resolveRunTimeoutDetailed({}, saved), { value: 7200000, source: 'project', invalid: [] });
  // 小数分钟只要换算成整毫秒就合法（浮点噪声归整，非整毫秒仍拒）
  const fractional = await configureRunTimeout(t, {}, { input: '1.1' });
  assert.deepEqual(fractional.saved, { [FLOW_SECTION]: { agentTimeoutMs: 66000 } });
});

test('run deadline wizard: invalid input is refused with a clear error and nothing is written (0/false ≠ infinite)', async (t) => {
  for (const input of ['0', '-30', 'abc', '2.333333', String(Math.ceil(MAX_TIMER_DELAY_MS / 60000))]) {
    const { notifications, saved } = await configureRunTimeout(t, { unrelated: true }, { input });
    assert.deepEqual(saved, { unrelated: true }, `input ${input} must not be written`);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, 'error');
    assert.match(notifications[0].message, /Not saved/);
  }
});

test('run deadline wizard: clear removes the override and the next resolution falls back to the 4h default', async (t) => {
  const { notifications, saved } = await configureRunTimeout(
    t,
    { [FLOW_SECTION]: { agentTimeoutMs: 7200000, maxConcurrent: 3 } },
    { clear: true },
  );
  assert.deepEqual(saved, { [FLOW_SECTION]: { maxConcurrent: 3 } });
  assert.equal(notifications[0].level, 'info');
  assert.match(notifications[0].message, /\(cleared\)/);
  assert.deepEqual(resolveRunTimeoutDetailed({}, saved), { value: AGENT_TIMEOUT_MS, source: 'default', invalid: [] });
});
