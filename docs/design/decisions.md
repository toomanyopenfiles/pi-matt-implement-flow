# 决策记录

> 最后更新 2026-09-15（第二轮）。已定 = 用户明确说过或已实测确认。
>
> **Q1–Q8 已全部落定**（D7–D15）。其中 D14、D15 是 `/tmp/mif-probe` 探针实测**修正**过的结论——探针推翻了第一轮的一个推断，详见 [`verified-facts.md`](./verified-facts.md) §10。

---

## 已定

### D1 · 知识底本用 `implement-orchestrated`，不用 `implement-spec`

**决策**：移植 `implement-orchestrated`（下称 B）的正文作为流程知识来源。

**理由**：
- Matt 的 `implement-spec`（下称 A）只有 40 行、2 个文件，是 `in-progress/` 桶的 beta 草稿；B 的 README 自认是 A 的完成品（"fills in the parts that draft leaves open"）
- A 缺：brief 模板、状态记忆、并发上限、修复循环、升级规则、集成测试门、收尾 review
- B 的正文里真正有价值的是**流程知识**（brief 措辞、验收清单、"修两轮就升级"的分寸、集成门位置），这些与 harness 无关

**影响**：`pi-capability-map.md` 里逐条对照的就是 B 的机制。

### D2 · 新建独立 pi 项目，不改造原 Claude Code 插件

**决策**：在 `~/Programs/llm-tools/plugins/pi-matt-implement-flow/` 新建项目。不修改 `/Users/gaosong/Programs/llm-tools/plugins/implement-orchestrated/`。

**理由**：用户明确要求「在新项目中实现所有功能，不污染当前项目」。

**影响**：原 B 项目保持 Claude Code 插件形态不变；pi 侧完全独立演进。

### D3 · 项目目录

**决策**：`/Users/gaosong/Programs/llm-tools/plugins/pi-matt-implement-flow/`

**理由**：用户指定放在 `~/Programs/llm-tools/plugins/`，与其他 pi 插件并列。

**命名评估**：用户提议 `pi-matt-implement-flow`。发现同级已有 `pi-matt-flow`（用户自己的六阶段状态机）之后，这个名字**变得合适**了——它与 `pi-matt-flow` 构成命名族，并明确表达「matt 流程的 implement 阶段」。备选：
- `pi-implement-orchestrated` —— 与原项目名对应，但看不出与 pi-matt-flow 的关系
- `pi-matt-implement` —— 更短，但没有 "flow" 族的呼应

**结论**：采纳用户提议，除非 Q1 的定位决策导致更好的命名。

### D4 · `SKILL.md` 放项目根目录

**决策**：用户指定 skill 正文放项目根目录 `SKILL.md`，不放 `skills/<name>/SKILL.md`。

**含义与待验证点**：这不符合 pi 的 `skills/` 递归发现约定（`skills/**/SKILL.md`），需要用其他方式让 pi 认到它。见 Q5。

### D5 · 设计文档放 `docs/design/`

**决策**：本目录。项目当前只有设计文档，无任何代码。

### D6 · 需求：subagent 的 model / provider / thinking 必须可自定义

**决策**：设计必须支持用户自定义每个 subagent 角色使用的 model、provider、思考级别。

**实现机制已查明**（见 `verified-facts.md` §4）：六层优先级，其中关键一条是 **`agentOverrides` 不改变 agent 的 persona**——同一份 agent 定义，本地 settings 决定实际模型。这正是要的机制。

**设计约束**：agent frontmatter 里**不写死 model**（或写 `inherit`），把模型决策交给 `agentOverrides`，保证包在别人的环境里也能跑（见 Q4）。

---

## 已定（第二轮：Q1–Q8）

### D7 · 项目定位（Q1）：纯独立实现，只做 implement

**决策**：`pi-matt-flow` **废弃**。本项目不读它的状态文件、不复用它的代码（仅作参考实现阅读）。

**范围**：只做 implement 阶段。前置四阶段 `setup → grill-with-docs → to-spec → to-tickets` 由**用户手动跑**，产出的 spec + 票是本项目的输入。

