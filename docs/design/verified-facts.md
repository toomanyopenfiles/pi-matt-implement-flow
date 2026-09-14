# 已查证事实

> 每一条都带出处。**不要重复查证**——除非怀疑版本已变。查证日期 2026-09-15。

## 版本基线

| 组件 | 版本 / 路径 |
|---|---|
| pi-coding-agent | `/Users/gaosong/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/`（docs 目录下有 34 个文件） |
| pi-subagents | `0.67.0` @ `/Users/gaosong/.pi/agent/npm/node_modules/pi-subagents/` |
| pi 用户配置目录 | `~/.pi/agent/`（已有 `agents/` `skills/` `extensions/` `npm/` `missions/`） |
| **git** | **2.39.5 (Apple Git-154)** ← ⚠️ 直接影响 pi 的 patch 捕获，见 §10.9 |

---

## 1. pi 的 skill 机制

**出处**：`docs/skills.md`

### 发现位置

```
全局：~/.pi/agent/skills/  、  ~/.agents/skills/
项目：.pi/skills/  、  .agents/skills/（cwd 及祖先目录，到 git root 为止）
包：  package.json 的 pi.skills  、  约定目录 skills/
设置：settings.json 的 skills 数组
CLI： --skill <path>
```

### 关键发现规则（原文要点）

- 「In `~/.pi/agent/skills/` and `.pi/skills/`, **direct root `.md` files** are discovered as individual skills when they have valid skill frontmatter with a non-empty `description`」← 根级 `.md` 也能当 skill
- 「In all skill locations, **directories containing `SKILL.md`** are discovered recursively」
- 「Root Markdown files other than `SKILL.md` that do not look like skills are ignored silently」

### Frontmatter 字段（全部）

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | ≤64 字符，小写 a-z/0-9/连字符。**pi 不要求与父目录同名** |
| `description` | 是 | ≤1024 字符 |
| `license` | 否 | |
| `compatibility` | 否 | ≤500 字符 |
| `metadata` | 否 | 任意键值 |
| `allowed-tools` | 否 | 空格分隔的预批准工具（实验性） |
| `disable-model-invocation` | 否 | `true` 则从 system prompt 隐藏，用户须用 `/skill:name` |

**未知字段被忽略**（不报错）→ 所以 `argument-hint`、`agents/openai.yaml` 这类 Claude Code/Codex 资产是无害的。

### 调用

```
/skill:brave-search           # 加载并执行
/skill:pdf-tools extract      # 带参数
```

「Arguments after the command are appended to the skill content as `User: <args>`」

### 从其他 harness 借用 skill

```json
{ "skills": ["~/.claude/skills", "~/.codex/skills"] }
```

---

## 2. pi 的 package 机制

**出处**：`docs/packages.md`

### 约定目录（无 `pi` manifest 时自动发现）

```
extensions/  → .ts 和 .js 文件
skills/      → 递归找 SKILL.md 文件夹，并加载顶层 .md 作为 skill
prompts/     → .md 文件
themes/      → .json 文件
```

**`agents/` 不在其中** ← 这是本项目需要单独声明 agent 目录的原因（D11 选 `pi.subagents.agents` manifest 字段，备选 `agentScanDirs`）。

### `pi` manifest

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

「Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.」

### 安装

```bash
pi install npm:@foo/bar@1.0.0
pi install git:github.com/user/repo@v1
pi install /absolute/path/to/package
pi install ./relative/path/to/package
pi -e npm:@foo/bar      # 临时试用，不写入设置
```

用户安装落到 `~/.pi/agent/npm/` 或 `~/.pi/agent/git/<host>/<path>`。本地路径**加进 settings 但不复制**。

### 过滤与开关

```json
{
  "packages": [
    { "source": "npm:my-package", "skills": [], "extensions": ["extensions/*.ts"] }
  ]
}
```

`pi config`（Tab 切全局/项目）可启用/禁用包里的资源。

---

## 3. pi-subagents 的 worktree 机制

### 3.1 生命周期

**出处**：`docs/workflows.md:383`

> Each child uses the existing worktree lifecycle: it **branches from clean HEAD**, **journals ownership before launch**, **captures a patch and handoff manifest**, then **removes cleanly captured temporary worktrees and branches**. The handoff manifest path remains available in the child's `artifactPaths`.

### 3.2 patch 的真实格式（**源码实测**）

**出处**：`src/runs/shared/worktree.ts:1098-1100`、`:1457`

