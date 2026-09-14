# pi 能力映射

> B = `implement-orchestrated`。本文件把 B 的每个机制映射到 pi 的对应能力，分四类：**升级**（pi 做得更好）、**无损**（机制不同但效果一样）、**取舍**（有真实代价）、**删除**（pi 里不需要）。
>
> 所有事实的出处见 [`verified-facts.md`](./verified-facts.md)。

---

## 0. 先弄清 B 在做什么

### 输入与核心概念

输入是**一个 spec + 一堆票**，票之间有 `Blocked by` 依赖声明，构成有向图。

**前沿（frontier）** = 此刻「所有前置都已完成」的票集合。B 的全部工作就是：

> 派发前沿 → 等完工 → 验收 → 合并 → **重算前沿** → 再派发……直到无非完成票

### 六个环节

| # | 环节 | 具体做法 |
|---|---|---|
| ① | 建账本 | 把「票 / 状态 / 被谁阻塞 / 谁在做 / 分支 / worktree 路径」写成表，存 repo 外的 `state.md`。每次派发、判定、合并后更新。**用途：跨 context 压缩的记忆** |
| ② | 开分支 + 记基线 | 从 HEAD 建 `feat/<slug>`；跑一次全量测试并记录结果作基线（以后红了才能判断是不是自己弄坏的）；有 GitHub remote 就 push 并开 draft PR |
| ③ | 并行派活 | 每个前沿票 → 一个 `coder`（worktree 隔离、后台跑）；同时最多 N 个（默认 3）；认领票并记录 agent id |
| ④ | 逐个验收 | coder 报完工 → `reviewer` 检查。通过→合并；有问题→把发现写成文件，**resume 同一个 coder**（保留其上下文），只给文件路径；**修两轮仍不过 → 标 escalated，放一边继续做别的** |
| ⑤ | 合并 + 集成测试 | `git merge --no-ff`；冲突→调 `resolving-merge-conflicts`；跑全量测试，红了说明是「单票内部看不出、合起来才暴露」的问题→派一个**不带隔离**的 coder 在功能分支上修；关票（带 merge SHA）；删 worktree + 票分支；**重算前沿** |
| ⑥ | 最终验收门 | 两轴 `code-review`（Standards + Spec，非找 bug），一个 coder 修掉全部发现；`final-reviewer` 做整支审查，**专找单票 review 看不到的**（跨文件漂移、组件矛盾、spec 有要求但无票实现、文档与代码不一致）；push、PR 转 ready |

### 三条贯穿始终的纪律

1. **主 agent 不写功能代码**——只做派发、验收、合并、保持前沿流动
2. **只传指针，不搬内容**——给路径 / 票号 / 分支名 / SHA，不复制粘贴（subagent 自己能读）
3. **一切靠磁盘状态**——不靠对话记忆

---

## 1. pi 做得更好的（升级）

| B 的机制 | pi 的做法 | 为什么更好 |
|---|---|---|
| **"别信 coder 的报告，自己跑测试"**（B 只能写提示词求 reviewer 自觉） | `gate: "npm test"` | ⭐ **最大升级**。host 执行、结果记为证据、同一工作区状态**不重复跑**（memoized）。`worktree: true` 时 gate 就在那个 worktree 里跑。这是平台强制，不是提示词祈求 |
| **"每票必须过 review"**（B 靠流程纪律） | `acceptance: { level: "checked", review: { required: true, agent: "reviewer" } }` | 平台强制 |
| **前沿的"一票卡住不影响其他票"** | `runs.lanes` | 文档原文：child 失败或 `structuredOutput.verdict === "blocked"` **只阻塞该 lane**，兄弟 lane 继续 |
| **跨压缩的记忆（`state.md`）** | **mission + `state.get` / `state.set`** | 原子写、带锁、跨 workflow 调用持久、沙箱内可直接读写。B 得自己维护 markdown 文件的读写一致性 |
| **coder 遇到歧义怎么办** | `contact_supervisor`（`reason: "need_decision"`） | B 的 coder 只能在报告里写「我遇到 X」；pi 里可以**暂停等答复再继续** |
| **coder 超范围改动的担忧** | watchdog（opt-in） | 对抗式变更审查 + 范围监控 + LSP 检查，独立监控层 |
| **reviewer 的判决解析** | `outputSchema` + `structuredOutput.verdict` | B 靠解析散文（"End with the verdict: Approved / Needs fixes"）；pi 是结构化字段 |