**影响**：
- 不需要六阶段状态机、技能别名层、硬停（`pi-capability-map.md` §7 的分工表作废，改为「本项目自管票图」）
- 票来源完全由上游 `to-tickets` 决定 → 直接导致 D12

### D8 · 票分支与合并（Q2）：方案「丁」

**决策**：coder 在 pi 管理的 worktree 里干活（该 worktree 会被**保留**，见 D15）→ 回传 commit SHA → 主 agent `git branch ticket-N <SHA>` 重建**真票分支** → `git merge --no-ff ticket-N`。

**关键约束**：`baseRef` **只接受具名 ref，明确拒绝 40 位 SHA**（`docs/tool-reference.md:115`）→ 票分支不是可选项而是必需品（reviewer 的 worktree 定位、修复轮的续接、最终合并都靠它）。

**收益**：真分支 + 真 merge commit + coder 的 commit message 与 author 信息全部保留。**patch 完全不参与主路径**。

**环境限制**：本机 git 2.39.5 不支持 `--default-prefix`（需 ≥ 2.41）→ pi 的 patch 捕获**永久失败并静默降级为 0 字节**（`verified-facts.md` §10.9）。因此原设计的 (甲)(丙) 两条依赖 `git apply patch` 的路线在本机不可用。

### D9 · agent 策略（Q3）：3 个专用 agent，persona 拼装

| agent | persona 来源 | 工具 |
|---|---|---|
| `coder` | B 的纪律（TDD 缝隙、pointer 报告、≤200 词、只提异议不重设计）+ pi 特有（`contact_supervisor`、必须 commit 并回传 SHA）+ map 资产（票指向 `prototype/<name>` 分支时按 primary source 读它） | read/grep/find/ls/bash/edit/write/contact_supervisor |
| `reviewer` | **内置 reviewer 的证据纪律措辞更成熟**（按证据过滤、`No issues found.` 精确措辞）+ B 的「永不信任实现者报告」+ **`/code-review` 的两轴资产**（12 条 Fowler 味道基线 + 三条绑定规则，经 `skills: code-review` 携带，D16） | read/grep/find/ls/**subagent**/contact_supervisor，**无 bash、无写**，`allowNestedSubagents: true` |
| `final-reviewer` | B 的跨票视角（跨文件漂移、组件矛盾、spec 有要求但无票实现、文档与代码不一致）+ 证据纪律 + 两轴流程（同 reviewer，D16） | 同 reviewer（含 **subagent**），**无 bash、无写** |

**为什么不用内置 + `agentOverrides`**：`agentOverrides` 是全局的，会连带改掉 `/review-loop` 等流程里的 reviewer 行为。

**为什么 reviewer 不给 bash**：写脏 worktree 会导致它无法被回收（D15）。`gate` 已覆盖测试需求，reviewer 只需读。

**为什么不用内置 `worker`**：它 `defaultContext: fork`（会把编排器的全部上下文灌进 coder，与「只传指针」纪律相反），且不提 TDD。

### D10 · 命名空间（Q4）

**决策**：agent frontmatter 写 `package: pi-matt-implement-flow`。

→ 注册为 `pi-matt-implement-flow.coder` / `.reviewer` / `.final-reviewer`，与内置 `reviewer`、用户级 `worker`（`aliases` 含 `coder`）完全隔离。源码依据：`src/agents/identity.ts:19` `buildRuntimeName()`。

### D11 · 注册方式（Q5 + Q8）：标准 pi 包 + `pi install`

**决策**：`package.json` 声明两个字段，然后 `pi install <本项目绝对路径>`（本地路径只写 settings，**不复制任何文件**）：

```json
{
  "name": "pi-matt-implement-flow",
  "keywords": ["pi-package"],
  "pi": {
    "skills": ["./SKILL.md"],
    "subagents": { "agents": ["./agents"] }
  }
}
```

**已验证**（非猜测）：
- 文件型 skill 条目可用：`package-manager.js:2021-2033` 对字面路径做 `statSync().isFile()` 后**直接收下，无目录假设**
- 两个 agent manifest 字段都支持：`agents.ts:517-545` 读 `pi-subagents.agents` 与 `pi.subagents.agents`
- settings 里的**本地路径包**会被纳入 agent 扫描：`agents.ts:585-602`
- 备选路线（软链）也可用但只覆盖 skill 半边：`~/.pi/agent/skills/<name>.md` → `SKILL.md`（文件软链）或目录软链到项目根（内含根 `SKILL.md` 即被发现）——`skills.js:134-177`

