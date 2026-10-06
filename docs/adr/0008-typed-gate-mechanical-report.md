# ADR-0008: 派发形态——typed gate 机械产报告，模型不再手写报告

- **Status:** accepted（已实现落地：`scripts/mechanical-report.js` 为合同真源，
  SKILL.md 派发/修复轮/简报节、`agents/coder.md`、self-check 断锚组随之切换）
- **Date:** 2026-09-29
- **Deciders:** 本包维护者（经 spec 会审定稿）
- **Context tags:** dispatch, gate, mechanical-report, acceptance-contract, anti-overconfidence

> **后续调整：** [ADR-0009](0009-prompt-driven-repair-and-run-continuation.md)（spec #12）。
> 仅替代 Decision 6 的集成/终审连红两次强制停止；typed gate、机械报告、retained resume 手跑门禁及补记二负空间裁定仍有效。
> 以下保留本 ADR 当时的决策与理由，不覆写历史解释。

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

## 补记（2026-10-03，issue #7）：平台验收契约的三条事实

0.3.0 实跑暴露修复轮假死：修复已提交、手跑门禁已过，run 却以
「Structured acceptance report not found」判死。复盘平台（pi-subagents）验收面，
三条契约事实决定修法（均已对照平台源码核实）：

1. **gate 归一化 ≠ 免除 attestation 报告义务**。`gate` 对象等价于显式
   `acceptance: { level: "verified", verify: [...] }`——验收级别提升，但孩子交回
   「结构化验收表单」（fenced `acceptance-report`）的义务仍在；表单缺失时 run 立即
   `rejected`，**后续证据核查与 gate 均不执行**（验收台账 `verifyRuns: []`）。
   Decision 第 4 条的「退出码即判定」只有在表单义务被满足或被免除之后才轮得到退出码。
2. **retained resume 保留验收契约但拒收 gate**。resume 复用首轮孩子的契约
   （含 `acceptance`），而 `gate` 在 resume 上被平台直接拒收。于是修复轮 resume 继承了
   `verified` + 报告义务，与「模型不产报告」的裁定叠加即必然拒绝——这正是本补记的起因。
3. **`acceptance: false` 与 gate 同传视为省略**。gate 在场时平台直接剥掉
   `acceptance: false` 再归一化出 `verified`，该写法**不能**用于 gate 派发除险；
   它只在无 gate 的派发（read-only reviewer、修复轮 resume、完整性兜底 fresh coder）上生效。

裁定随之落定（SKILL.md / 简报 / coder 定义同步改，self-check 断锚组钉死形态）：

- **修复轮 resume 与完整性兜底 fresh coder 一律 `acceptance: false`**，该轮判定只剩
  编排者手跑的机械报告门禁（第 6 条不变）；兜底 fresh coder **不挂 gate**——gate 会
  重新武装报告义务，正是本 bug 的死因。「报告找不到」式拒绝在结构上不可能复发。
- **报告职责二分措辞**：模型不写**工作报告**（改了什么/为什么/残余风险自评等主观内容，
  第 2~3 条的禁区不变），但平台 system prompt 若要求 fenced `acceptance-report` 表单，
  **必须如实填写（只含机械事实）**——表单是平台机制件而非工作报告，表单义务优先于
  「无报告职责」句。首轮 gate 派发同样受益：通过不再依赖模型在两句冲突指令间的裁决方差。
  五套简报中评审简报只带表单义务句：评审者的产出即发现散文，「不写工作报告」一侧只约束
  产工作报告的文本（coder、集成/终审修复简报与 coder 定义）。

## 补记二（2026-10-03，issue #7 续）：负空间裁定——简报里不设报告禁令

**取代补记一末条「报告职责二分措辞」**（其余各条不变）。

- **背景**：补记一落地后仍保留双指令结构（「不写工作报告」+「表单义务优先」）。优先句
  是补丁——模型仍要在两句间裁决，冲突只是被调停而非消失；且表单义务句复述平台行为，
  平台演进即漂移（code-review Standards 轴 P2）。
- **裁定（负空间）**：简报与 coder agent 定义**不设报告禁令**，也不复述平台表单义务——
  **报告职责单源归平台 system prompt**。理由：本流程承重输出全走结构化通道（git 真相、
  手跑门禁、context pointer、评审结构化 verdict），散文报告无机械消费者；禁令唯一作用是
  省 token，代价是指令冲突类 bug（#7 一类的死因）。平台要表单时模型自然照填，无竞争指令。
- **边界（机制化）**：断锚 4 反向钉死三个禁令短语不回流（No work reports / No
  handwritten reports / No report duties，任意大小写）与表单义务复述句（识别句 "that duty
  comes first"），同时钉死砍禁令的边界——修复简报的裁决来源事实句（"hand-runs the gate
  for this round"，防模型自封门禁）与两句承重收尾语（"by context pointer" 逐简报钉死、
  "a dirty tree or an empty diff fails the gate"）。breakage simulation：禁令或复述句回流
  任一文本 → 红；任一边界句（含单套简报的 SHA 报告句）丢失 → 红；简报模板丢失 → 红。
- **保留的隐性承重点**：首轮 dispatch 的门禁证据链经过平台表单（补记一事实①，不变）。
  砍禁令后该依赖由平台 system prompt 自证（表单要求平台自己会注入），本包不得复述；
  若未来平台取消该要求而门禁仍依赖表单，回到补记一事实①重审派发形态。
