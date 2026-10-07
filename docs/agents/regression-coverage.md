# 回归覆盖矩阵（regression coverage matrix）

确定性验证的事实清单：每项主体能力、每张已关闭 issue 对应哪个测试、验证层级、
关键断言与**未验证边界**。本文件随测试补齐而更新；边界列如实标注"本轮不能证明"的行为，
不把静态/脚本合同写成真实平台验收。

## 验证层级

| 层级 | 含义 |
| --- | --- |
| 单元/集成 | 纯逻辑、配置、快照、同步规划、审计（纯函数 + fixture） |
| CLI 黑盒 | 真实 Node 子进程、临时 git 仓、票文件、PATH 有状态 tracker 桩 |
| 静态合同 | SKILL/agent 定义、注册与派发约定的文本与结构护栏（**非行为证据**） |
| 包级系统 | 实际 npm tarball、隔离解包、包内 CLI、真实 git、tracker 桩 |
| 真实模型 E2E | Pi + 子代理 + 模型 + 真实 tracker——**不在本轮 CI**，另行项目 |

基线（2026-10-08，`113df1ea`）：`npm test` = 483/483 通过（macOS x86_64，Node v24.19.0，
约 205 秒）。阶段 B 补齐后：495/495（含 2 条产品缺陷回归 + 10 条包级测试）。
`test/repro-reviewer-axes.js`（真实模型探针）不在 `npm test` 与 CI 内。

## 主体功能矩阵

