# ADR-0003: tracker 快照与封账前单点同步——锁实时、进度延迟

- **Status:** accepted
- **Date:** 2026-09-24
- **Deciders:** 本包维护者（经 brainstorm 会话定稿）
- **Context tags:** tracker, snapshot, sync, run-continuation, matt-principle

## Context

为 GitHub tracker 提供一等公民支持，读写路径面临真实取舍：读侧有 gh 直读零落盘、每轮
review 现拉快照、init 全量拉取三条路；写侧有逐票实时同步与封账批量同步两条路。约束
条件互相拉扯：

1. **只读子代理读不了网络**：final-reviewer 明文无 bash，reviewer 的 axis child 是纯
   read 工具——它们的输入传输面只能是本地文件（review bundle 按同一先例落盘）。
2. **账本脚本假设本地文件**：`init` 的 spec 有 fileExists 硬校验，票集枚举按
   `dirname(spec)/issues/` 约定——换成 gh 枚举器意味着账本按 tracker 形态分叉。
3. **封账后事件流拒写**（既有硬约束）：任何放在封账之后的动作失败即无从记账，
   连 `anomaly` 都写不进。
4. **Matt 原则**：spec/ticket 不得成为仓库里过期的第二真相源（不入仓库、不进检索面、
   不长期存活）。

## Decision

**读路径统一 local，写回单点延迟：锁实时、进度延迟。**

1. **init 全量拉取转写为 tracker 快照**：spec 与全部工单在 run 初始化时拉入运行时目录，
   转写为与 local tracker 票文件同构的格式（Status/Type/Blocked by 行）。此后编排器、
   coder、账本、reviewer、final-reviewer 五方一律按 local 路径读写，账本脚本零形态
   分叉（枚举、封账豁免、对账全部复用本地逻辑）。
2. **状态写入也落在快照**：合并改 `Status: resolved`、认领写 `Status: claimed`，与
   local 模式完全一致。快照是待推送的真相，tracker 本体是延迟镜像。
3. **锁实时、进度延迟**：占坑（spec 级并发锁）是 run 的第一个写动作，实时上
   tracker——延迟的锁等于没有锁；关票/评论等进度同步则攒到封账前单点批量推送
   （同步），幂等可重入（已关→补评论；未关→close+评论）。
4. **同步发生在封账之前**，且在 `pr --state ready` 之前——既避开封账拒写的硬伤，
   又消解 PR closing keywords 抢先关票的竞态（同步时票已关，keywords 全部 no-op）。
5. **运行时文件三分、清理各归其类**：tracker 快照是第三类而非传输件，同步成功后
   清理（先同步后删）；review bundle 用后即弃，随之清理；findings 留存（事件流引用
   其路径）；账本三件套长存。

## Considered Options

- **gh 直读零落盘**：字面最纯，被只读子代理的能力边界否决——除非给审查者开口子拿
  网络工具（动安全/职责边界，成本高）。
- **每轮 review 现拉快照**：保鲜最强，但 brief 路径规则按 tracker 形态分叉、每轮一次
  物化动作，被统一路径的实现成本优势压倒。
- **逐票实时同步（形态 2）**：GitHub 全程真实、崩溃零丢失，但 gh 失败面散进每票流程；
  在单人 AFK 场景下实时性收益弱，弃。
- **封账后同步**：被封账拒写硬伤直接否决（同步失败无从记账，账实静默裂开）。

## Consequences

- run 期间 tracker 本体状态滞后（open、无痕迹）：单人 AFK 场景可接受；多人协作仓库
  是已知代价，占坑是唯一的并发可见信号。
- 崩溃/放弃的真相在本地账本+快照：续跑以 `build`+`check` 重建，**不重拉**（重拉会用
  tracker 的滞后状态覆盖本地真相）；放弃路径的同步须撤占坑并留评。
- 「对账」的真相层中"票文件 Status"指快照票文件；tracker 本体不在真相层内。