**待验证**：`agentOverrides` 的 key 是否必须用全名 `pi-matt-implement-flow.coder`（源码 `applyCustomAgentOverrides` 用 `agent.name`，而 `agent.name` = runtimeName，倾向「必须全名」，但无文档明说，实现时用 `subagent({action:"list",capabilities:true})` 确认）。

### D12 · tracker 支持（Q6）：本地 markdown + 远程 issue 双支持

**决策**：两种都支持。探测顺序：

1. 有 `docs/agents/issue-tracker.md` → 按它（github / gitlab / local / other）
2. 否则探测 `.scratch/*/issues/` → 本地 markdown
3. 都没有 → **停下来问用户要 feature slug 或票号，不要猜**

**关键纪律：frontier / 认领 / 关票的定义一律沿用上游**（`setup-matt-pocock-skills` 的 `issue-tracker-local.md` / `issue-tracker-github.md`），不自创。

| | 本地 markdown | GitHub / GitLab |
|---|---|---|
| 位置 | `.scratch/<feature>/issues/<NN>-<slug>.md`（`NN` 从 01 按依赖顺序） | 一票一 issue，按依赖顺序创建 |
| 依赖边 | 文件顶部 `**Blocked by:**` 行 | 原生 issue dependencies；降级为 body 的 `Blocked by:` 行 |
| 认领 | 写 `Status: claimed` | `gh issue edit <n> --add-assignee @me` |
| 前沿 | 每个 blocker 文件都 resolved | 无 open blocker 且无 assignee |
| 关票 | 改 `Status` + 追加 `## Comments` | `gh issue comment` → `gh issue close` |
| 收尾 | 无 PR | 可选 draft PR → ready（B 的第②⑥步） |

适配器对外统一成 4 个操作：`list(feature)` / `claim(id)` / `close(id, evidence)` / `specPath(feature)`。

**适配器不引入 triage 步骤**：map 明确「/to-tickets 产出的票已 agent-ready，不要送 triage」→ 只认 `ready-for-agent`。

**`/code-review` 的 spec 来源顺序**（commit message 里的票引用 → 显式路径 → spec 文件）在我们的流程里被简化：父 agent 总是显式传 spec 路径与票路径；同时 coder 的 commit message 必须带票号（B 原有纪律，正好对齐该顺序的第一位）。

### D13 · 驱动模式（Q7）：一次调用跑到底

**决策**：一次 `/skill:pi-matt-implement-flow` 调用一直推进到全部票完成 + 最终 review。

**机制**：async 完成会**唤醒同一 session 起新 turn**（`src/runs/background/subagent-wait.ts:6`：「can end its turn and Pi will wake it with a completion notification」）→ 父 agent 从唤醒点继续下一轮，不需要用户敲字。

**强制配套：磁盘账本**。长跑必然触发上下文压缩，压缩后 skill 正文可能已不在上下文里。账本要含：票盘与状态、每票分支名与各轮 SHA、已合并 SHA、当前轮次、escalated 列表。每轮开头重读账本。

### D14 · 工作区干净性前置检查（探针修正）

**决策**：每轮派发 worktree child 之前，必须 `git status --porcelain` 为空。

**依据**：`worktree.ts:351` 是 `git status --porcelain -- :!.pi/subagents`——**未跟踪文件也算脏**，且只排除 `.pi/subagents/`。探针实测：脏工作区会让**整个 workflow 失败**（不是单 key），消耗 0 槽位（`verified-facts.md` §10.1）。

**落盘位置规则**：
- 账本 / review bundle / findings → 放 `.gitignore` 覆盖的路径（gitignore 的文件不出现在 `--porcelain` 里，天然免疫）
- 票状态改动（本地 markdown 模式）→ 只能每轮末尾**单独 commit**（`chore(tickets): claim #NN`），不混进 coder 的 commit
- 脏且无法归类 → **停下来问用户**，不要自己 stash