| 功能 | 最终需求 | 测试（文件 · 代表用例） | 层级 | 关键断言 | 未验证边界 |
| --- | --- | --- | --- | --- | --- |
| 初始化 | `init` 子命令入账、payload 与旧 `add init` 形态一致、前置核验 spec | `init-cli.test.js` · "init（local/github/gitlab 范本）"；`ledger-cli.test.js` · "init: 事件行含…" | CLI 黑盒 | 事件信封四件套（版本/序号/权威时间戳/HEAD 锚点）；缺 spec 拒绝 | 平台 settings 真实读取 |
| 流程配置冻结 | reviewer/concurrency 拉取时冻结进事件流；中途改配置不影响进行中 run；预算退役 | `init-cli.test.js` · "init 拒绝退役的 --max-fix-rounds"；`ledger-cli.test.js` · "旧 init 预算仅显示为历史无效值"；`flow-config-core.test.js` · "flowSectionFor ignores historical fix limits…" | 单元 + CLI 黑盒 | 旗标缺失按旧默认解释；旧设置只读不覆写 | 平台 settings UI 写入 |
| 原生票号 | tracker 原生编号归一化单转换点，多位号全生命周期 | `ledger-cli.test.js` · "票号空间" 6 用例 | CLI 黑盒 | 补零/拒绝面/数值排序/令牌核验同口径 | — |
| spec 引用与票集边界 | `--tickets` 冻结执法，边界外拒绝，对账盯边界 | `ledger-cli.test.js` · "票集边界" 5 用例；`tracker-set-core.test.js` · "三层解析" 系列 | 单元 + CLI 黑盒 | 中途偷加票被拒；快照票文件与事件流双向对账 | 真实 tracker 拉取不全的现场诊断 |
| 契约识别 | local/github/gitlab 三范本判型；认不出显式停下；缺 setup 产物指引 | `tracker-contract-core.test.js` · "判型" 系列、"范本认不出"；`init-cli.test.js` · "init 拒绝" 系列 | 单元 + CLI 黑盒 | 预设是数据（JSON 往返）；判型容错（正文编辑/节序/CRLF） | 其他 tracker 产品（显式不支持） |
| 词表映射 | label→canonical 五角色、closed→Status、type 来源按契约词表 | `tracker-sync-core.test.js` · "状态映射矩阵"、"类型映射" 系列 | 单元 | 改名词表参数化同口径；大小写不敏感；词表违约报错含文件+行+列+期望 | — |
| 阻塞边与快照 | 正文行与 native 边合并；快照转写逐字节确定 | `tracker-sync-core.test.js` · "阻塞映射"、"转写确定性"；`snapshot-core.test.js` · "planSnapshot" 系列；`snapshot-cli.test.js` · 13 用例 | 单元 + CLI 黑盒 | 三层定界（sub-issues→Parent 反查→init 清单）；拉取失败 best-effort 警告 | 真实 GitHub/GitLab API 形态（桩替代） |
| 工作树隔离与派发合同 | coder/reviewer/final-reviewer 派发形态、typed gate、双轴稳定 key | `self-check.test.js` · anchor-1/2/7/8、issue #6/#9 合同 + breakage 系列 | 静态合同 | 断言逐字锚点与派发块结构；破坏模拟即红 | **非行为证据**：不证明平台接受派发或子代理遵守 |
| 串行合并事实核验 | merge 前 git 交叉核对（存在/祖先/令牌/headSha） | `ledger-cli.test.js` · "merge git 交叉核对"、"merge 门" | CLI 黑盒 | 四类矛盾全拒绝；历史不变 | — |
| reviewer on/off 与批准门 | on 时无 approved 不可合并；off 语义保留 | `ledger-cli.test.js` · "reviewer=off"、"merge 门"、"最新正式裁决才是批准门" | CLI 黑盒 | 旧 approved/notes/anomaly 不覆盖后续阻塞裁决 | 真实 reviewer 裁决质量 |
| 修复编号与独立评审轮次 | fixNo 顺序尝试、评审轮次独立、同票同轮去重 | `ledger-cli.test.js` · "fix 尝试无默认配额"、"结算被拒（坏 SHA）不归零 fixNo"、"无新增 fix 可正式重评…" | CLI 黑盒 | 不以 fix 数推导轮次；非法正数拒绝 | — |
| 首轮机械报告与手跑 gate | 4 字段 JSON 报告、五条件判死、超时固定 | `mechanical-report-cli.test.js` · 17 用例；`self-check.test.js` · anchor-3/5 | CLI 黑盒 + 静态合同 | stdout 单 JSON；截断兜底；无环境旋钮后门 | 模型是否实际手跑 gate（经平台验收表单承重） |
| 未入账合并的对账与恢复 | 实际合并未记账→非零差异→验证绿→补记收尾 | `ledger-cli.test.js` · "#14 未入账合并恢复…" | CLI 黑盒 | 验证绿不隐去差异；不提前记成功；恢复后 check 归零 | 编排器自主恢复判断（合成轨迹） |
| 终审裁决与封账门 | final 三值、最新裁决为准、not_ready 拒正常完成 | `ledger-cli.test.js` · "add final" 系列、"close 门" 系列 | CLI 黑盒 | 多轮终审逐条入账；空任务运行无需 final | 真实 final-reviewer 行为 |
| 升级历史与异常区别 | 升级≠完成；anomaly 是历史；处置证据归笔记 | `ledger-cli.test.js` · "#15" 2 用例；`audit-report.test.js` · "升级后合并显示完成…"、"anomaly 是历史而非当前故障…" | CLI 黑盒 + 单元 | notes 不产生机械"已解决/已恢复"结论 | — |
| 阶段性交付 | 开放 run 保留、证据留存、只续剩余票、最终正常收尾 | `sync-cli.test.js` · "#17 阶段性交付 fixture"、"#17 续跑 fixture"；`self-check.test.js` · partial delivery 合同 | CLI 黑盒 + 静态合同 | 同步失败留 anomaly 重试幂等；原 init/已完成不变 | 模型自主执行（测试控制步骤） |
| 同步与 marker 幂等 | 只认 marker、部分失败只补缺失、同步先于封账 | `sync-marker.test.js` · 8 用例；`sync-planning-core.test.js` · 23 用例；`sync-cli.test.js` · 幂等/续作系列；`gitlab-cli.test.js` · note 先行时序 | 单元 + CLI 黑盒 | 人改写正文零重复；旧中文评论兼容；抢跑关闭只补评 | 真实 tracker 服务（桩替代） |
| 显式放弃 | 未完成票保持开放、同步成功后 abandoned 封账、封账不可逆 | `ledger-cli.test.js` · "#16" 4 用例；`sync-cli.test.js` · "sync abandon" 4 用例；`gitlab-cli.test.js` · abandon 4 用例 | CLI 黑盒 | 不补 final/escalate；拒绝面不落盘；封账后拒写 | 停止真实 child（合同覆盖） |
| 历史兼容 | 旧预算/旧 close 无 outcome/旧信封只读可读 | `ledger-cli.test.js` · "旧封账 run 的预算…"、"旧账兼容" 3 用例；`audit-report.test.js` · "旧 close 缺 outcome 不猜历史意图" | CLI 黑盒 + 单元 | 不覆写旧设置/事件；不补造历史意图 | — |
| 审计报告 | 双语、证据缺失降级、历史与当前状态分离 | `audit-report.test.js` · 34 用例（i18n 键集奇偶、lang=en、风险分级） | 单元 | 死 runRef 不衍生风险；降级不崩溃 | 平台证据探测（契约能力缺失恒 unknown） |
| 打包文件清单与包内入口 | tarball 含必需文件、不含私有/开发文件、包内引用可达 | `package-manifest.test.js` · 清单闭包/私有区排除/pi 注册面/模块图/入口烟测 5 用例；`package-system.test.js` · 5 场景 | 包级系统 | 闭包=恒附带文件+运行时目录逐文件；CJS/ESM/函数体三重加载边界各过各的检查 | 真实平台派发不受影响（与行为层边界相同） |

