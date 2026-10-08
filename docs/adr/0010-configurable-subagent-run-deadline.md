# ADR-0010: 可配置的子代理运行时限——默认 4 小时、派发时新读、不冻结进流程形态

- **Status:** accepted（issue #26 维护者确认需求；本 ADR 记录设计取舍）
- **Date:** 2026-10-09
- **Deciders:** 本包维护者（issue #26「已确认需求」及 Agent Brief 确认默认值、配置面与边界）
- **Context tags:** run-deadline, timeout, dispatch, flow-config, resume

把三个专用子代理（coder / reviewer / final-reviewer）的单次运行死线从固定 1 小时改为
默认 4 小时并可配置；配置值在每次**新派发**时重读并作为派发参数传给平台。明确不做：
取消硬超时、修改已启动子代理的截止时间、超时后自动恢复、推动 pi-subagents 上游扩合同。

## Context

14 天观察窗内有 3 个 coder 运行触达固定 1 小时上限而被终止（一单项目一张票 + 另一
项目同波次两张票）；运行仍有合理进展，终止后必须等用户手动要求接续，阻断了本可继续
的实现。用户的裁定：同样的工作还要继续时，固定硬超时加人工恢复只制造中断。

只读调研（pi-subagents 0.76.1 随包文档与源码）结论：

- 单个子代理没有公开的「无运行超时」合同；省略时限回退默认（前台与单代理异步 30 分钟）。
- 派发参数 `timeoutMs` / `maxRuntimeMs` 要求正整数，上限 2147483647（Node 定时器上限）；
  0 / false / 负值 / Infinity 均不能代表无限。
- 单代理派发的时限优先级：派发级 `timeoutMs` > agent frontmatter `timeoutMs`
  （`defaultTimeoutMs`）> 全局 `config.timeoutMs` > 30 分钟兜底（`applySingleAgentLaunchDefaults`
  / `resolveSingleAgentLaunchTimeout`）。
- retained resume 沿用保留子代理的合同（`gate` 被拒收、模型/工具合同沿用存档）；暂停 run
  的恢复按存档的绝对死线只给余量（`remainingSteeringRecoveryLimits`，余量耗尽即拒绝接续）。
- 代理管理面的 `config.timeoutMs: false` 只删除代理默认值，不禁用运行超时。

## Decision

### 1. 默认 4 小时，配置键是本包私有的 `mattImplementFlow.agentTimeoutMs`

三个 agent frontmatter 统一 `timeoutMs: 14400000`，与配置默认值同口径（单一常量
`AGENT_TIMEOUT_MS`）。覆盖键放在本包自定义节内，与流程开关同居一处但**不**进流程形态：
单位毫秒，一个值共享三个角色（简单、明确，不做按角色的通用超时系统）。

### 2. 生效时机 = 每次新派发重读，不冻结进 init 旗标

流程开关（reviewer / maxConcurrent）在 init 时冻结进台账；运行时限刻意排除在外：
编排器在每次派发前运行 `scripts/flow-config-cli.js run-timeout` 取当前生效值，写进派发
脚本的 `const RUN_TIMEOUT_MS = …`，并作为 `timeoutMs` 参数传给每一个 `runs.run` /
`runs.all` 条目（逐票 coder、逐票评审、终审、集成 / 终审 fixer、修复兜底 fresh coder）。
这样同一未封账 run 中从 A 改到 B，下一次派发即用 B，无需重新 init。

选派发参数而不是 `subagents.agentOverrides.timeoutMs`：后者不假定有效（调研裁定），
派发级 `timeoutMs` 是平台明文支持且优先级最高的合同面。

### 3. 校验镜像平台合同，非法值不写入、不放大成无限

`normalizeRunTimeoutMs` 只接受 `[1, 2147483647]` 内的正整数毫秒；向导按分钟输入、按
换算后的毫秒值校验，非法输入给出明确提示且不写入。手写坏值在解析时忽略并列入
`invalid`（show 视图提示），回退下一层 / 默认值——0 或 false 永不解释为「无死线」。

### 4. 边界保持独立，retained resume 不动

命令超时、测试门禁超时（`gate.timeoutMs: 600000` 固定值）、并发上限、用户取消与人工
暂停能力不变。已启动子代理的截止时间不可改；修复轮的 retained resume 保持平台既有
合同，派发脚本**不**携带 `RUN_TIMEOUT_MS`——接续不是新派发，也不把接续冒充新派发。
双轴评审内部的两个 axis 子代理（axis-axes.js 的嵌套 fan-out）沿用包默认值（4 小时），
不走本配置：需求的路径清单未列它们，沿链路（brief → reviewer → axis 调用）再传一层
只会扩大提示词面；如需覆盖，另开小票核验平台对嵌套子代的时限语义后再做。
不增加超时后自动恢复、停滞检测或恢复状态机。

## Consequences

- 长任务被过早中断的频率显著下降，但不保证任何任务在 4 小时内完成，也不保证总时间
  或费用有限；硬超时仍在。
- 派发模板里的 `RUN_TIMEOUT_MS` 靠编排器替换为新读值；替换指针（解析 CLI 的调用行）
  与 `timeoutMs: RUN_TIMEOUT_MS` 由注册自检（`checkDispatchRunDeadlines`）钉进测试，
  漂移即红，但「运行时确实替换了」仍属提示词纪律，不是机械保证。
- retained resume 不享受配置的新值：它继续按平台保留合同运行。这是有意的边界（不改
  合同、不冒充新派发）；若未来要给接续也配死线，需另行决策并核验平台 resume 的时限语义。
- axis 子代理同样不享受配置的新值（见 Decision 4）；用户把时限调到 4 小时以上时，
  评审内部的两个只读 axis 仍是 4 小时。典型评审远低于此，风险低，但不是零。
- 手改 settings 写坏值不会阻塞 run：解析回退默认并在 show 视图提示，向导是唯一常规
  写入口。