```ts
const patch = runGitChecked(worktree.path, ["diff", "--cached", ...MACHINE_PATCH_OPTIONS, setup.baseCommit]);
// MACHINE_PATCH_OPTIONS = [...MACHINE_DIFF_OPTIONS, "--binary"]
// patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`)
```

**结论**：
- 命令是 `git diff --cached --binary <baseCommit>`
- `--cached` → **只捕获已暂存的改动**，coder 必须 `git add` 或 `git commit`，否则 patch 为空
- `--binary` → 二进制文件也能捕获
- **是 `git diff` 格式，不是 `format-patch` 邮箱格式** → 不能 `git am`，**commit message 与提交序列丢失**

**验证方式**：`PATCH_VALIDATION_OPTIONS = ["apply", "--check", "--cached", "--reverse", "--binary", "--whitespace=nowarn"]`（同文件 `:25`）→ patch 可用 `git apply`。

### 3.3 baseRef 默认值

**出处**：`docs/tool-reference.md:115`

> `baseRef` | string | `HEAD` | `HEAD` or a supported named ref such as `refs/heads/release`… omitted values default to `HEAD` **resolved at that time**.

→ **pi 默认就从 HEAD 分配**，所以 B 的 `worktree.baseRef=head` precondition 在 pi 里不需要。

### 3.4 源干净性检查

**出处**：`docs/workflows.md:387`

> Before a materialized `runs.run` or `runs.all` group dispatches fresh children, isolated sources must be **Git repositories with clean working trees** (excluding `.pi/subagents/` runtime state). A rejected group **dispatches no children and spends no fan-out slots**.

### 3.5 配置项

**出处**：`docs/configuration.md:423-466`

| 键 | 作用 |
|---|---|
| `worktreeBaseDir` | 专用根目录。默认 `{dirname(repoRoot)}/worktrees`。叶子是 `{dedicatedRoot}/{projectName}/pi-worktree-{runId}-{index}` |
| `worktreeProvider` | `auto`（默认，优先 Worktrunk）/ `native` / `worktrunk` |
| `worktreeBranchPrefix` | 默认 `pi-subagents/` |
| `worktree` | 设 `true` 让所有未显式指定的 launch 默认隔离 |
| `worktreeSetupHook` | 每个新 worktree 跑一次。stdin 收 `{repoRoot, worktreePath, agentCwd, branch, index, runId, baseCommit}`，stdout 须为 JSON。可用 `syntheticPaths`（相对 worktree 根）排除辅助文件，**在 diff 捕获前移除**。tracked 文件永不排除 |

### 3.6 handoff manifest 与清理规则

**出处**：`docs/workflows.md:408`（表格）、`docs/tool-reference.md:273-305`

`handoffs/<run-id>.json` 字段作用：
- 组状态 `partial`（有 pending/running 任务）/ `finalized`
- 清理状态 `partial` / `complete`
- 含 child identity、patch、cleanup evidence、`baseCommit`

**清除授权**：「the **handoff manifest remains the deletion authority**」

**释放 worktree/分支的唯一条件**：「Only the existing cleanup engine's **fresh Git checks** and **recorded task evidence** can release a worktree/branch」

**失败关闭**（保留下来的情形）：

| 情形 | 行为 |
|---|---|
| manifest 缺失 / 无效 / run-key-task 身份不匹配 / 身份重复 | 保留 |
| dirty 或未捕获的工作 | 保留 |
| 只有 `worktreePath` 或只有 `branch`（信息不完整） | 保留 |
| 进程状态未验证 | 保留 |
| `baseCommit` 相关的 head 变了 | unknown / 保留，等显式重新核对 |
| 缺 lane / receipt / handoff 元数据 | 「**unknown—not eligible for destructive cleanup**」 |

### 3.7 worktree 相关 action

**出处**：`docs/tool-reference.md:100-104, 114-115`

- `action: "worktree.cleanup"` + `repo` + `handoffPath` → **plan-only**（`mode: plan` only；「Apply/removal is reserved for a later change」）
- `action: "worktree.discard"` + `handoffPath` → 配置项 `discardWorktree: "confirm"`

### 3.8 lane 元数据与证据状态机

**出处**：`docs/workflows.md:395-422`、`docs/tool-reference.md:273-305`

lane 对象字段（都是**咨询性**的）：

| 字段 | 说明 |
|---|---|
| `version` | 必须为 1 |
| `key` | **必须与 `runs.run` 的 key 一致** |
| `mode` | `mutation` / `review` / `scout` / `gate` |
| `sourceRef` | 不透明，**从不联网解析** |
| `claims` | 咨询性，≤20 条，每条 ≤160 字符 |
| `outputPaths` | 咨询性，≤10 条 |

> 原文：「These fields are **display and triage hints only**: they do not grant tools, authorization, or cleanup permission.」

**`lane.recordMerge` 要求的完整证据**（`docs/tool-reference.md:105`）：

```ts
merge: {
  prNumber: 123,                 // 正整数
  reviewedHead: "<40-char-sha>",
  mergeCommit: "<40-char-sha>",
  treeEquivalent: true,
  postMergeChecks: "recorded",
  attestedBy: "operator",
  attestedAt: "<ISO timestamp>"
}
```

**状态机**（`docs/tool-reference.md:303`）：

| 状态 | 含义 |
|---|---|
| `active` | 还有 owning child 在跑 |
| `terminal-eligible` | 有完整 merge 证据 **且**合并后检查已记录 |
| `terminal-blocked` | 带原因 |
| `superseded-eligible` | 显式替换认证 |
| `unknown` | 证据/manifest 缺失或损坏 |

**陈旧检测**（原文）：
> Each attestation stores a **digest of the manifest facts it covered**; later group, worktree, or patch changes **downgrade that evidence to `terminal-blocked`** until it is recorded again. Conflicting reviewed heads and mismatched lane ids are **rejected as stale**.

→ 这意味着 lane 追踪**不是白拿**：证据要你提供，它负责登记 + 一致性校验。且 schema 要求 `prNumber` + `mergeCommit`，说明它是为「真 PR + 真 merge commit」设计的。

`lane.status` 会渲染一个**可复制粘贴的 `worktree.cleanup` 计划调用**，但它自己从不执行。

---

## 4. model / provider / thinking 配置

**出处**：`docs/models.md:1-85`、`docs/agents.md:260-341`、`docs/tool-reference.md:97`

### 优先级（强 → 弱）

```
1. per-run override（launch 时 `model` 参数）
2. agentOverridesByProvider.<provider>.<name>
3. agentOverrides.<name>.model / .thinking / .defaultProvider / .fallbackModels
4. agent frontmatter 的 model / thinking / fallbackModels
5. subagents.defaultModel / defaultProvider / defaultThinking
6. 父 session 模型
```

原文：「Builtin agents **inherit your current Pi default model**.」

### 关键性质

- `thinking` 在运行时被**追加为 `:level` 后缀**，除非已有后缀。可选值：`off/minimal/low/medium/high/xhigh/max`
- `model: "inherit"` → 显式选父 session 模型
- **`agentOverrides` 不改 persona**：原文「This lets a shared agent **keep its persona while local settings choose the effective model**, context, tools, or other supported options.」
- `agentOverrides` 支持的字段全集（`docs/agents.md:218`）：`description`、`output`、`outputMode`、`defaultReads`、`model`、`defaultProvider`、`fallbackModels`、`thinking`、`systemPromptMode`、`inheritProjectContext`、`inheritGlobalContext`、`inheritSkills`、`defaultContext`、`acceptanceRole`、`disabled`、`skills`、`tools`、`systemPrompt`
  - 「Use `output: false`, `defaultReads: false`, `defaultContext: false`, or `acceptanceRole: false` to clear an inherited value」
  - 「**Project overrides beat user overrides**」
- `fallbackModels`：provider/model 失败时的有序备份（仅限「任何工具活动之前」的可重试失败；且有 HTTP 429 的受限续跑特例）
- 单次运行覆盖：`/run reviewer[model=anthropic/claude-sonnet-4:high] "task"`
- `{action:"models"}` 可列出准确 `provider/id`；「agent names are not model ids」
- 另有 `modelScope`（范围强制，`allow: ["inherit"]` 允许父模型）、`disableThinking`、thinking ceiling（`docs/models.md:174-230`）

---

## 5. pi-subagents 的 agent 定义

**出处**：`docs/agents.md`、`~/.pi/agent/npm/node_modules/pi-subagents/agents/`

### frontmatter 字段（完整示例见 `docs/agents.md:264-291`）

| 字段 | 说明 |
|---|---|
| `name` | 规范名 |
| **`package`** | 可选。`name: scout` + `package: code-analysis` → 注册为 **`code-analysis.scout`** |
| `description` | |
| `advertise` | `true` 才在父 system prompt 里出现（默认 false） |
| `aliases` | 逗号分隔或块列表。精确规范名优先；别名碰撞会 fail as ambiguous |
| `tools` | **严格白名单**。命名扩展工具还需其 provider 已加载。支持 `mcp:` 条目 |
| `excludeTools` | 在正常解析之后应用的拒绝表 |
| `extensions` / `subagentOnlyExtensions` | 省略 = 后台 child 加载父的环境扩展；空 = 不加载 |
| `model` / `fallbackModels` / `thinking` | 见 §4 |
| `systemPromptMode` | 默认 `replace`；`append` 保留 pi 基础 prompt |
| `inheritProjectContext` | 默认对 builtin 为 true（保留 `AGENTS.md`/`CLAUDE.md` 块） |
| `inheritGlobalContext` | 默认 **false** |
| `inheritSkills` | 保留/剥离 pi 发现的技能目录 |
| `skills` | **指定 child 收到的技能**（与 `inheritSkills` 无关） |
| `skillPath` | 调用私有技能文件/目录。相对路径从 agent 定义文件解析 |
| `output` / `defaultReads` / `defaultProgress` | |
| `async` / `timeoutMs` / `toolTimeoutMs` | |
| `acceptance` / `acceptanceRole` | `acceptanceRole: "read-only" \| "writer"` |
| `allowNestedSubagents` / `maxSubagentDepth` | 见 §7 |

### agent 发现与覆盖

**出处**：`docs/configuration.md:21-33`、`docs/agents.md:216-225`

```json
{
  "subagents": {
    "agentScanDirs": ["~/.pi/flows/*/agents"]
  }
}
```

> Add recursive user or project agent roots with `subagents.agentScanDirs`. Entries support `~` expansion. **A single `*` path segment expands one directory level**, so package-like folders can each expose an `agents/` directory. **Fixed user/project agent directories still win over same-name agents from scan roots.**

### 内置 agent 一览（`agents/` 目录）

| 文件 | 名字 | 工具 | 备注 |
|---|---|---|---|
| `worker.md` | `worker`（aliases: `developer, coder, implementer, develop`） | `read, grep, find, ls, bash, edit, write, contact_supervisor` | `thinking: high`、`systemPromptMode: replace`、`inheritProjectContext: true`、`inheritSkills: false`、`defaultContext: fork` |
| `reviewer.md` | `reviewer` | `read, grep, find, ls, contact_supervisor` | **没有 bash**；persona：「Do not use shell commands or write files. Report any test or Git command that a supervisor must run.」 |
| `scout.md` / `researcher.md` / `oracle.md` / `delegate.md` / `evidence-auditor.md` | | | |
| `claude-code*.md` / `codex-exec*.md` / `cursor-agent*.md` | 外部 CLI runner | | |

### 用户已有的 user 级 agent

`~/.pi/agent/agents/` 下：`Designer.md`、`Explore.md`、`worker.md`（**同名覆盖内置 worker**，`x-managed-by: pi-goal-list-loop-audit`，model pin 被移除以继承父模型）

---

## 6. pi-subagents 的执行与编排

### 6.1 状态与验收门

**出处**：`docs/tool-reference.md:379-423`

| 机制 | 说明 |
|---|---|
| `acceptance` | 证据门。级别：`auto`（默认）/ `none` / `attested` / `checked` / `verified`。证据种类：`changed-files`、`tests-added`、`commands-run`、`validation-output`、`residual-risks`、`no-staged-files`、`diff-summary`、`review-findings`、`manual-notes` |
| `gate` | **一条 host 运行的验证命令的简写** → 等价于 `acceptance: { level: "verified", verify: [{ id: "gate", command }] }`。**在 host 上执行并把结果记录为证据**。同一工作区状态 **memoized**（不重复跑）。`worktree: true` 时**在 child 的 worktree 内跑**。**与 `resume` 互斥** |
| `acceptance.review` | 独立的审查门。要 writer 结果必须被 review：`acceptance: { level: "checked", review: { required: true, agent: "reviewer" } }` |
| `usageBudget` | 根级用量预算 `{ tokens: { soft, hard }, costUsd: { soft, hard } }`。hard 阻止后续 launch，**不停止已运行的 child** |
| `toolBudget` | child 工具调用预算 `{ soft, hard, block }`。`block` 默认 `read/grep/find/ls`，`"*"` 阻止所有 |

### 6.2 workflows 与 lanes

**出处**：`docs/workflows.md:44-360`

```js
// 独立并行
const [a, b] = await runs.all([
  { key: "api", agent: "worker", task: "…", worktree: true, gate: "npm test" },
  { key: "ui",  agent: "worker", task: "…", worktree: true }
]);