---

## 2. 无损的（机制不同，效果一样）

| B 的机制 | pi 的做法 | 备注 |
|---|---|---|
| 票图 + 前沿重算 | **纯逻辑写在 skill 正文**，主 agent 自己读票判依赖 | 不依赖任何平台能力。且 `pi-matt-flow/flow-core.ts` 已有 `queueReport()` 可参考 |
| 并行 N 个 coder | `runs.all([...])` 一次派 N 个，async 默认后台 | `maxSubagentSpawnsPerRun` 默认 64 是上限保护 |
| `isolation: worktree` | `worktree: true` | 语义等价 |
| 基线测试记录 | 主 agent 用 `bash` 跑，写进 mission state | — |
| 集成测试门（合并后） | 主 agent 用 `bash` 跑 | **必须在 workflow 之外**——workflowScript 沙箱没有 shell 权限 |
| 两轮修复后 escalate | 纯逻辑 + `structuredOutput.verdict === "blocked"` 阻塞该 lane | 更结构化 |
| 修复送回同一 coder | `runs.run(newKey, { resume: coderRunId, task })` | ✅ **实测可用**：child 可 resume 时 pi **故意保留** worktree + 分支（handoff 理由：`retained child resume requires managed worktree cwd`），resume 回到原 worktree 原分支继续。⚠️ `runs.lanes` 的 `resume: "previous"` **只指向紧邻的前一个 stage**（`scripted-workflow.ts:461,495`），跨 stage 不成立。详见 [`verified-facts.md`](./verified-facts.md) §10.5 / D15 |
| 两轴 code review | `code-review` skill（已软链），由 reviewer 以 **fanout** 方式运行（D16）：它自己派 Standards / Spec 两个轴 child（`context: fork`），聚合后返回结构化判决 | 两轴分离原样保留；聚合在证据旁边；轴 child 连技能一起 fork |
| final-reviewer 的整支视角 | 把「专找单票审查看不到的东西」写进 task brief | persona 通用化后需要写清楚 |
| 开 draft PR / 关票 / 带 SHA 评论 | 主 agent 用 `bash` + `gh` | 依赖 issue-tracker |
| `disable-model-invocation: true` | pi **原生支持同名字段** | 零翻译 |
| `argument-hint` | pi 忽略此字段（无害）；参数经 `/skill:<name> <args>` 追加为 `User: <args>` | 功能上可用，仅少了提示显示 |

---

## 3. 要取舍的

### 取舍 1：合并语义（**唯一真正的难点**）

> ⚠️ **本节下方部分内容已被实测推翻，保留作决策记录。最终决策见 `decisions.md` D8 / D14 / D15，实测证据见 `verified-facts.md` §10。**
>
> **最终选择：方案「丁」**（本表当时没有它）——coder 回传 commit SHA → 父 agent `git branch ticket-N <SHA>` 重建真票分支 → `git merge --no-ff ticket-N`。三条硬依据：
>
> 1. `baseRef` **只接受具名 ref，拒绝 40 位 SHA** → 票分支是必需品，不是可选项
> 2. **本机 git 2.39.5 不支持 `--default-prefix`（需 ≥ 2.41）→ patch 捕获永久失败并静默退化为 0 字节** → 依赖 `git apply patch` 的甲 / 丙 两条路线**在本机不可用**（§10.9）
> 3. worktree 会被 pi 保留（为了 resume），所以**不需要 patch 也能拿到完整改动**——直接进 worktree 核对即可
>
> **另：下方 (丙) 的三步伪代码有一处错误**——`git checkout -b ticket-42`（隐含从当前 feature HEAD 拉）会让后续 `git apply` 因上下文漂移而失败。若将来回到 patch 路线，票分支**必须根在 child 的 `baseCommit`**（handoff manifest 里有该字段），漂移交给 `merge` 做三方合并。

| | B | pi 原生 |
|---|---|---|
| worktree | **持久** | **持久**（⚠️ 实测修正：child 可 resume 时 pi **故意保留** worktree） |
| 分支 | **持久**，coder 提交上去 | pi 管理的分支也**被保留**；另由父 agent 建 `ticket-N` 真分支 |
| 留下什么 | 可 merge 的分支 | 保留的 worktree + 分支；`.patch` 在本机**恒为空**（§10.9） |
| 合并方式 | `git merge --no-ff <票分支>` | `git branch ticket-N <SHA>` → `git merge --no-ff ticket-N`（D8） |

