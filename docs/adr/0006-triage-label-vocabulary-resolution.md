# ADR-0006: triage label 词表解析——输入可变、映射拉取时钉死、输出固定

- **Status:** accepted（设计与契约已定稿；实现待词表票）
- **Date:** 2026-09-26
- **Deciders:** 本包维护者（经 brainstorm 会话定稿）
- **Context tags:** tracker, triage-labels, vocabulary, snapshot

## Context

转写（`tracker-sync-core.statusOf`）把 GitHub issue 的 label 映射为本地 `Status:` 行，
而 label 字符串活在**目标仓库**的 `docs/agents/triage-labels.md`（`/setup-matt-pocock-skills`
落盘，明文支持自定义："Edit the right-hand column to match whatever vocabulary you actually
use"），本地 Status 枚举则被账本状态机硬消费（封账门判 `wontfix` / `resolved` 字面值）。
现状把映射写死为 canonical 五角色名——目标仓库一旦改名，`statusOf` 全落 `needs-triage`
兜底：`wontfix` 改名会在封账门以"票未闭环"的误导性报错误炸响，其余角色静默失真。

同族张力：`typeOf` 的 `wayfinder:` 前缀属上游 issue-tracker 范本约定（不在 setup 的可
配置面上），透传已足够宽容，不纳入本决策。

## Decision

三层结构，职责各归其位：

1. **输入词表（可变）**：实际 label 串。唯一开放编辑面是 triage-labels.md 的
   「Label in our tracker」列——每行一个非空 label、全表唯一；「Label in
   mattpocock/skills」列固定为五个 canonical 角色名（恰好各出现一次）；「Meaning」列与
   表格外散文纯文档，忽略。行集合闭合（恰好五行，不增不删）；行序无关；映射优先级
   （wontfix → closed → 词表序）留在代码，不开放配置。按**表头名**定位列（防插列错位
   造成静默错映射），label 匹配大小写不敏感（GitHub label 名跨大小写唯一）。
2. **映射（拉取时钉死）**：`snapshot-init` 在转写前解析该文件得到 role→label 映射，
   以参数传入纯函数（`statusOf(issue, labelMap)`，默认 canonical）；生效映射钉进快照，
   保住"逐字节确定性"契约的可复现性。快照零覆盖拒绝，映射随快照只钉一次。
3. **输出词表（固定）**：本地 Status 枚举即账本状态机词表，任何配置不得改写。

失败策略——**显式记录绝不忽略，无记录才假设默认**：

- **文件存在但违反契约**（表头缺失 / 行不齐 / 角色名错 / label 空或重复）→ 立即失败，
  且发生在任何 gh 调用与落盘之前（零半成品，同"gh 薄 IO 失败零半成品"哲学）。错误文案
  指到「文件 + 行 + 格 + 期望」；SKILL.md 引导用户修正文件（或重跑
  `/setup-matt-pocock-skills` Section B）后重来。
- **文件缺失** → 落 canonical 默认并注记一行。缺失是合法常态：setup 仅在装了 `triage`
  skill 时才写该文件，且上游技能无映射表时贴的就是 canonical 字面名——落默认是如实
  而非降级。廉价诊断：开放票 label 堆里 canonical 五连零命中 → 升格警告"疑似自定义
  词表，缺 triage-labels.md"。
- **校验时点**在占坑之前（SKILL.md Preconditions 段），避免配置错误留下幻影占坑。

## Consequences

- 纯函数面新增 `parseTriageLabels(mdText)` 与参数化 `statusOf`；IO 薄层多读一个本地
  文件（缺失 / 违约分支见上）；测试按契约逐条覆盖。
- `wontfix` 的 closed 豁免走映射——它是唯一有语义特权的角色，自定义改名场景必须覆盖。
- v1 一行一 label（上游"一个角色 ↔ 一个 label 串"语义）；新旧名并存的多 label 支持
  留作 v2 扩展（读侧收多、写侧取首）。
- 本包成为 triage-labels.md 的第一个机器消费者（上游技能均为 LLM 读取）——机器契约
  以本 ADR 为准，解析错误文案即契约教材。