// 带阶段的 lane（票内串联、票间并行）
const board = await runs.lanes([{ key: "api", stages: [
  { key: "writer",   label: "…", agent: "worker",   task: "…" },
  { key: "challenge",label: "…", resume: "previous", task: "…" },
  { key: "review",   label: "…", agent: "reviewer", task: "…" }
]}]);
```

- `runs.all` 返回**有序数组**（不是 key map）→ 用索引/解构/`.map()`
- `runs.lanes` 上限：**32 lanes / 每 lane 16 stages / 总 64 stages**，canonical JSON ≤64 KiB
- 「A child failure, stopped/detached result, or explicit **`structuredOutput.verdict === "blocked"` blocks only that lane**; later stages are marked `skipped` and sibling lanes continue. **Reviewer prose is never parsed.**」
- `resume: "previous"` 要求前一个 child 返回**保留的 runId**
- 滚动：保留 `runs.run` 的 promise，用 `Promise.race` 等最先完成的
- `runs.steer(key, message, options?)` → 回执状态 `queued` / `delivered` / `missed` / `failed`
- **沙箱能力**：「`runs.run`、`runs.all`、`runs.lanes`、`runs.steer`、`runs.status`、`runs.ref`/`runs.refs`、`emit`、`console`、标准 JavaScript，以及启用时的 mission `state`。**No filesystem, shell, arbitrary Pi tools, or host globals**」
- 验证脚本不启动 child：`{ action: "validate", workflowScript: "…" }`

### 6.3 resume 与保留 child

**出处**：`docs/tool-reference.md:197`、工具说明

- `{ action: "resume", id, message }` → 用**存储的 agent / model / tool contract** 唤醒
- `resume` 与 `agent` 互斥；`gate` 在 retained resume 上被拒绝
- 「Each distinct resume pass needs a new stable key; same-key reuse requires identical launch parameters」
- 脚本内：`await runs.run(newKey, { resume: runId, task })`
- `children.list` 只应 resume `resumable` 的行

### 6.4 mission 与持久状态

**出处**：`docs/missions.md`

- 普通 workflow 默认创建**一个** enclosing mission，记录在 `~/.pi/agent/missions/projects/<project-hash>/`
- workflow child **不**创建独立 mission
- **沙箱内可用**：`await state.get(key)` / `await state.set(key, value)`
  - 「Each set takes the state-file lock, reads the latest file, merges the key, and **atomically writes** `<mission-directory>/<mission-id>/state.json`」
  - 整文件上限 **256 KiB**
  - 每个 workflow 在**首次 get 时缓存**该文件
- `mission: false` → 临时 workflow，无 mission、无 `state`
- 复用同一 mission：`missionId: "<id>"`
- goal mission：`{ goal: true, budget: { tokens: N } }`

### 6.5 递归守卫

**出处**：`docs/workflows.md:462-480`

> Subagents can call `subagent` **only when their resolved builtin tools explicitly include `subagent`**. That is meant for delegated fanout agents, not ordinary worker/reviewer children.

- 默认**两层**：main session → subagent → sub-subagent
- 配置：环境变量 `PI_SUBAGENT_MAX_DEPTH`、`config.maxSubagentDepth`、agent frontmatter `maxSubagentDepth`（只能收紧）
- 子 agent 默认拿不到 `subagent` 工具，且会收到「你不是父编排器」的边界指令

### 6.6 子→父协调

**出处**：`docs/workflows.md:424-460`

- child 侧工具：`contact_supervisor`，`reason` ∈ `need_decision` / `interview_request` / `progress_update`
- 父侧：`subagent_supervisor({ action: "reply", replyTo, message })`，或用 `{ action: "pending" }` 查看
- 「Supervisor messages are scoped to **the exact Pi session id that spawned the child**」

### 6.7 编排形态的官方立场

**出处**：`docs/workflows.md:44-72`、`prompts/review-loop.md`

- 「For multi-step or parallel work, make **exactly one top-level `subagent` workflow call** with `async:true` and launch children only inside it.」
- 但 `/review-loop` 明确允许逐轮推进：「The sequence can be launched up front with `workflowScript` when it is already clear, **or continued as follow-up single-agent runs after each async completion**」
- 「Direct parent edits during orchestrator mode should be intentional, small interventions with a brief reason」（`skills/pi-subagents/SKILL.md`）

### 6.8 内置 prompt shortcuts

`prompts/` 下：`parallel-review.md`、`review-loop.md`、`parallel-research.md`、`gather-context-and-clarify.md`、`parallel-cleanup.md`、`council.md`

`/review-loop` 已实现「父 agent 控制 worker → reviewer → fix worker 循环，最多 3 轮（可配）」，并规定：
- 每轮派**新鲜上下文**的 reviewer 并行审查
- reviewer 只报有证据的具体问题，标 P0/P1/P2，末尾给 `Merge verdict: BLOCK / OK / OK with notes`
- 修完重新审查仅当有实质改动
- **不要盲从所有 reviewer 建议**；若涉及未批准的产品/范围/架构决策，先暂停问人

### 6.9 bundled skill

`skills/pi-subagents/SKILL.md` + `references/`：

| 参考文件 | 内容 |
|---|---|
| `multi-lane-orchestration.md` | **Lane board、partitioned runs、cold-start packets、handoff/cleanup/recovery** |
| `execution-controls.md` | 运行控制 |
| `review-and-validation.md` | 发现处置、验证、门失败分类 |
| `prompting-and-roles.md` | 提示与角色 |
| `constraints-and-recipes.md` | 约束与配方 |

`multi-lane-orchestration.md` 的关键要求（与本项目高度相关）：
- 多个可变 lane 启动前，父上下文记录 lane board：`Lane | repo/cwd | exact decision | claimed files or contract | isolation path | authority | next gate | handoff | why independent`
- 「Do not manufacture parallelism: **keep dependent work serial**, and only split work when each lane has a distinct decision and useful output」
- 「Use one writer per repo/cwd or worktree」
- 「**Send accepted fixes to that lane's sole writer**, then rerun only the affected gate」
- 「Every child packet must stand alone: include the goal, exact repository/cwd/ref, authority and edit boundary, relevant context/evidence, success criteria, validation, expected output, and stop/escalation rules」
- 「Keep a worktree until its handoff is durable, no run owns it, and no later gate needs it」

---

## 7. `pi-matt-flow` 的实测经验（**本项目必读**）

**出处**：`/Users/gaosong/Programs/llm-tools/plugins/pi-matt-flow/README.md`

### 8 条不变量（作者标注：「都是踩过的坑，不是风格偏好」）

1. 只有 `status === "running"` 注入 brief；`paused` 只在 `session_start` 自动接续一次
2. 每次变更**两轨同写**（session 轨 + 项目轨），`session_start` 取 `updatedAt` 新者，`/tree` 回滚以 session 分支为准
3. 阶段技能缺失 → **拒绝推进**，除非显式 `--force`。`getCommands()` 读到过 = 空技能表也是可信事实
4. 队列非空但没有 ready 票 → 报 **stuck**，不静默前进
5. 同一工作区**只允许一条 `running` 流程**
6. 别名注册**幂等**（pi 对同名命令不去重，会变成 `/grilling:1`、`/grilling:2`）
7. `/clear` 先确认再执行
8. **硬停不是建议**：commit `paused` 后冻结本 turn 的动手类工具（`tool_call` 钩子放行 `matt_flow`/`read`/`grep`/`find`/`ls`）

   ⚠️ **已知边界**：pi 会把同一条 assistant 消息里的多个工具调用**先全部预检再执行**，所以模型把 `advance` 和写工具打包在同一条消息里时，冻结拦不住那个写工具。硬停的权威机制始终是「不注入下一阶段 brief + 让用户敲 `/new`」

### 「环境不会告诉你的坑」（对本项目最相关的）

| 坑 | 结论 |
|---|---|
| `sourceInfo.baseDir` | 是**技能收集根目录**（如 `~/.pi/agent`），不是技能目录。技能目录只能靠 `dirname(filePath)` 或 `systemPromptOptions.skills[].baseDir` |
| `pi.getCommands()` | **不含内置命令**。别名层必须自维护内置名跳过表，否则技能名撞上 `/model`、`/new` 会出事 |
| `expandPromptTemplates: true` | **先派发扩展命令再展开技能命令**。别名 handler 里转发必须写 `/skill:x`，写 `/x` 会自递归 |
| 工具 `execute()` | 拿到的是基础 `ExtensionContext`：**没有 `newSession()`** |
| `pi.sendUserMessage` | fire-and-forget；流式中不传 `deliverAs` 会被 pi 拒绝 |
| `session_start` 里注入用户消息 | 会和 print/json/rpc 模式调用方紧接着的 `prompt()` **抢同一个回合** |
| **不要在 `session_start` 里起回合** | pi 启动序列是 `session_start` → …真实 I/O… → `session.prompt(initialMessage)`。抢先起回合会让 `pi "<消息>"` 那条消息撞上 `isStreaming` 抛 `Agent is already processing` 并被丢弃。那段 I/O 不可界，**延时不解决问题** |
| **类型检查不是可选项** | pi 用 jiti 加载扩展，**类型会被擦掉**。签名写错、事件参数名写错在运行时完全隐形 → 必须 `tsc --noEmit` 对 pi 的 `.d.ts` 做真实检查 |

### 验证手法（零 token）

```bash
cd /tmp/play && rm -rf .pi
pi --no-session -ne -e <包>/probe/stub.ts -p "/matt-flow begin"
cat /tmp/matt-flow-probe.jsonl    # 能看到真实发出的 "/skill:xxx" 消息
```

用 `probe/stub.ts` 给 `pi.sendUserMessage` 打桩。**不要**加 `-ns`（除非测技能缺失）。

### 与本项目重叠的代码

| 位置 | 内容 |
|---|---|
| `flow-core.ts:115-121` | `Ticket { id, title, blockedBy[], status }`，`TicketStatus = "todo" \| "doing" \| "done"` |
| `flow-core.ts:358-409` | `QueueReport { total, done, doing, todo, ready[], blocked[], missingDeps, stuck }` |
| `flow-core.ts:377-409` | `queueReport()` 实现：`ready` = 所有 `blockedBy` 都 done；`blocked` = 有未满足依赖；`missingDeps` = 引用不存在的 id；`stuck` = 非空未完成但无 ready |
| `flow-core.ts:411-420` | `pickTicket(queue, mode)`，`PickMode = "fifo" \| "smallest"` |
| `flow-core.ts:427-433` | `claimTicket(queue, id)` |
| `flow-core.ts:435-448` | `ticketActionGate(state)` 阶段门禁 |
| `flow-core.ts:1011-1031` | `renderTicketBrief(ticket, queue, state)` |
| `flow-core.ts:150` | **`currentTicket: string \| null`** ← 串行约束所在 |
| `flow-core.test.ts` | 1042 行，锁定票队列拓扑、双轨仲裁、配置分层、渲染、请求解析 |

---

## 8. B（implement-orchestrated）资产清单

**出处**：`/Users/gaosong/Programs/llm-tools/plugins/implement-orchestrated/`

| 文件 | 行数 | 内容 |
|---|---|---|
| `skills/implement-orchestrated/SKILL.md` | 118 | 编排器正文：命名空间说明、3 条 precondition、6 个步骤、3 个 brief 模板 |
| `agents/coder.md` | 23 | `model: opus`、`effort: max`；"pre-agreed seams"、red→green via tdd skill、报告按 context pointer、≤200 词 |
| `agents/reviewer.md` | 14 | `model: opus`、`effort: max`；按真实严重度分类、每条带 file:line、**read-only**、末尾给判决 |
| `agents/final-reviewer.md` | 14 | `model: inherit`、`effort: max`；专找单票审查看不到的问题、裁定先前延后的 minor |
| `.claude-plugin/plugin.json` | 23 | name/version 0.1.6/description/keywords/skills |
| `.claude-plugin/marketplace.json` | 17 | |
| `README.md` | 102 | 动机、需求、安装、`worktree.baseRef` 理由、用法、盒子里有什么、与 Matt `implement-spec` 的差异 |

**git 历史**（8 个 commit，最新 `7b7ec8f`）显示它已迭代过：agent 注册方式、namespaced agent 名、`model: inherit`、`worktree.baseRef` 说明、Matt 技能名前缀。

**B 里值得原样保留的知识资产**（与 harness 无关）：
1. 三个 brief 的**措辞与信息密度**（极简、只给指针）
2. 「两次修复后 escalate，继续做别的」
3. 集成测试门的位置（合并后，而非票内）
4. final-reviewer 的**特有视角**（跨文件漂移、组件矛盾、spec 有要求但无票实现、文档与代码不一致）
5. 「orchestrator 不写功能代码」
6. 「context pointers 通信，不搬运内容」
7. 收尾顺序：两轴 code review → 修 → final-reviewer → push → PR ready → 清理

---

## 9. 用户环境的当前状态

| 项 | 状态 |
|---|---|
| mattpocock-skills | 已批量软链到 `~/.pi/agent/skills/`（含 `tdd`、`code-review`、`codebase-design`、`resolving-merge-conflicts`、`to-spec`、`to-tickets`、`setup-matt-pocock-skills`、`implement` 等，共 **25 个**；另有 4 个 `st-worktree*`/`st-release` 非 mattpocock 来源） |
| `implement-spec`（Matt 草稿） | **未**软链（在 `skills/in-progress/` 下） |
| `implement-orchestrated` | 本地存在，**未**安装进 pi |
| `docs/agents/issue-tracker.md` | 用户的 pi 环境**尚未跑过** `setup-matt-pocock-skills`，即 repo 里可能没有这个文件 |
| pi-subagents | 0.67.0 已安装，`~/.pi/agent/extensions/` 下有三个扩展软链（aihubmix、pi-smart-selection、session-mode） |
| 用户级 agent | `Designer.md`、`Explore.md`、`worker.md` |

---

## 10. 机制探针实测（2026-09-15，`/tmp/mif-probe`）

真实 pi 环境下跑出来的结果，**不是文档推断**。这一节直接改写了 D14、D15 两条决策。

### 10.0 探针设置

一次性 git repo `/tmp/mif-probe`（`main` + 基线测试 `npm test` = `node --test`，绿），依次跑了：

1. 脏工作区 + `worktree: true` 派发（负向测试）
2. `worker` + `worktree: true` + `gate: "npm test"` + `outputSchema`（要求回传 `headSha`）
3. 父 agent 侧 git 操作（建票分支、移票分支）
4. `runs.run(newKey, { resume: <coderRunId>, task })` —— resume 同一 coder
5. `reviewer` + `worktree: true` + `baseRef: "refs/heads/ticket-1"`
6. 父 agent 直接进保留的 worktree 核对与跑测试

### 10.1 脏工作区会拦住整个 workflow（**成立，且比文档更狠**）

造一个未跟踪文件（`?? .review/`）后派发：

```
Workflow failed: Error: Run 'dirty-source-test' failed:
Worktree admission failed for 'dirty-source-test' at /tmp/mif-probe:
worktree isolation requires a clean git working tree. Commit or stash changes first.
```

- 是整个 **workflow 失败**，不是单 key 失败
- fan-out 消耗 **0/64**（与文档一致：拒绝的组不占槽位）
- 依据：`worktree.ts:351` 的 `git status --porcelain -- :!.pi/subagents`——**未跟踪文件也算脏**，只排除 `.pi/subagents/`

→ 落进 D14。

### 10.2 `outputSchema` + `gate` 都按预期工作

coder 回传的结构化结果：

```json
{ "headSha": "00be48096d63d8f3f2b1f6ee5436c70a7280dca5",
  "branch": "pi-subagents/coder-1-509b8f6-e9ea-s0-t0",
  "commits": [{ "sha": "00be480...", "message": "feat: hello" }],
  "testResult": "npm test (node --test): 2 tests, 2 pass, 0 fail." }