## 本轮揭示并修复的产品缺陷（包级回归逼出）

| 缺陷 | 症状 | 修复 | 回归测试 |
| --- | --- | --- | --- |
| 审计报告在事件缺 runId 时崩溃 | 旧记录/最小事件的 verdict 无 revRunId、fix 无 resumeRunId、dispatch 无 runId → `render.js` 崩溃（`runId.slice`） | 缺引用时渲染「运行引用未记录」卡（双语），不伪造证据 | `audit-report.test.js` · 「事件缺 runId/revRunId/resumeRunId → 运行证据卡降级」；包级场景 5 |
| 仅升级未派发的票从审计票清单消失 | `escalate` 是唯一不注册票条目的票级事件 → 该票升级历史永远渲染不出 | `collect` 的 escalate 同样注册票条目 | `audit-report.test.js` · 「仅升级未派发的票进票清单」；包级场景 5 票 02 |

观察到但本轮未改的边界（如实保留，待决策）：**完全未被事件触及的票文件**（无任何事件的未开工票）
不在审计报告的票清单里（台账票表会显示）。放弃 run 的报告因此可能少列从未派发的未完成票。
改动会影响报告语义面（票清单 = 事件触及 ∪ 票文件），待用户裁定。

## 已关闭 issue 矩阵

