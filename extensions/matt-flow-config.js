// /matt-flow-config —— 无 LLM 配置向导（pi 扩展）。
// 为本包三个 agent（coder / reviewer / final-reviewer）配置 model / thinking
// 的 settings 覆盖（subagents.agentOverrides）。纯 ctx.ui 菜单流，不经过大模型。
//
// 生效语义（源码核实，见 docs/design/decisions.md D19）：pi-subagents 每次
// subagent 调用都重读 settings（discoverAgentsUncached）——写入后下一次派发
// 即生效，无需重启 pi；正在运行的 child 不受影响。
//
// 纯逻辑（合并/生效/IO）在 scripts/flow-config-core.js，由 npm test 守护。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { Box, Text } from '@earendil-works/pi-tui';
import flowConfig from '../scripts/flow-config-core.js';

const ENTRY_TYPE = 'matt-flow-config-view';

const { CLEAR, ROLES, THINKING_LEVELS, fullName } = flowConfig;

// --- IO（扩展侧薄封装；错误统一冒泡到命令 handler 的 notify） ---

function readSettings(filePath) {
  return flowConfig.readSettingsFile(filePath, {
    readFileSync: fs.readFileSync,
    existsSync: fs.existsSync,
  });
}

function writeSettings(filePath, settings) {
  flowConfig.writeSettingsFile(filePath, settings, {
    mkdirSync: fs.mkdirSync,
    writeFileSync: fs.writeFileSync,
  });
}

// --- UI 帮手 ---

function label(text, hint) {
  return hint ? `${text}   · ${hint}` : text;
}

const CLEAR_MODEL_LABEL = '⟲ clear — inherit (parent session / subagents.defaultModel)';
const CLEAR_THINKING_LABEL = '⟲ clear — package frontmatter default (remove the override)';
const MANUAL_MODEL_LABEL = '✎ type a provider/model id manually…';

function modelOptions(models, currentModel) {
  const options = [...models];
  if (currentModel && !options.includes(currentModel)) options.unshift(currentModel);
  return [CLEAR_MODEL_LABEL, ...options, MANUAL_MODEL_LABEL];
}

function thinkingOptions() {
  return [CLEAR_THINKING_LABEL, ...THINKING_LEVELS];
}

function scopeChoices(projectPath, userPath) {
  const choices = [];
  if (projectPath) choices.push({ value: 'project', label: label('project (wins over user)', projectPath) });
  choices.push({ value: 'user', label: label('user (all projects)', userPath) });
  return choices;
}

// ctx.ui.select 只收字符串数组；约定 `value——hint` 形式后自行拆分。
function toMenu(choices) {
  return choices.map((choice) => (typeof choice === 'string' ? choice : choice.label));
}
function fromMenu(choices, picked) {
  const match = choices.find((choice) => (typeof choice === 'string' ? choice : choice.label) === picked);
  return match && typeof match !== 'string' ? match.value : picked;
}

// --- 向导 ---

async function pickRole(ctx) {
  const picked = await ctx.ui.select('Which agent role?', ROLES);
  return picked ?? null;
}

async function pickScope(ctx, projectPath, userPath) {
  const choices = scopeChoices(projectPath, userPath);
  const picked = await ctx.ui.select('Where should the override live?', toMenu(choices));
  if (!picked) return null;
  return fromMenu(choices, picked);
}

async function runShow(pi, ctx, paths) {
  const frontmatterByRole = {};
  for (const role of ROLES) {
    frontmatterByRole[role] = readFrontmatter(paths.packageRoot, role);
  }
  const userSettings = readSettings(paths.user);
  const projectSettings = paths.project ? readSettings(paths.project) : {};
  const parent = ctx.model;
  const view = flowConfig.buildShowView({
    frontmatterByRole,
    userSettings,
    projectSettings,
    userPath: paths.user,
    projectPath: paths.project ?? null,
    parentModel: parent ? `${parent.provider}/${parent.id}` : null,
  });
  pi.appendEntry(ENTRY_TYPE, { text: view });
}