```

`status.json` 里 gate 被记为证据：`acceptance.status: "verified"`，含 `commands-run` / `no-staged-files` 与 `verify: [{id:"gate", command:...}]`。

**注意**：child 实际 cwd 是 `/private/tmp/worktrees/mif-probe/pi-worktree-<runId>-s0-0`，**不是** brief 里写的 repo 路径；brief 里的 repo 路径只能当“仓库标识”。

### 10.3 `git branch ticket-N <coderSHA>` 可用

```
$ git branch ticket-1 00be48096d63d8f3f2b1f6ee5436c70a7280dca5   → OK
$ git log --oneline ticket-1
00be480 feat: hello
3fc4379 chore: init probe repo (baseline test green)
```

commit message 完整保留。→ 支持 D8。

### 10.4 `git branch -f ticket-N <新SHA>` 可用

修复轮后把票分支移到新 SHA 成功，票分支累积两个 commit。→ 支持 D8/D15。

### 10.5 ⭐ resume 同一 coder **可用**（**推翻第一轮推断**）

第一轮曾推断：「cleanly captured → worktree 必然删除 → resume 时 `validateResumeCwd` 报 cwd 不存在」。**实测推翻**。

**真相**：pi 在 child **可 resume 时故意保留** worktree + 分支。`handoff.json` 原文：

```json
"cleanup": { "state": "partial",
  "tasks": [{ "worktreeRemoved": false, "branchRemoved": false, "preserved": true,
              "reason": "retained child resume requires managed worktree cwd" }] }
