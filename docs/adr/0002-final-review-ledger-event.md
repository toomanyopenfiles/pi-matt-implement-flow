# ADR-0002: 终审入流——final 事件与封账门

- **Status:** accepted
- **Date:** 2026-09-21
- **Deciders:** 本包维护者（经 grill 会话定稿）
- **Context tags:** orchestrator-memory, ledger, final-review, enforcement, audit

## Context

整分支终审（final review）目前不在事件流：台账十类事件全部围绕票建模（required 含
ticket），`verdict` 枚举是票级二值（approved / changes_requested），终审是整分支三值
（ready / ready_with_fixes / not_ready），值域不同、模型缺位。终审结论只活在编排笔记与
SKILL 流程文本里，终点被 `pr --state ready` 与 `close` 隐式吸收。旁路后果已经显形：

1. 离线审计工具（audit-report/collect.js 的 `findFinalReviews`）靠「扫子代理产物目录名 +
   时间窗过滤」捞终审，已修过一次历史终审混入的 bug——workaround 的脆弱性即数据模型
   缺口的实证；
2. 终审的成本用量、失败重试在台账与审计里无迹可循（终审与 coder/reviewer 同为子代理
   运行，却被记账口径豁免）；
3. 封账前「终审已过」无法机械校验。

设计哲学对照（ADR-0001 之后的确立口径）：**记账单位是票图/run 的状态转换，不是子代理
调用**。票级 reviewer 派发不单独记事件，由 verdict 的 revRunId 承载——这是
script-owned-ledger spec（US27）显式拍板的坍缩：审计要的两个事实（派发过、结论是什么）
时间相邻，一个事件承载，派发单独入账不新增决策信息；coder 的 dispatch 之所以记，是它
同时是状态转换（frontier→claimed）与 compaction 恢复锚点（US12）。终审裁决是 **run 级
状态转换**（整分支就绪性），把它升为一等事件是同一哲学的延伸而非违背——final-reviewer
的派发照旧不记，runId 挂在 final 事件上（revRunId 先例的复刻）。

## Decision

新增第 11 类台账事件 `final`，终审结论融入事件流、台账、对账与审计报告。核心拍板：

1. **事件名 `final` + 新旗标 `--final-verdict`**（三值枚举 `ENUMS.finalVerdict`）。不复用
   `verdict` 键：枚举校验按 key 全局生效，复用会被票级二值枚举拒绝；为复用旗标把枚举
   校验改成按事件类型作用域则要动 parseFlags 内核、扩大测试矩阵，不值。`final` 与
   `init`/`pr`/`close` 同为环节词，风格一致。
2. **`--run-id` 必选**：编排器拿到裁决时手里必然有 runId；审计事件驱动路径与 check 的
   平台证据校验全靠它锚定，可选会让「忘带」的账在审计里静默蒸发。
3. **`--findings` 沿用 verdict 先例**：仓库相对路径，审计侧按路径读原文、缺失标警告；
   长摘要走 `--note`。
4. **多轮终审 = 多条 final 事件**：seq 顺序天然表达轮次，不设 round 字段，一律以最新
   裁决为准；不_ready 也如实记账（只记好结果是幸存者偏差，且封账门的警告出口依赖它
   在账上可见）。
5. **封账门（分层）**：有合并工作的运行，无 final 事件 → **拒绝**封账（默认路径的不变量
   「封账前终审已入账」）；最新裁决 not_ready → **警告放行**——用户看完终审升级拍板放弃
   是合法出口，强拒绝会让 run 永远卡在 running，恰好复活 close 存在要消灭的「失真的
   进行中」反模式；零合并票的运行（全 escalate / 空跑）终审本就不该发生，不检查。
6. **不进流程形态快照**：终审是固定环节，`reviewer=off` 的运行终审照跑，与开关无关。
7. **记账门（警告级）**：尚无 merge 事件就有 final → 警告不拒绝（流程异常非事实矛盾，
   符合本模块「确定矛盾才拒绝」的家规）。
8. **审计改造**：事件驱动优先——账上有 final 事件就从事件取 runId 并入成本表
   （角色桶 final-reviewer/终审 既有），不扫目录；账上无 final 事件的旧账整体降级为
   现有目录扫描 + 时间窗过滤，行为不变，不双计。「记账前崩溃」的孤儿终审在恢复流程中
   会被重派发的终审取代，不进正账。
9. **旧账兼容硬要求**：无 final 事件的旧账 build/check 零新增报错、不警告刷屏——先例同
   init 流程形态旗标「省略 = 默认形态，旧账本自然兼容」。旧账不迁移。

执行细节（台账头部 `final:` 行渲染、findings 命名惯例、check 的 runId 平台证据 best-effort
探测、SKILL.md 记账指令与事件清单同步、CHANGELOG）归本 feature 的 spec.md，不在 ADR
展开。README 不改：终审能力已在 README 能力描述中，本变更只改状态记录与校验的内部
方式，不新增用户侧可感知能力（新 README 规则随后落 AGENTS.md，独立待办）。

## Alternatives considered

**继续旁路（否决）**——终审不入流，审计靠目录扫描 + 时间窗。已出过一次历史终审混入
bug；封账不变量无法机械校验；每次审计都在为数据模型的缺口打补丁。

**强不变量「终审已过」方可封账（否决）**——latest=not_ready 也拒绝。放弃场景被卡死，
run 永远无法封账（见 Decision 5）。分层门在不放松默认路径执法的前提下给放弃留警告级
出口。

**事件名 `final-verdict`（否决）**——更显式，但时间线出现 `final-verdict finalVerdict=…`
双重 stutter；`final` 环节词风格与既有事件一致。

**`--run-id` 可选（否决）**——对齐 revRunId 可选先例，但终审的 runId 是事件驱动审计与
证据校验的唯一锚点，性质不同于票级（票级还有 dispatch/fix 事件兜底锚定 coder）。

## 论证：为什么满足记 ADR 的三条件

1. **难逆转**：schema + EVENT_VERSION 2 + close 门语义 + 审计双路径（事件驱动 + 旧账
   降级）一旦落地，回退成本覆盖主流程脚本、测试与审计工具。
2. **无上下文会困惑**：为什么终审是一等事件、票级 reviewer 派发却不是？不看 ADR-0001
   的「状态转换」记账哲学与 spec US27 的坍缩拍板，这个不对称看起来像遗漏——维护者
   本人在设计终审入流时也重新问了一遍这个问题，即实证。
3. **真实取舍**：接受 schema/审计的双路径复杂度与放弃场景的警告级豁免，换取终审的
   结论、用量、失败重试自然融入台账对账与审计报告，以及默认路径上「封账前终审已入账」
   的机械不变量。

## Consequences

- 编排器在 Final gate 拿到裁决后记账 `final`；封账门在 `close` 写点执法（分层语义见上）。
- 台账头部可见终审结论（最新裁决 + runId 短码）；audit-report 新账走事件驱动路径并
  把终审并入成本表，旧账行为与今天完全一致。
- 「封账时最新终审为 not_ready」成为审计风险项（medium）。
- 域词汇表（CONTEXT.md）新增「终审」词条，「封账」词条补封账门语义；本 ADR 与词条
  构成后续 spec/issues 的决策权威。