**pi 捕获 patch 的真实命令**（源码实测）：

```bash
git diff --cached --binary <baseCommit>
# 输出到 task-<index>-<agent>.patch
```

关键含义：
- `--cached`：只捕获**已暂存**的改动 → **coder 必须 `git add` 或 `git commit`，否则 patch 为空**。B 的 coder brief 本来就要求 commit，天然满足
- `--binary`：二进制文件也能正确捕获与 apply
- 是 `git diff` 格式，**不是** `format-patch`（邮箱格式）→ **不能 `git am`**，coder 的多个 commit 和 commit message 全部丢失

**三个代价**：

| 代价 | 严重程度 | 具体含义 |
|---|---|---|
| 没有真分支 | **中** | ① reviewer 不能用 `git diff <feature>...<票分支>`（票分支不存在），得改成读 patch；② 不能在合并前 checkout 检视；③ **commit message 与提交历史丢失** |
| 没有 merge commit | 低 | `git log --graph` 看不到并行分支拓扑（merge commit 的第二 parent 链）；不影响可追溯性 |
| 关票的 SHA 语义变化 | 很低 | 填 apply 后自己 commit 的 SHA。追溯链完整，只是语义从「合并」变「提交」 |

### 合并策略三方案

> ⚠️ 下表是**第一轮的备选分析**，缺了最终选定的「丁」（coder 回传 SHA → 重建真票分支 → 真 merge）。三条硬依据（baseRef 拒绝 SHA、本机 patch 恒空、worktree 被保留）见本节开头的提示框与 `decisions.md` D8。

| | (甲) pi worktree + `git apply` | (乙) 自己 `git worktree add` | **(丙) pi worktree + 重建分支再真 merge** |
|---|---|---|---|
| 真分支 | ❌ | ✅ | ⚠️ 事后重建 |
| 真 merge commit | ❌ | ✅ | ✅ |
| coder 的 commit message | ❌ | ✅ | ❌ |
| pi worktree 托管 | ✅ | ❌ 全自己管 | ✅ |
| pi 清理保护 + handoff 证据 | ✅ | ❌ | ✅ |
| lane 追踪 | 要硬凑 | ❌ 无 manifest | ✅ 自然可用 |
| 额外 git 操作 | 少 | 高 | 中 |

**(丙) 的具体步骤**：

```bash
# 1. child 在 pi 的 worktree 里干活 → 结束得到 handoff manifest + 被保留的 worktree（实测：patch 在本机为空）
# 2. 主 agent 在功能分支上重建票分支
git checkout -b ticket-42-add-auth
git apply /path/to/task-0-coder.patch
git commit -m "ticket 42: add auth (closes #42)"
# 3. 真 merge（保留拓扑）
git checkout feature-branch
git merge --no-ff ticket-42-add-auth
git branch -d ticket-42-add-auth
```

**为什么 (丙) 可能最优**：
1. 三个代价里消掉两个（真 merge commit、SHA 语义）
2. **让 lane 追踪自然可用**——`lane.recordMerge` 的 schema 要求真实 `mergeCommit`（40 位 SHA）与 `prNumber`
3. 仍白拿 pi 的隔离 + handoff 证据 + 失败关闭的清理保护

**残留代价**：coder 的 commit message 丢失（patch 格式决定，无法避免）。缓解：
- 主 agent 在 apply 后用自己的 commit message（带票号）
- 要求 coder 在**报告**里回传它的 commit message 列表

**(乙) 的隐藏损失**：绕开 pi 的 worktree 意味着**同时失去 handoff manifest 和 lane 追踪**（manifest 由 worktree 生命周期产生）。拿到完整 git 语义的代价比看上去大。

### 取舍 2：coder 的 persona 纪律

B 的 `coder` 强制「在预先约定的缝隙上跑 red→green 的 TDD 循环」。pi 内置 `worker` 是通用「单写者」，**不提 TDD**，且默认 `inheritSkills: false`（看不到技能目录）。

**可用机制**：
- 把 TDD 要求写进 task brief
- 或 `agentOverrides` 给 agent 加 `skills: tdd, codebase-design` + `systemPrompt` 补充
- 或按 Q3 选 (甲) 写专用 agent

### 取舍 3：reviewer 没有 bash