```

`children.list` 报 `resumability: resumable`。resume 后：

```
34a9592 docs: note hello      ← resume 后的修复轮（落在原 worktree 的原分支上）
00be480 feat: hello           ← 原 coder
3fc4379 chore: init probe repo
```

`git worktree list` 显示那个 worktree 仍在，HEAD 就在 `34a9592`。

**第一轮的推理错在哪**：假定「cleanly captured → 必删」，但保留判定里有一条更高优先级的规则（可 resume 必须留住 cwd）。**文档 `docs/workflows.md:383` 只写了删除那一半，没写保留规则**——只有源码/handoff 才写清楚。

→ 改写 D15：**B 的「修复送回同一 coder」原样可用**。

### 10.6 `baseRef: "refs/heads/ticket-N"` 可用

用 `reviewer`（无 bash，纯 read/ls）派到 `refs/heads/ticket-1` 的 worktree：

- 读到 `src/hello.js`（内容是**没有** JSDoc 的版本）→ 正好是 `ticket-1` 那个 commit
- 读到 `test/hello.test.js` 存在
- 而 `main` 工作区里 `src/hello.js` **根本不存在**

→ 这证明 reviewer 在自己的 worktree 里看得到**票分支的真实文件树**，不需要 patch。→ 支持 D8/D9。

### 10.7 reviewer 无 bash 可在 worktree 里正常工作

纯 `read`/`ls` 就完成了「报文件原文 + 判定存在性」，且**不会写脏 worktree**。resumability 与 worktree 回收都因此保持干净。→ 支持 D9 的“reviewer 不给 bash”决策。

### 10.8 父 agent 可以直接进保留的 coder worktree

```
$ git -C <coder worktree> status --porcelain     → 空（CLEAN）
$ (cd <coder worktree> && npm test)              → 2 pass, 0 fail
$ cat <coder worktree>/src/hello.js              → 含 /** Greets. */ （修复轮的成果）
```

→ 「修复轮由父 agent 跑 gate」与「用 worktree 代替 patch 做兜底」两条都成立。

### 10.9 ❌ patch 捕获在本机**永久失败**（静默降级）

`handoff.json` 里：

```json
"patch": { "changed": false, "filesChanged": 0, "path": ".../task-0-worker.patch",
           "error": "usage: git diff [<options>] [<commit>] [--] [<path>...]\n  or: ..." }