async function runConfigure(ctx, paths) {
  const role = await pickRole(ctx);
  if (!role) return;
  const scope = await pickScope(ctx, paths.project, paths.user);
  if (!scope) return;
  const scopePath = scope === 'project' ? paths.project : paths.user;
  const otherPath = scope === 'project' ? paths.user : paths.project;
  const settings = readSettings(scopePath);
  const otherSettings = otherPath ? readSettings(otherPath) : {};
  const currentOverride = flowConfig.overrideFor(settings, role);
  const otherOverride = flowConfig.overrideFor(otherSettings, role);

  const field = await ctx.ui.select(`What to configure on ${fullName(role)}?`, ['model', 'thinking', 'both']);
  if (!field) return;

  const patch = {};
  if (field === 'model' || field === 'both') {
    const models = collectModels(ctx);
    const picked = await ctx.ui.select(`Model for ${fullName(role)}`, modelOptions(models, currentOverride?.model));
    if (!picked) return;
    if (picked === MANUAL_MODEL_LABEL) {
      const manual = await ctx.ui.input('Model id (provider/model, e.g. anthropic/claude-sonnet-4):', currentOverride?.model ?? '');
      if (manual === undefined) return;
      if (manual.trim()) patch.model = manual.trim();
      else patch.model = CLEAR;
    } else if (picked === CLEAR_MODEL_LABEL) {
      patch.model = CLEAR;
    } else {
      patch.model = picked;
    }
  }
  if (field === 'thinking' || field === 'both') {
    const picked = await ctx.ui.select(`Thinking level for ${fullName(role)}`, thinkingOptions());
    if (!picked) return;
    patch.thinking = picked === CLEAR_THINKING_LABEL ? CLEAR : picked;
  }
  if (Object.keys(patch).length === 0) return;

  const nextSettings = flowConfig.withAgentOverride(settings, role, patch);
  const beforeEffective = flowConfig.resolveEffective(
    readFrontmatter(paths.packageRoot, role),
    flowConfig.mergeScopedOverrides({ scope, scopedOverride: currentOverride, otherOverride }),
  );
  const afterOverride = flowConfig.overrideFor(nextSettings, role);
  const afterEffective = flowConfig.resolveEffective(
    readFrontmatter(paths.packageRoot, role),
    flowConfig.mergeScopedOverrides({ scope, scopedOverride: afterOverride, otherOverride }),
  );

  const preview = [
    `Write to: ${scopePath}`,
    '',
    flowConfig.renderPatchPreview(patch, { role, scopeLabel: scope }),
    '',
    `effective model   : ${beforeEffective.model.value ?? '(inherit)'} → ${afterEffective.model.value ?? '(inherit)'}`,
    `effective thinking: ${beforeEffective.thinking.value ?? '(default)'} → ${afterEffective.thinking.value ?? '(default)'}`,
  ];
  if (scope === 'user' && otherOverride && Object.keys(otherOverride).length > 0) {
    preview.push('');
    preview.push(`⚠ a project override exists (${otherPath}) and wins per-field — this user-level write may not change the effective values.`);
  }

  const ok = await ctx.ui.confirm('Apply configuration?', preview.join('\n'));
  if (!ok) return;
  writeSettings(scopePath, nextSettings);
  ctx.ui.notify(
    `Saved ${fullName(role)} → ${scopePath}. Effective on the NEXT dispatch; running children keep their current model (no restart needed).`,
    'info',
  );
}

async function runClear(ctx, paths) {
  const role = await pickRole(ctx);
  if (!role) return;
  const scope = await pickScope(ctx, paths.project, paths.user);
  if (!scope) return;
  const scopePath = scope === 'project' ? paths.project : paths.user;
  const settings = readSettings(scopePath);
  const currentOverride = flowConfig.overrideFor(settings, role);
  if (!currentOverride) {
    ctx.ui.notify(`No ${scope}-level override for ${fullName(role)} — nothing to clear.`, 'info');
    return;
  }
  const preview = [
    `Write to: ${scopePath}`,
    '',
    `remove ${fullName(role)} override entirely:`,
    `  ${flowConfig.describeOverride(currentOverride)}`,
    '',
    'the agent falls back to its package frontmatter defaults.',
  ];
  const ok = await ctx.ui.confirm('Clear override?', preview.join('\n'));
  if (!ok) return;
  writeSettings(scopePath, flowConfig.withAgentOverride(settings, role, null));
  ctx.ui.notify(`Cleared ${fullName(role)} override in ${scopePath}. Effective on the NEXT dispatch.`, 'info');
}

// --- 模型清单（会话可用模型优先，目录兜底；全部失败则只剩手动输入） ---

function collectModels(ctx) {
  try {
    const scoped = ctx.scopedModels;
    if (Array.isArray(scoped) && scoped.length > 0) {
      return scoped.map((entry) => `${entry.model.provider}/${entry.model.id}`);
    }
  } catch {
    // fall through to the registry
  }
  try {
    const available = ctx.modelRegistry?.getAvailable?.();
    if (Array.isArray(available)) return available.map((model) => `${model.provider}/${model.id}`);
  } catch {
    // fall through to manual entry
  }
  return [];
}

function readFrontmatter(packageRoot, role) {
  try {
    const text = fs.readFileSync(path.join(packageRoot, 'agents', `${role}.md`), 'utf8');
    return flowConfig.extractFrontmatterFields(text);
  } catch {
    return {};
  }
}

// --- 入口 ---

export default function (pi) {
  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data ?? {};
    const box = new Box(1, 1, (text) => theme.bg('customMessageBg', text));
    for (const line of String(data.text ?? '').split('\n')) {
      box.addChild(new Text(line, 0, 0));
    }
    return box;
  });

  pi.registerCommand('matt-flow-config', {
    description: 'Configure model/thinking overrides for pi-matt-implement-flow agents (no LLM)',
    getArgumentCompletions: (prefix) => {
      const items = ['show'].filter((item) => item.startsWith(prefix ?? ''));
      return items.length > 0 ? items.map((item) => ({ value: item, label: item })) : null;
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const userPath = flowConfig.userSettingsPath(process.env, os.homedir(), CONFIG_DIR_NAME);
      const projectPath = flowConfig.projectSettingsPath(ctx.cwd, {
        configDirName: CONFIG_DIR_NAME,
        homeDir: os.homedir(),
      });
      const paths = { packageRoot, user: userPath, project: projectPath };

      try {
        const arg = typeof args === 'string' ? args.trim() : '';
        if (arg === 'show') await runShow(pi, ctx, paths);
        else {
          const action = await ctx.ui.select('matt-flow-config', [
            'Configure a role (model / thinking)',
            'Show current effective configuration',
            "Clear a role's overrides",
          ]);
          if (action === 'Configure a role (model / thinking)') await runConfigure(ctx, paths);
          else if (action === 'Show current effective configuration') await runShow(pi, ctx, paths);
          else if (action === "Clear a role's overrides") await runClear(ctx, paths);
        }
      } catch (error) {
        ctx.ui.notify(`matt-flow-config failed: ${error?.message ?? String(error)}`, 'error');
      }
    },
  });
}