### D15 · 修复循环与清理（探针**推翻**第一轮推断后重写）

**第一轮的推断是错的**。当时的推理链是「cleanly captured → worktree 必然删除 → resume 找不到 cwd → 报错」，于是打算放弃 B 的「同一 coder 修复」。

**实测真相反转**：pi 在 child **可 resume 时故意保留** worktree + 分支，handoff 里写得很明确：

```json
"cleanup": { "state": "partial",
  "tasks": [{ "worktreeRemoved": false, "branchRemoved": false, "preserved": true,
              "reason": "retained child resume requires managed worktree cwd" }] }
```

→ **B 的「修复送回同一 coder」原样可用**，resume 后 coder 在**原 worktree、原分支**上继续（探针里产出了第二个 commit）。

**修复循环**：

```
runs.run(newKey, { resume: <coderRunId>, task: "读 <findings路径> 修复" })
```

三条配套纪律（全部来自实测）：

| 纪律 | 原因 |
|---|---|
| 修复轮的 gate 由**父 agent 自己跑**（`cd <coder worktree> && npm test`，实测可行） | `gate` 与 retained `resume` 互斥（`docs/tool-reference.md:127`） |
| fix brief 必须给出**同样的证据形状** | resume 会**重放存储的 acceptance criteria**；报告证据不足会判 `Acceptance rejected`（实测 §10.10） |
| 判定永远看 **git 真值**，不看 run status | 实测出现过 `state: failed` 但 commit 已落地（§10.11） |

**清理（本项目新增的职责，必须父 agent 自己做）**：

- 每个 worktree child 结束后 worktree + 分支都被保留 → 每票每轮堆积一个（实测 §10.12）
- pi 的 `action: "worktree.cleanup"` **只有 plan 模式**（`Apply/removal is reserved for a later change`，`docs/tool-reference.md:103`）→ 等于**主动放弃 pi 的清理保护，换成自管**
- 策略：**reviewer 的 worktree 立即回收**（下一轮 review 重派 fresh reviewer 更干净）；**coder 的 worktree 留到票关闭**（删了就丢 resume 能力）；票合并后父 agent `git worktree remove --force` + `git branch -D`，删前 fail-closed 自检「改动已在票分支/feature 分支上」

**兜底方案也随之改变**：patch 在本机作废（D8），但 worktree 被保留反而是更好的兜底——父 agent 可 `git -C <coder worktree> status --porcelain` 核对，有未提交改动就自己补 commit 再取 SHA。比 patch 可靠，且不需要升级 git。

### D16 · 每票 review 形状（Q9）：fanout reviewer（丙）

**决策**：`reviewer` 升级为**委托式 fanout agent**：每票一个 reviewer child，由它运行 `/code-review` 的两轴流程——自己派两个并行轴 child（Standards / Spec），聚合后返回结构化判决。

**frontmatter 变化**：`tools` 加 `subagent`；`allowNestedSubagents: true`；`skills: code-review`（它就是「运行 code-review 技能的那个 agent」）。轴 child 用**同一个 reviewer agent**、不同 brief，深度天然被递归守卫封顶（默认两层，`docs/workflows.md:462-480`）。

**fork 的正确位置（Q9 的核心澄清）**：

- ❌ 「reviewer fork coder 的 context」**机制上不可能**：fork 只从**启动者**流向**直接 child**（`execution.ts:429` 用 `parentSessionId`；`subagent-executor.ts:617` 取 `ctx.sessionManager.getSessionFile()`）；coder 与 reviewer 是兄弟 session，互相不可达
- ❌ 就算可行也不该：Matt 的纪律是 *"verify every claim against reality — never trust the report alone"*；继承 coder 的上下文等于把它的叙事和锚定效应一起交给 reviewer，摧毁 review 的独立性
- ✅ reviewer 的「上下文可见性」由指针供给：自己的 worktree（`baseRef=refs/heads/ticket-N`，探针 §10.6）+ 三点 diff bundle + 票文件 + spec 路径 + gate 证据 + coder 的结构化报告
- ✅ fork 真正成立的位置：**reviewer → 两个轴 child**（`context: fork`，继承 reviewer 的独立阅读；轴 brief 仍需自足——multi-lane 纪律：每个 packet 独立）