```

patch 文件 **0 字节**，而 coder 明明提交了改动。**根因（实测定位）**：

```
$ git --version
2.39.5 (Apple Git-154)

逐选项试：
OK      --no-color / --no-ext-diff / --no-textconv / --no-relative / --binary
REJECTED --default-prefix          ← 需要 git ≥ 2.41
```

`MACHINE_DIFF_OPTIONS`（`worktree.ts:23`）含 `--default-prefix` → **整个 `git diff` 命令被 git 拒绝** → 捕获退化为空 patch，**pi 不报错、只写空文件**。

**影响**：
- 依赖 `git apply patch` 的合并路线（原设计的甲 / 丙）在本机不可用
- Q2 选「丁」从「更优」升级为「不靠 patch 的唯一可用路线」
- `worktreeTempDirs` / handoff 里的 patch 证据链在本机全是空的

**环境建议**：`brew install git`（≥ 2.41）可恢复。但设计已不依赖 patch。**这值得作为 bug 报给 pi-subagents 上游**：旧 git 上静默丢 patch。

### 10.10 ⚠️ resume 会重放存储的 acceptance criteria

resume 任务里让 coder 用纯文本汇报 → 工作全部完成，但 run 被拒：

```
Workflow failed: Error: Run 'coder-1-fix-round-1' failed:
Acceptance rejected: Required criterion 'criterion-2' was not reported.
```

`status.json`：`acceptance.status: "rejected"`，criteria 为
`criterion-1 Implement the requested change without widening scope`、
`criterion-2 Return evidence sufficient for an independent acceptance review`（自动推断，非自定义）。

→ 修复轮的 brief **必须给出同样形状的证据**（changed files / commands run / validation output / residual risks）。落进 D15。

### 10.11 ⚠️ run status 不可信，必须看 git 真值

上一条那次 resume：`state: failed`，但 **commit 已经落地**（`34a9592` 确实在分支上）。

→ 「不要相信 coder 的报告」要扩展成「**连 run status 也不能直接当事实**」；父 agent 每轮必须用 git 状态（分支 SHA、`git status`）作为判定依据。落进 D15。

### 10.12 ⚠️ worktree / 分支会堆积，且 pi 不给 apply 式清理

派了 3 个 worktree child 后：

```
/private/tmp/mif-probe                                                    3fc4379 [main]
/private/tmp/worktrees/mif-probe/pi-worktree-509b8f68-...-s0-0          34a9592 [pi-subagents/coder-1-...]
/private/tmp/worktrees/mif-probe/pi-worktree-b598603f-...-s0-0          00be480 [pi-subagents/review-ticket-1-...]
```

**三个全部保留**（含只读的 reviewer），理由一律是 `retained child resume requires managed worktree cwd`。而：

```
worktree.cleanup  → mode: plan only；「Apply/removal is reserved for a later change」
```

→ 清理只能父 agent 自己做（`git worktree remove --force` + `git branch -D`）。落进 D15。

### 10.13 探针复现方式

```bash
# 准备
rm -rf /tmp/mif-probe /tmp/worktrees/mif-probe
mkdir -p /tmp/mif-probe/{src,test} && cd /tmp/mif-probe && git init -q -b main
# package.json: {"scripts":{"test":"node --test"}}；test/baseline.test.js 一个必过的用例（注意：node 24 不接受 `node --test test/`，要裸 `node --test`）
git add -A && git commit -qm 'chore: init'