pi 内置 `reviewer` 的工具白名单是 `read, grep, find, ls, contact_supervisor`——**没有 bash**，persona 明确写「不要用 shell 命令，只报告主 agent 需要跑什么」。

而 B 的 reviewer brief 要求「自己跑测试而不是信 coder 的报告」。

**缓解**：
1. `gate` 已在 coder 交付时由平台强制跑过测试，reviewer 不必再跑（**首选**）
2. `agentOverrides` 给 reviewer 加 `bash`
3. 主 agent 代跑

---

## 4. pi 里不需要的（删除）

| B 里的内容 | 为什么删 |
|---|---|
| `Preconditions` 整段：检查 `worktree.baseRef` 是否为 `head`、以及要用户手动跑的那段 python 命令 | **pi 默认就从 HEAD 分配 worktree**，这个坑不存在 |
| `.worktreeinclude` 的整段说明 | pi 用 `worktreeSetupHook`（跑 `npm ci` 等，可返回 `syntheticPaths` 排除辅助文件） |
| 「插件装好后 agent 注册在命名空间下，先检查 Agent tool 有哪些类型」 | pi 的 agent 名是扁平的（可用 `package:` 做命名空间，见下） |
| `CLAUDE_CODE_SUBAGENT_MODEL` 那句 | 换 pi 的 model 配置 |
| 「call the Skill tool with `X`」 | pi **没有 Skill tool**。改用 agent frontmatter 的 `skills:` 字段，或 `read` 对应 SKILL.md |
| `mattpocock-skills:code-review` 命名空间 | pi 里技能名就是 `code-review`（用户已软链） |
| `.claude-plugin/plugin.json` + `marketplace.json` | 换 `package.json` + `pi` manifest |
| `agents/openai.yaml`（Codex UI 元数据） | pi 忽略，不需要 |

---

## 5. 环境隔离机制（满足「不污染当前项目」）

### 问题

pi package 的约定目录是 `extensions/` `skills/` `prompts/` `themes/`——**不含 `agents/`**。所以 agent 定义不会被 `pi install` 自动装载。

### 解法（两条，D11 选了第一条）

**首选：包 manifest 声明 agent 目录**（无需 scan 配置）：

```json
{ "pi": { "skills": ["./SKILL.md"], "subagents": { "agents": ["./agents"] } } }
```

或等价的 `{"pi-subagents": {"agents": ["./agents"]}}`。源码依据：`pi-subagents/src/agents/agents.ts:517-545`（读两个字段）、`:585-602`（settings 里的本地路径包也会被扫描）。配合 `pi install <本地路径>` 一次注册技能 + agent。

**备选：`subagents.agentScanDirs`**（不装包时用）：

```json
{
  "subagents": {
    "agentScanDirs": ["/Users/gaosong/Programs/llm-tools/plugins/pi-matt-implement-flow/agents"]
  }
}
```

- **指向目录，不复制任何文件**到 `~/.pi/agent/`
- 支持 `~` 展开
- 支持单层 `*` 通配（文档例子：`"~/.pi/flows/*/agents"`）→ 可做包式布局
- ⚠️ 固定目录（`~/.pi/agent/agents/`）里的同名 agent **赢过** scan roots

### 命名空间

agent frontmatter 加：

```yaml
---
name: coder
package: pi-matt-implement-flow
---
```

→ 注册为 `pi-matt-implement-flow.coder`，与内置 `reviewer`、用户 `worker`（`aliases` 里含 `coder`）完全隔离。这是 Claude Code 那个 `implement-orchestrated:coder` 的 pi 原生等价物。

### 「不污染」的实际程度

- ✅ 不往 `~/.pi/agent/agents/` 复制或软链任何文件
- ✅ 完全不碰 `implement-orchestrated`
- ⚠️ 会往 `~/.pi/agent/settings.json` 加注册条目（`agentScanDirs` + package），移除很干净

---

## 6. 编排形态：为什么不能写成一个大 workflowScript

pi 的 `workflowScript` 沙箱**没有文件系统、没有 shell、没有 Pi 工具**（可用：`runs.*`、`emit`、`console`、JavaScript、mission `state`）。

而 B 的循环里有大量主 agent 侧的操作：`git merge`、跑测试、关票、删 worktree、开 PR。

**所以形态必然是「主 agent 逐轮驱动 + 每轮一个 fanout workflow」**：