**丙的真实代价**：

- 中间层（reviewer 本身）是乙没有的 token 开销
- 轴 child 的 usage 是否向上汇入根级 `usageBudget`：**未证实**，实现时验证
- reviewer 不再「纯只读」——它有 `subagent` 工具；但写脏 worktree 的风险不变（仍无 bash/写）
- 意外收益：12 条味道基线不用塞进 persona——轴 child fork 时**连同 code-review 技能一起继承**

**逃生舱**：若嵌套编排首次试跑不稳，降级到乙只需把两次派发挪回父 agent 的 `runs.all`——**三个 agent 文件不变**（reviewer 无 `subagent` 工具时由父驱动照样工作），只改 SKILL.md。

**父 agent 仍拥有门**：合并与否看 git 真值 + reviewer 的结构化判决（`verdict: approved | changes_requested`，绝不用字面 `blocked`）。**任一轴有 P0/P1 → 修复轮**；只有判断题味道 → 记 notes 后合并，留给 final-reviewer 裁定。

**与 map 的对照**：`/code-review` 原文就是「运行技能的 agent 派两个并行轴 sub-agent、分别汇总、不合并不重排」。丙里 reviewer 扮演这个角色，两轴分离原样保留。

---

## 待选项与决议（Q1–Q8 已全部落定，下列分析保留作决策依据）

### Q1 · 项目定位：与 `pi-matt-flow` 什么关系？（**最优先**）

**背景**：`pi-matt-flow` 已经实现了本项目的相当一部分前置能力：

| 能力 | pi-matt-flow 现状 |
|---|---|
| 票的依赖图 | ✅ `Ticket { id, title, blockedBy[], status }` |
| 前沿计算 | ✅ `queueReport()` 返回 `ready[] / blocked[] / missingDeps / stuck` |
| 依赖环检测 | ✅ `stuck` 标记 |
| 选票策略 | ✅ `pickTicket(queue, mode)`：`fifo \| smallest` |
| brief 渲染 | ✅ `renderTicketBrief(ticket, queue, state)` |
| 硬停 | ✅ `halt` 支持阶段边界与 `ticket` 边界 |

**根本冲突**：

```ts
// pi-matt-flow/flow-core.ts:150
currentTicket: string | null;   // 单值 → 串行
```

README 把它写成硬不变量：「同一时刻**最多一张 doing 票**；`ticket-done` 只接受当前票」。而本项目要**并行 N 个 coder**。

**三个选项**：

| | (甲) 扩展 `pi-matt-flow` | (乙) 取代 `pi-matt-flow` | (丙) 独立并存 |
|---|---|---|---|
| 做法 | 在 pi-matt-flow 的 implement 阶段加"orchestrated 模式" | 新项目做成完整主流程 + 编排 | 新项目只做 implement 编排，自己管票图 |
| 复用 | 最高（直接改 `currentTicket` → `doing: string[]`） | 中（吸收全部能力重写） | 低（复制需要的纯函数） |
| 风险 | 改动面大：`FlowState` 结构、`reduce()`、工具参数、1042 行测试都要动 | 重复实现票图/前沿/brief；但状态模型可重新设计不受串行约束 | 两份状态管理会分叉（都用 `.pi/` 下不同目录，但语义重叠） |
| 对用户的影响 | 一个流程、一套状态 | 一个流程、一套状态 | 两个流程需协调，可能困惑 |

**我的倾向：(丙) 独立并存，但把 `pi-matt-flow` 当参考实现重度借鉴**。理由：

1. 两者的状态模型**根本不同**——串行 `currentTicket: string | null` vs 并行 `doing: string[]`，强行共用 `flow-core` 会造成双向约束
2. 但 `pi-matt-flow` 的**纯函数层和测试**是宝贵资产：票拓扑、前沿、环检测、brief 渲染都有测试锁定（1042 行测试），应大量参考甚至逐函数对照移植
3. `pi-matt-flow` 的 **8 条不变量** 和 **"环境不会告诉你的坑"** 章节是本项目必读——那些是实测踩出来的 pi 扩展开发约束（见 `verified-facts.md` §5）
4. 独立演进只需保证：两个项目不在同一工作区同时驱动同一个 implement 阶段（用 `.pi/` 下不同状态目录天然隔离）