# 关键步骤（在 pi 里）
# 1) subagent({ cwd, mission:false, async:false, workflowScript: runs.run(key,{agent:"worker",task,worktree:true,gate:"npm test",outputSchema}) })
# 2) 父侧：git branch ticket-1 <headSha> / git branch -f ticket-1 <newSha>
# 3) resume: runs.run(newKey, { resume: <coderRunId>, task })
# 4) reviewer: runs.run(key, { agent:"reviewer", task, worktree:true, baseRef:"refs/heads/ticket-1" })
# 5) 证据：<asyncDir>/handoff.json （asyncDir 在子 agent 的 artifactPaths 里）
```

**读证据的位置**：子 agent 结果里的 `artifactPaths[0]` = asyncDir，内含 `handoff.json`（含 `patch` / `cleanup` / `children[].structuredOutput`）、`status.json`（含 acceptance）、`structured-output/`、`worktree-diffs/`。**注意 asyncDir 在系统临时目录**（`/var/folders/.../pi-subagents-uid-<uid>/async-subagent-runs/`），**不在 repo 里**——所以它不会污染工作区干净性。

### 10.14 嵌套 fanout 与 fork 的事实（D16 的依据）

| 事实 | 出处 |
|---|---|
| fork 只从**启动者**流向**直接 child**（缓存键取 `parentSessionId`，源 session 取 `ctx.sessionManager.getSessionFile()`） | `execution.ts:429`、`subagent-executor.ts:617` |
| 兄弟 session 互相不可达 → 「reviewer fork coder」机制上不存在 | 同上 + `resolveFork` 只在启动者的 session roots 里解析 |
| 默认嵌套深度两层（main → child → 孙代）；孙代再往下被拦并给指引 | `docs/workflows.md:462-480` |
| `maxSubagentDepth`（agent frontmatter）**只能收紧**继承的限额 | 同上 |
| `allowNestedSubagents: true` 授权 child-safe 嵌套 fanout，**不会**把省略的 `tools` 变成白名单；`subagent` 仍必须显式出现在 resolved tools | `docs/agents.md:322,406` |
| 嵌套 run 出现在父的 status 树里，可按 id `interrupt` / `resume`（⚠️ 修正：第一轮预览说「子代失败对父不可见」是错的） | `docs/workflows.md:466` |
| 嵌套 child 的 cwd = 启动者的 cwd（即 reviewer 的 worktree）→ 轴 child 直接读票分支文件树 | 待实现时验证 |
| 轴 child 的 usage 是否向上汇入根级 `usageBudget`：**未证实** | 实现时验证 |
| 前台 child 永不加载父的环境扩展；后台 child 默认加载（除非 agent 设 `extensions`） | `docs/agents.md:412` |

### 10.15 review bundle 用三点 diff

`/code-review` 原文：*Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base)*。

票分支根在 feature 的某个 commit 上时，`git diff <feature>...refs/heads/ticket-N` 的 merge-base 正好落在票的 baseCommit → 精确圈出这一票的改动（即使 feature 已经合进了别的票）。第一轮写的两点 `..` 已全部更正为三点 `...`。

### 10.16 ⚠️ `outputSchema` + `gate` 同用时，`acceptanceReport` 必须是 `structured_output` 调用的**兄弟键**

用自研 coder agent 跑 smoke 时踩到的真机制：

- 带 `gate` 时 runtime 会往 brief 注入 **Acceptance Contract**（`acceptance.ts:492`），要求 child 的最终 `structured_output` 调用里包含 `acceptanceReport` 对象
- 结构化运行时把工具参数定义为 `{ value: <schema>, acceptanceReport: {type:object} }`，捕获时分开写 `output.json` 与 `acceptance-report.json`（`structured-output.ts:64-71,130-152`）
- **我们的 coder 把 `acceptanceReport` 嵌进了 `value` 里面** → `acceptance-report.json` 不存在 → 解析回落到「在最终文本里找 ```acceptance-report 围栏」→ 找不到 → `Acceptance rejected: Structured acceptance report not found`——**即使工作全部完成、schema 字段一个不少**（TDD 红→绿、commit 已落地）
- 修复：persona 的 Report 段必须写明工具调用的确切形状（`value` 与 `acceptanceReport` 是兄弟键，不许嵌套）；修复后 smoke-3 一次通过
- 推论：**凡是自带「报告格式」纪律的自研 agent，都必须写明这条**，否则模型会把契约要求挤掉；内置 worker 没踩坑是因为它的 persona 没有和契约竞争的强格式约束