```
主 agent（有 bash / gh / edit）
├─ 轮 1: subagent({ workflowScript, async:true })   ← runs.all 派 N 个 frontier 票的 coder
├─ 等完成通知
├─ 主 agent: apply patch、merge、跑测试、关票、重算前沿
├─ 轮 2: subagent({ workflowScript })               ← 新的 frontier
└─ ...
```

> ⚠️ **上图中「apply patch」已作废**（本机 patch 恒空，见 §10.9）。**最终形态（D13/D14/D15 落定后）**：
>
> ```
> 每轮（父 agent 被 async 完成唤醒后继续，不需用户敲字 —— D13）
> ├─ 0. 前置检查：git status --porcelain 必须为空（否则整轮派发失败 —— 实测 10.1 / D14）
> ├─ 1. 适配器算前沿 → 认领票（本地 markdown 模式要单独 commit 状态改动）
> ├─ 2. runs.all([...N 个 coder])：各 worktree:true + gate + outputSchema 要求回传 SHA
> ├─ 3. 父 agent：git branch ticket-N <SHA>（兜底：进保留的 worktree 核对/补 commit）；
> │              写 review bundle（git diff <feature>...ticket-N，三点）到 gitignore 路径
> ├─ 4. runs.all([...N 个 reviewer])：各 worktree:true + baseRef=refs/heads/ticket-N（无 bash；各自 fanout 两个轴 child，D16）
> ├─ 5. 不过 → runs.run(newKey, { resume: <coderRunId>, task: 读 findings 修 })；父自己跑测试；看 git 真值判定
> ├─ 6. 通过 → git merge --no-ff ticket-N；回收该票的 reviewer worktree
> └─ 7. 合并后跑集成测试 → 重算前沿 → 回步 0
>
> 收尾：两轴 code-review → 修 → final-reviewer → push/PR → 回收所有 worktree + 票分支
> ```
>
> **`runs.lanes` 不再需要**：修复轮跨轮发生，而 lane 的 `resume: "previous"` 只能指向紧邻的前一个 stage，无法表达「review 不过→回到 coder」。

这不是妥协——pi-subagents 的 `/review-loop` prompt 明确支持这个形态：

> The sequence can be launched up front with `workflowScript` when it is already clear, **or continued as follow-up single-agent runs after each async completion**.

### 每轮内部的编排骨架

看「票内串联、票间并行」时用 `runs.lanes`：

```js
const board = await runs.lanes([
  {
    key: "ticket-42",
    stages: [
      { key: "coder",    agent: "coder", task: "…", worktree: true, gate: "npm test" },
      { key: "review",   agent: "reviewer", task: "…" },
      { key: "fix",      resume: "previous", task: "…" }   // 送回同一 coder
    ]
  },
  { key: "ticket-43", stages: [ /* … */ ] }
]);
```

**已知限制**：
- `runs.lanes` 上限：32 lanes / 每 lane 16 stages / 总共 64 stages
- `gate` 与 `retained resume` 互斥（resume 用保留的 child contract）
- lane 内某 stage 失败只阻塞该 lane，兄弟 lane 继续

---

## 7. 与 `pi-matt-flow` 的分工

> ⚠️ **本节已被 D7 作废**。用户在 Q1 决定：本项目**纯独立实现**，`pi-matt-flow`（含它的票图、前沿计算、硬停）**全部废弃**，本项目只做 implement 编排。下表保留仅作历史记录；其中的 `queueReport()` 等实现仍可作为「纯函数层该怎么写」的参考读物。

| 能力 | `pi-matt-flow` | 本项目 |
|---|---|---|
| 六阶段状态机 | ✅ 已有 | ❌ 不做 |
| 技能别名层（`/tdd` → `/skill:tdd`） | ✅ 已有 | ❌ 不做 |
| 票图 + 前沿计算 | ✅ `queueReport()` | ❌ 不复用（D7 已废弃 pi-matt-flow） |
| 硬停 | ✅ 已有 | ❌ 不做 |
| **implement 阶段的并行编排** | ❌ 串行（`currentTicket: string \| null`） | ✅ **本项目的全部价值** |
| 每票 review + 修复循环 | ❌ | ✅ |
| 合并门 + 集成测试 | ❌ | ✅ |
| worktree 隔离 | ❌ | ✅ |

**核心冲突**：`pi-matt-flow` 硬不变量是「同一时刻最多一张 doing 票」，本项目要 N 张。见 `decisions.md` Q1。