**若选 (甲)**，需要预先评估：改动 `FlowState.ticket` 结构会连带影响 `reduce()` 的全部票分支、`claimTicket` / `ticketActionGate`、`renderTicketBrief`、`renderQueue`，以及 1042 行测试里的票队列用例。

---

### Q2 · 合并策略：甲 / 乙 / 丙？

**背景**：B 的合并是「coder 在持久 worktree 的持久分支上提交 → `git merge --no-ff <票分支>`」。

> ⚠️ **本节背景描述已被探针修正**：“pi 的 worktree 是临时的（child 结束即删除）”**不成立**——child 可 resume 时 pi **故意保留** worktree + 分支（`verified-facts.md` §10.5）。同时 patch 在本机恒为空（§10.9），所以甲/丙 两条依赖 patch 的路线不可用。**最终决策见 D8。**

详细对比见 [`pi-capability-map.md`](./pi-capability-map.md) §合并策略。

**三个选项**：

| | (甲) pi worktree + `git apply` | (乙) 自己 `git worktree add` | (丙) pi worktree + 重建分支再真 merge |
|---|---|---|---|
| 真分支 | ❌ | ✅ | ⚠️ 事后重建 |
| 真 merge commit | ❌ | ✅ | ✅ |
| coder 的 commit message | ❌ | ✅ | ❌ |
| pi worktree 托管 | ✅ | ❌ 全自己管 | ✅ |
| pi 清理保护 + handoff 证据 | ✅ | ❌ | ✅ |
| lane 追踪 | 要硬凑 | ❌ 无 manifest | ✅ 自然可用 |
| 额外 git 操作 | 少 | 高 | 中 |

**我的倾向：(丙)**。它消掉三个代价中的两个（真 merge commit、SHA 语义），并让 lane 追踪自然可用（因为 `lane.recordMerge` 的 schema 要求真实 `mergeCommit` 与 `prNumber`）。唯一残留代价是 coder 的 commit message 丢失（patch 是 `git diff` 格式，不含 message，也不能 `git am`）——可用「主 agent 在 apply 后用自己的 commit message（带票号）」+「要求 coder 在报告里回传它的 commit message 列表」缓解。

---

### Q3 · agent 策略：3 个专用 agent，还是复用内置？

**选项**：

| | (甲) 3 个专用 agent | (乙) 复用内置/已有 agent |
|---|---|---|
| 内容 | `coder` / `reviewer` / `final-reviewer` 各自定义 persona | 用 pi-subagents 内置 `worker` / `reviewer`，或用户已有的 `worker.md` |
| 优点 | B 的 persona 纪律完整保留（coder 的 TDD 循环、final-reviewer 的"专找跨票问题"视角） | 无命名冲突；零翻译工作 |
| 缺点 | 需要处理与内置 `reviewer`、用户 `worker`（`aliases` 含 `coder`）的命名冲突（见 Q4） | 内置 `worker` 不提 TDD 且默认 `inheritSkills: false`；内置 `reviewer` **没有 bash** |

**已知的两个摩擦点**：

1. **内置 `reviewer` 没有 bash**：工具白名单是 `read, grep, find, ls, contact_supervisor`，persona 明确写「不要用 shell 命令，只报告主 agent 需要跑什么」。而 B 的 reviewer brief 要求「自己跑测试而不是信 coder 的报告」。
   - 缓解：`gate` 已在 coder 交付时由平台强制跑测试，reviewer 不必再跑；或给 reviewer 加 `bash`
2. **TDD 纪律无处安放**：B 的 `coder` 强制「red→green via tdd skill，在预先约定的缝隙上」。pi 的 `worker` 是通用单写者。
   - 缓解：写进 task brief；或用 `agentOverrides` 给 agent 加 `skills: tdd, codebase-design` 与 `systemPrompt` 补充