### 10.17 注册链路验证（2026-09-15 第二轮探针）

| 验证项 | 结果 |
|---|---|
| `pi install <本地路径>` | ✅ settings 写入相对路径 `../../Programs/llm-tools/plugins/...`；`subagents` 段保持空（D11：不需要 agentScanDirs） |
| 三个 agent 以全名注册 | ✅ `pi-matt-implement-flow.coder/.reviewer/.final-reviewer`，来源 `pi-matt-implement-flow@0.1.0`；与内置 `reviewer`、用户级 `worker`（alias 含 `coder`）零冲突 |
| `agentOverrides` 的 key | ✅ **必须用全名**：用全名 key 写 `description` 覆盖，capabilities 列表立即生效；移除后恢复（D11 待验证项销项） |
| agent frontmatter 的 `skills:` 解析 | ✅ `tdd`、`codebase-design`、`code-review` 都能从用户级软链解析（`status.json` 记录 `skills: ['tdd','codebase-design']`）；pi-subagents 的「Proactive skill subagent suggestions」也识别到了两个 reviewer 关联 code-review |
| 自研 coder 真实跑通 | ✅ TDD 红→绿、commit、结构化输出、D8 闭环（`git branch ticket-09 <SHA>` 成功）——见 §10.16 的 acceptance 形状坑 |
| D15 父 agent 自管清理 | ✅ 两个失败 smoke 的保留 worktree 删前 `status --porcelain` 自检为空 → `git worktree remove --force` + `git branch -D` 成功 |
