# ADR-0008: 派发形态——typed gate 机械产报告，模型不再手写报告

- **Status:** accepted（已实现落地：`scripts/mechanical-report.js` 为合同真源，
  SKILL.md 派发/修复轮/简报节、`agents/coder.md`、self-check 断锚组随之切换）
- **Date:** 2026-09-29
- **Deciders:** 本包维护者（经 spec 会审定稿）
- **Context tags:** dispatch, gate, mechanical-report, acceptance-contract, anti-overconfidence

## Context

2026-09 的一次 feature run 里，两票 coder run 被平台验收拒绝：模型在最后一次
`structured_output` 调用里把嵌套对象 JSON 双编码，自纠重试后报文又丢了
`testsAddedOrUpdated` 字段——缺失字段只在结算时查处，run 判死，只能靠"git 真相裁决"兜底。

事故是结构性的，不是偶发手抖。报告的生产权在模型手里：格式错误、字段缺失、双编码
都可能发生，而验收是 fail-closed 的，一次失手 = 整轮 coder 时间报废。现行报告合同
12 字段横跨双通道（`value` + `acceptanceReport`），其中夹着 `residualRisks`、
`seams`、`criteriaSatisfied` 等**主观自述字段**——它们即使没写错也不可信
（coder 自评"无风险"≠真的没风险），却会进入评审视野造成假信心，抬高下游理解成本。

## Decision

**把报告生产权从模型手里拿走，落到机械报告**：派发票据 coder 时用 typed gate——
一条宿主侧命令在孩子结束后于其 worktree 内执行，git 事实 + 实跑测试输出经一个
Node 脚本机械组装成 JSON 报告，stdout 即结构化输出，**退出码即验收判定**，
模型全程不参与报告。

1. **机械报告脚本，唯一职责**：git 事实 + 实跑测试输出 → 报告 JSON。多语言无关
   （`--test-command` 不透明透传，shell 执行，多词/管道皆可）；参数仅 `--base`
   （票基点）与 `--test-command`。脚本模块导出即合同真源（字段表 + schema，
   附 `--print-schema` 自描述），编排文档里的 schema 副本须与之逐字一致
   （self-check 交叉比对，漂移即红）。
2. **报告合同收敛为 4 字段单通道、全 required**：`headSha`（git 机械提取）、
   `testResult`（单行摘要：测试命令 + 退出码 + 输出末行 verbatim）、`changedFiles`
   （相对票基点的 name-only 清单原样）、`validationOutput`（测试输出尾部 ≤10 行
   非空 verbatim 关键行）。零主观、零猜测、零 glob 派生。
3. **旧字段去向**：`criteriaSatisfied` / `residualRisks` / `seams`（主观自述，删除，
   判断归评审者）；`commits` / `branch` / `commandsRun`（可派生或近似常量，删除）；
   `noStagedFiles`（恒真陷阱——gate 通过必为 true，检查保留在退出码里）；
   `testsAddedOrUpdated`（派生 + 模糊，删除，见被否方案）。
4. **退出码即判定**：测试命令非零或超时、测试输出为空、存在 staged 或未提交改动、
   相对基点无任何改动、git 事实提取失败——五条件任一成立即非零拒绝。**不**判死：
   无测试文件变更（该不该写测试是判断题，归评审者）；超长输出截断打标记而非判死。
5. **派发形态**：coder 派发携带 typed gate 对象（脚本命令 + JSON 输出声明 + 4 字段
   schema + 显式长超时），gate 通过后的 stdout 成为结构化输出。平台互斥铁律：
   gate 与 `acceptance` 对象、`outputSchema` 三选一，coder 派发不再出现后两者。
6. **修复轮同一判定标准**：resume 上 gate 被平台拒绝，故编排者在 coder 保留
   worktree 手跑**同一条完整脚本命令**——stdout 即该轮报告、退出码即该轮 gate，
   台账 `settled` 的门禁摘要取自新报告的 `testResult`，与首轮同源；修复简报只剩
   "修、重跑套件、提交"，零报告职责。无隔离修复者（集成修复者 / 终审修复者）挂
   纯判定 gate（只有测试命令、无输出/schema，零报告因为零消费者）；连红 2 次停下
   升级给用户。
7. **台账语义不动**：账本/事件流唯一写者仍是台账脚本；`settled` 事件的门禁摘要
   来源变为脚本 JSON 的 `testResult` 一行，字段语义不变。

## 被否的方案（留给未来会话不再争论）

- **方案 C：保留 `structured_output`，只给模型减负**（精简字段、放宽校验、重试
  兜底）：生产权仍在模型手里，双编码/丢字段的失效模式一个不少——2026-09 事故
  证明这正是要根除的结构性风险。用概率机制修补概率机制的已知失效模式，不选。
- **report.json 叙述字段混合**（机械事实 + 模型自述同文件，"advisory 仅供参考"）：
  自述即使标注 advisory 也会进入评审视野成为锚定源——"无残余风险"六个字一旦落盘，
  评审者就得多花一次注意力证伪它。负价值字段不值得一个通道。弃。
- **`testsAddedOrUpdated` glob 派生**（按文件通配符猜测"新增/更新的测试"）：
  唯一"派生 + 模糊"字段——glob 误匹配/漏匹配无解（改名、移目录、fixture  shared
  helper 都不在通配符语义里），而下游零消费者（评审者看全量 diff，不看这个清单）。
  派生成本换零消费，且"一行测试没动"本就是留给评审者的判断题。删。

## Consequences

- 双编码/丢字段类验收事故在结构上不可能复发：报告的唯一生产路径不经过模型注意力。
- 主观判断整体移交给 code-reviewer：评审者看全量 diff 的判断力，恰好是机械规则
  给不了的；报告里剩下的每一项评审者都可以信任为机械事实。
- 脚本成为承重件：正确性由真 git 仓库夹具上的 CLI 黑盒测试守护（五条拒绝条件、
  字段值来源、截断标记全覆盖），提示词漂移由 self-check 断锚组钉死
  （派发块须为 gate 形态、schema 副本逐字一致、fix loop 须为手跑脚本语义）。
- 代价：coder 派发多一次实跑测试命令的耗时（显式长超时）；gate 红的修复轮需要
  编排者手跑脚本而非自动 resume——接受这个代价，换取"测试跑过"从自述变成退出码事实。