| Issue | 回归目标/最终决定 | 测试 | 层级 | 关键断言 | 证据限制 |
| --- | --- | --- | --- | --- | --- |
| #6 | blocking 双轴、稳定 key、两轴完成后才返回 | `self-check.test.js` · "axis-spawn contract" + breakage 2 用例 | 静态合同 | `async: false` + `key: standards/spec` 逐字在位 | 不证明真实 reviewer 时序/生命周期 |
| #7 | retained resume/fallback 的 acceptance 合同、手跑 gate | `self-check.test.js` · anchor-9 + breakage 10 用例 | 静态合同 | `acceptance: false` 无 gate；禁令回流即红 | 不验证真实平台 resume |
| #8 | 新英文评论、旧中文事实识别、marker 幂等 | `sync-cli.test.js` · "sync 跨语言兼容"；`sync-read-core.test.js` · "Merged (merge SHA…"、"Escalated:"；`sync-planning-core.test.js` · "旧版中文同步评论…" | CLI 黑盒 + 单元 | 新旧两套写法同捕获；只认 marker 判重 | tracker 是桩，非服务验收 |
| #9 | 文件派发约定、新旧审计记录读取 | `self-check.test.js` · "dispatch delivery" + breakage 3 用例；`audit-report.test.js` · "extractBriefs 文件路径形态" 2 用例 | 静态合同 + 单元 | 脚本文件缺失优雅降级不产假任务书 | 不证明真实平台接受文件派发 |
| #10 | `not_planned`（可配置评论语言未实施） | 无（不造承诺） | — | — | 同步评论固定英文是唯一形态；语言配置明确不在范围 |
| #11 | 撤回 finding≠批准；无伪造 fix 的完整重评后可合并 | `ledger-cli.test.js` · notes 澄清/撤回 2 用例；`audit-report.test.js` · "单问题撤回 prose 不成为完整批准"；`self-check.test.js` · "formal review rounds are independent…" | CLI 黑盒 + 单元 + 静态合同 | 撤回后仍待完整重评；批准门看最新完整裁决 | 按 #12 替代设计，不恢复原预算方案 |
| #12 | 总体需求索引 | 本矩阵 #13–#17 各行 | — | 子票覆盖逐项可溯 | 不造单一不可诊断大测试 |
| #13 | 去有效配额、独立轮次、重复裁决拒绝、当前批准门 | `ledger-cli.test.js` · "fix 尝试无默认配额"、"独立轮次…"、"同票同轮 verdict 仍去重"、"最新正式裁决才是批准门" | CLI 黑盒 | 第 3、4 次修复照常；同轮重复拒绝 | 区分 CLI 执法与编排选择（后者属 SKILL 合同） |
| #14 | 集成/终审恢复、非零差异保留、验证先于记成功 | `ledger-cli.test.js` · "#14 未入账合并恢复…"；`sync-cli.test.js` · "#17 续跑 fixture" | CLI 黑盒 | 验证绿不隐去差异；补记后 check 归零 | 模型恢复策略只查合同（`self-check.test.js` reconciliation 合同） |
| #15 | 升级后合并为 done、历史保留、异常不冒充当前故障 | `ledger-cli.test.js` · "#15" 2 用例；`audit-report.test.js` · 升级/anomaly 3 用例 | CLI 黑盒 + 单元 | 升级原因与合并依据都保留 | 不从笔记产生"已授权/已解决"机械事实 |
| #16 | 显式 abandoned、同步失败不封账、封账后拒写 | `ledger-cli.test.js` · "#16" 4 用例；`sync-cli.test.js` · abandon 4 用例；`gitlab-cli.test.js` · abandon 4 用例 | CLI 黑盒 | 未完成票保持开放；重试幂等；封账拒一切写 | 停止真实 child 本轮仅合同覆盖 |
| #17 | 部分阶段不 sync/ready/close、留存后继续 C、最终正常收尾 | `sync-cli.test.js` · "#17" 2 用例；`self-check.test.js` · partial delivery 4 用例 | CLI 黑盒 + 静态合同 | 开放 run 与延迟快照保留；只续剩余票 | CLI 合成轨迹≠模型自主执行 |

## 缺口分类（阶段 A 结论；阶段 B 已关闭）

**已补齐（阶段 B）：**

1. **打包文件清单（tarball 面）**：`test/package-manifest.test.js` —— 闭包对照（恒附带文件 +
   运行时目录逐文件，无多无少）、私有区/草稿排除、pi 注册面包内可解析、CJS 模块图可达、
   CLI 帮助/只读入口可启动、三重加载边界（CJS --check / ESM .mjs / async 函数体）。
2. **包级系统回归**：`test/package-system.test.js` —— 5 个独立场景（正常 local run / 修复与评审
   独立兼旧预算兼容 / 远端契约桩同步幂等 / abandoned / 旧记录 build-check 与审计），被测入口
   全部来自 `npm pack` 解包目录（`MATT_IMPLEMENT_LEDGER` 注入，测试专用开关）。

**本轮不能证明（如实保留，不造绿）：**

- 模型遵守 prompt、真实 pi-subagents 接受派发调用（#6/#7/#9 的静态合同不是行为证据）。
- 真实 GitHub/GitLab 服务的 tracker 写入与权限（桩是协议形状，不是服务验收）。
- 真实模型 E2E 与子代理现场验收（`test/repro-reviewer-axes.js` 留在 CI 之外）。
- issue #18（pi-subagents 最低版本）不属本轮修复，也不借 CI 宣称平台兼容性已验证。

**已覆盖、不再重复造测试：** 同步重试/幂等矩阵、票号空间、契约判型容错、审计降级路径
均已有黑盒或单元断言；abandon 全轨迹由 `#16` 封账用例 + sync abandon 用例分段覆盖，
完整串联在包级场景 4 复验（不另造第三份源码级轨迹）。