**我的倾向**：**(甲) 3 个专用 agent**，配 Q4 的命名空间。理由：B 的 brief 措辞和 persona 纪律是核心资产之一，复用内置会丢掉；而 `agentOverrides` 的 `skills` / `systemPrompt` 字段能让专用 agent 也保持"模型可配"（满足 D6）。

---

### Q4 · 是否用 `package:` 命名空间？

**机制**：agent frontmatter 加 `package: pi-matt-implement-flow` → 注册为 `pi-matt-implement-flow.coder`，与内置 `reviewer`、用户 `worker` 完全隔离。

**我的倾向：用**。这是 Claude Code 那个 `implement-orchestrated:coder` 命名空间的 pi 原生等价物，零冲突成本。

**代价**：调用时要写全名（`pi-matt-implement-flow.coder`），brief 里的名字变长。

---

### Q5 · 根目录 `SKILL.md` 怎么被 pi 发现？

**背景**：pi 的 skill 发现规则（`docs/skills.md`）：

- `~/.pi/agent/skills/` 和 `.pi/skills/` 下的**根级 `.md`** 会被当作独立 skill 发现（前提：frontmatter 合法且 `description` 非空）
- 其他位置是 `skills/**/SKILL.md` 递归发现
- package 通过 `package.json` 的 `pi.skills` 声明

**所以根目录 `SKILL.md` 的三种挂载方式**：

| | 做法 | 评价 |
|---|---|---|
| (甲) | `package.json` 里 `pi.skills: ["./SKILL.md"]` | 最干净，随 `pi install` 走。**需实测验证 manifest 是否接受文件路径**（文档的 glob 示例都是目录） |
| (乙) | 在 `~/.pi/agent/skills/` 下建根级软链 `implement-orchestrated.md -> <项目>/SKILL.md` | 文档明确支持该目录的根级 `.md`；但要多一个软链 |
| (丙) | 改成 `skills/<name>/SKILL.md` 标准布局 | 最保险，但违背用户 D4 的决定 |

**我的倾向**：先试 (甲)，不通则 (乙)。(丙) 作为兜底。

---

### Q6 · 是否依赖 `docs/agents/issue-tracker.md`？

**背景**：B 的第 0 步是「读 `docs/agents/issue-tracker.md`，没有就停下让用户跑 `/setup-matt-pocock-skills`」。它靠这个文件知道怎么取票、认领、评论、关闭。

**选项**：

| | 做法 | 评价 |
|---|---|---|
| (甲) 继承 B：强依赖 issue-tracker | 与 Matt 生态一致，支持 GitHub / GitLab / 本地 markdown 三种 tracker |
| (乙) 只支持本地 markdown 票文件 | 与 `pi-matt-flow` 的默认一致（`.scratch/<feature>/issues/`），无需 setup |
| (丙) 两者都支持，自动探测 | 最灵活，正文要两种路径都写 |

**需注意**：用户的 pi 环境**尚未跑过** `setup-matt-pocock-skills`，所以 repo 里没有 `docs/agents/issue-tracker.md`。这会影响首次可用性。

**我的倾向**：(丙)，默认本地 markdown（零前置），探测到 `docs/agents/issue-tracker.md` 时优先用它。

---

## 最终文件结构（D1–D15 全部落定后）

```
pi-matt-implement-flow/
├── package.json              # 唯一注册入口（D11）：pi.skills + pi.subagents.agents
├── SKILL.md                  # 编排器正文（用户指定的根目录位置，D4）
├── agents/                   # D9 / D10
│   ├── coder.md              #   package: pi-matt-implement-flow
│   ├── reviewer.md
│   └── final-reviewer.md
├── README.md
└── docs/design/              # 本目录
```

**实现顺序**（探针已完成前置验证）：

1. `package.json` + `agents/{coder,reviewer,final-reviewer}.md` → `pi install` → 用 `{action:"list",capabilities:true}` 确认三个 agent 被认到、全名可用、`agentOverrides` 生效（D11 的待验证项）
2. `SKILL.md` 正文：账本格式 → tracker 适配器 → 每轮时序 → 修复循环 → 合并与集成测试门 → 收尾两轴 review
3. 在真实 repo 上试跑一轮
