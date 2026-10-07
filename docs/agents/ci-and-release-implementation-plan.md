# CI 与版本发布实施计划

## 1. 新 session 接续入口

本文件记录用户已确认的方向，供下一次 session 实施。先重新读取仓库指令和当前状态，再按阶段推进。

- 仓库：`toomanyopenfiles/pi-matt-implement-flow`，公开仓库。
- 本计划编写时，本地与远端 `main` 为 `113df1ea262f23cf3a541476897475198ea83cfe`。
- PR #19 已合并；本地与远端 `implement/spec-12-prompt-driven` 已删除。
- 实现工作树已清理；保留的 `pi-subagents/*` 本地历史分支不属于本次必须清理项。
- 当前包版本为 `0.3.1`，新功能在 `CHANGELOG.md` 的 `Unreleased` 中。
- 本地验收归档：`.pi/matt-implement/spec12-acceptance/`，保持私有、保留，不上传 CI。
- 归档证明旧候选 `cc37d385` 的测试为 483/483；不能代替新发布候选的验证。
- 当前未建立 Actions workflow、CI 必需检查或自动发布门。
- 本文件是计划，不代表用户已经授权 npm 发布、创建正式 Release、修改账户权限或产生费用。

### 首次操作

1. 读取 `AGENTS.md`、`CONTEXT.md`、`CONTRIBUTING.md` 和 `docs/agents/issue-tracker.md`。
2. 涉及 pi 平台集成时，按全局指令读取对应的 pi 官方本地文档；本轮无需改平台集成接口。
3. 检查 `git status`、当前分支、远端 HEAD、`package.json`、现有测试与 `.github/workflows/`。
4. 核对本计划中的快照事实，记录变化，不覆盖用户已有修改。
5. 用户在新 session 明确要求开始实施后，在功能分支工作，通过 PR 接入 `main`。

**完成标准：** 能明确指出实施基线、工作区状态和与本计划的差异。

## 2. 已确认的范围与边界

### 本轮实施

- 建立 GitHub Actions CI。
- 运行现有单元、集成、CLI 黑盒和静态约定测试。
- 补充无模型调用的稳定系统回归，重点验证实际 npm 包。
- 建立主体功能及所有已关闭 issue 的回归矩阵，补齐确定性覆盖缺口。
- 建立验证成功后才允许发布的候选版本发布流程。
- 删除中英 README 安装章节中“可选运行 npm test”的说明；保留贡献文档中的源码测试说明。
- 为下一版本准备版本号、Changelog 和发布说明。

### 本轮不实施

- 真实模型 E2E、Pi 子代理完整现场验收和真实远端 tracker 写入。
- GitHub/GitLab 沙箱、模型 API 凭证、模型费用或新的生产测试钩子。
- issue #18 的修复。它另行跟进；本次 Release 不提及、链接或暗示它已解决。
- #10 的可配置 tracker 评论语言；该 issue 以 `not_planned` 关闭。
- 旧事件迁移、用户历史设置改写、已封账 run 重开。
- 发布资源政策、平台 workflow API 升级或实现新的编排状态引擎。
- 擅自删除本地历史分支和私有验收归档。

### 测试保证边界

确定性 CI 验证代码、真实 CLI/git、tracker 桩和文本合同。它不能证明模型实际遵守 prompt，也不能证明当前 pi-subagents 接受派发调用。

#6/#7/#9 的静态合同护栏不能标成真实平台回归通过。若测试揭示既有问题，如实报告；不削弱断言或以跳过制造绿色结果。#18 不纳入本轮修复，也不借 CI 把未验证的平台兼容性写成已验证。

## 3. 技术方案

### 测试分层

| 层级 | 输入与执行 | 本轮目标 |
|---|---|---|
| 单元/集成 | 纯逻辑、配置、快照、同步规划、审计 | 复用现有测试并补实际缺口 |
| CLI 黑盒 | 真实 Node 子进程、临时 git 仓、票文件、PATH tracker 桩 | 覆盖协议、失败恢复、幂等与兼容 |
| 静态合同 | SKILL、agent 定义、注册与派发约定 | 防止已确认约定回退，注明非行为证据 |
| 包级系统回归 | 实际 tarball、隔离解包目录、包内 CLI、真实 git、tracker 桩 | 发现漏打包、引用错误和跨入口失配 |
| 真实模型/服务 E2E | Pi、子代理、模型、真实 tracker | 后续独立项目，不在本轮 CI 中运行 |

现有 `npm test` 已混合前三层，不应把全部测试重命名为单元测试。`test/repro-reviewer-axes.js` 涉及真实模型，继续留在默认 CI 之外。

### Runner 与运行时

- 使用标准 GitHub-hosted runners，不使用 self-hosted 或 larger runners。
- 建议初版采用 `ubuntu-24.04`、`macos-15` 和 Node 24；实施时确认标签可用性及实际架构。
- 这是建议，不等于已经验证的最低 Node 版本或全部架构支持承诺。
- runner 在 GitHub 远端分配，本地 macOS 无需安装 Linux、Docker 或虚拟机。
- 明确 Node 主版本，记录 Node/npm/git、OS 和 runner 架构，避免从本地环境继承隐性假设。
- 当前仓库无 lockfile、无构建步骤，现有测试无需依赖安装；不照搬 `npm ci` 模板。
- 若新增开发依赖，先论证必要性；如决定引入，纳入 lockfile 并更新可复现安装步骤。

## 4. 阶段 A：覆盖审计与测试基线

### A1. 建立回归矩阵

建议创建 `docs/agents/regression-coverage.md`。每行包含：功能/issue、最终需求、测试文件和测试名、验证层级、关键断言、未验证边界。

矩阵不是只列文件名。检查测试是否断言了可观察行为，以及失败/重试/兼容路径。

### 主体功能清单

- 初始化、流程配置冻结、原生票号、spec 引用和票集边界。
- local/github/gitlab 契约识别、词表映射、阻塞边与快照。
- 工作树隔离、派发和双轴评审的静态合同；串行合并的事实核验。
- reviewer on/off、正式批准门、修复编号和独立评审轮次。
- 首轮机械报告、手跑修复 gate、候选提交与测试事实。
- 实际合并但未入账时的非零对账、集成恢复后的正确收尾。
- final 最新裁决、正常完成拒绝 not_ready。
- 升级历史与合并后当前完成状态；异常与处置证据的区别。
- 阶段性交付开放状态/证据留存、只续剩余票的受控 CLI 轨迹。
- 同步评论、marker 幂等、部分失败后只补缺失动作。
- 显式放弃、未完成票保持开放、合法输入/初始化/封账不可逆性。
- 历史事件/预算/无 outcome close 的只读兼容。
- 审计报告的双语、证据缺失降级和历史与当前状态。
- 打包文件清单、包内入口和运行引用。

### 已关闭 issue 清单（实施时重新查询）

| Issue | 回归目标/最终决定 | 证据限制 |
|---|---|---|
| #6 | blocking 双轴、稳定 key、两轴完成后才能正式返回 | 静态/脚本合同不能代替真实 reviewer 时序 |
| #7 | retained resume/fallback 的 acceptance 合同、修复手跑 gate | 本轮不验证真实平台 resume |
| #8 | 新英文评论、旧中文事实识别、marker 幂等 | tracker 使用桩，不是服务验收 |
| #9 | 文件派发约定、新旧审计记录读取 | 本轮不证明真实平台接受文件调用 |
| #10 | `not_planned`，记录未实施边界 | 不要求实现语言配置 |
| #11 | 撤回 finding 不等于批准；无伪造 fix 的完整重评后可合并 | 按 #12 的替代设计，不恢复原预算方案 |
| #12 | 总体需求索引 | 引用子票覆盖，不造一个不可诊断的大测试 |
| #13 | 去有效配额、独立轮次、重复裁决拒绝、当前批准门 | 区分 CLI 与编排选择 |
| #14 | 集成/终审恢复、非零差异保留、验证先于记成功 | 模型策略只检查合同 |
| #15 | 升级后合并为 done、历史保留、异常不冒充当前故障 | 不解析笔记产生授权/已解决事实 |
| #16 | 显式 abandoned、同步失败不封账、封账后拒写 | 停止真实 child 本轮仅合同覆盖 |
| #17 | 部分阶段不 sync/ready/close，留存后继续 C，最终正常收尾 | CLI 合成轨迹不是模型自主执行 |

### A2. 运行并记录基线

- 运行现有 `npm test`，保存退出码和总计。
- 读取主要测试实现，不只采信测试标题和旧报告。
- 分类已有覆盖、真正缺口与本轮无法证明的行为。
- 不为追求 issue 数量重复测试已覆盖的路径。

**完成标准：** 每项主体能力和每张闭票都有可追溯分类；基线结果明确；未验证边界可见。

## 5. 阶段 B：确定性测试补齐与包级系统回归

### B1. 先补行为缺口

对阶段 A 确认的缺口，沿用既有 Node 测试、临时 git 与 stateful PATH stub 方式。共享 helper 仅提取真实重复，不建设测试专用编排器。

覆盖成功、拒绝、重试和旧记录兼容。对失败测试先确认是产品问题还是 Linux/macOS fixture 差异，不直接更改预期放行。

### B2. 包清单检查

使用真实 `npm pack`，把 tarball 放在仓库外的临时目录，避免工作区脏文件。

检查：

- 包名、版本、必需脚本、agents、extensions、audit-report 和 README 两种语言存在。
- 不包含 `.pi/`、`.scratch/`、私有验收档案、凭证、测试及开发草稿。
- 包内模块和静态资源引用可达；兼顾 CJS 脚本与 ESM 扩展加载边界，不粗暴 require 所有文件。
- 无需平台实例的 CLI 帮助和只读入口可以启动。
- 必需的运行文件不能仅存在于源码 checkout。

### B3. 包级代表场景

从 tarball 解包后的路径调用真实包内脚本，不从仓库 `scripts/` 偷取生产入口。fixture/helper 可以来自测试源码；被测代码必须来自包。

至少覆盖：

1. 正常 local run：初始化、合法事件、真实 git 合并事实、终审、completed、封账后拒写。
2. 修复/正式评审独立与旧预算兼容：保留历史，完整批准门不退化。
3. 远端契约桩：快照/同步、失败重试、marker 幂等，完整完成状态与 stub 一致。
4. abandoned：未完成票开放、必要动作成功后封账、非法输入/未初始化仍拒绝。
5. 旧记录 build/check 与审计输出：unknown outcome、不补写历史、引用可达。

分成独立可诊断场景。通过测试控制步骤，不声称模拟模型判断。所有子进程设超时，临时资源在成功和失败时都清理。

### B4. 测试入口

保持 `npm test` 的现有全套语义。可新增 `test:system`/`test:package` 等入口，名称以实际职责为准。

确定包级测试是否进入默认套件，或单独作为 CI 必需任务。避免同一 expensive suite 在一次 workflow 中无意重复运行。

**完成标准：** 补齐确定性缺口；实际 tarball 通过系统回归；无模型/真实 tracker 调用；失败证据可定位。

## 6. 阶段 C：CI workflow

建议新增 `.github/workflows/ci.yml`，共用明确的验证入口，避免在 YAML 中复制复杂测试逻辑。

### 触发与不阻塞语义

- `pull_request`：opened、synchronize、reopened；按需要包含 ready_for_review。
- `push`：仅 `main`，用于合并后的后台验证。
- `workflow_dispatch`：GitHub 页面手动启动验证，不自动修改 issue、合并或发布。
- 初版不启用 merge queue；若以后启用，增加 `merge_group`。
- 不设置本地 pre-commit/pre-push hook，不阻塞普通功能分支提交/推送。
- 不同时配置所有分支 push 和 PR 事件，避免一次功能分支推送重复执行。

### Jobs

- 单元/集成/CLI/静态合同测试在 Linux 与 macOS 上运行。
- 包级回归优先也覆盖两个平台；若只在一个平台打包，另一平台消费同一 tarball并验证，不以此声称已验证所有架构。
- 如设置最终汇总 job，显式要求所有必需依赖为 success。失败、取消和缺失/跳过都不能使它通过。
- 设置稳定的必需检查名称，后续规则引用这些名称。

### 安全与可靠性

- 默认 `contents: read`；测试不授予 `id-token: write` 或仓库写权限。
- 可信第三方 Actions 固定完整 commit SHA，并备注版本；实施时查询最新兼容版本。
- 使用普通 `pull_request` 测试；不使用带写权限的 `pull_request_target` 执行不可信 PR 代码。
- PR 检查按 PR ID 设置 concurrency，新提交取消旧运行；手动检查和 main 使用不冲突的 group。
- 设置 job 超时与子进程超时，不设置 `continue-on-error` 放行必需测试。
- 无外部服务测试不需 secret；用 stateful tracker 桩。
- 失败日志可上传，上传前限定路径并脱敏。普通产物建议保留 7 天。
- 无必要依赖时不配置 npm cache；缓存只是性能优化，不是真相源。

**完成标准：** 一个真实 PR 与一次 main/手动运行能产生平台结果；新提交取消旧 PR 运行；失败不能形成成功汇总。

## 7. 阶段 D：仓库保护与失败门验收

Workflow 文件不能单独禁止合并，需要 GitHub 规则配合。

- `main` 要求通过 PR 修改，禁止普通直接 push 绕过。
- 将阶段 C 的稳定检查设为必需。
- 建议要求与最新 main 保持更新；暂不引入 merge queue。
- 核实管理员/应用 bypass 清单，记录可绕过者及原因。
- 若保护 workflow 的 CODEOWNERS/review 规则适合单维护者仓库，再采用；避免强制本人无法满足的自审批规则。

先让必需检查真实出现，再配置名称，不凭空要求一个不会触发的检查。

### 负向验收

在专门测试 PR 中加入可控失败，确认 PR 不可合并。恢复后重新通过。不向 main 合入故意失败代码。

同时检查汇总 job 对失败、取消、必需任务被跳过的处理。记录页面/API证据，不只审读 YAML。

**完成标准：** 已实际观察“失败 PR 无法正常合并”；规则与例外有记录。无设置权限时报告尚未完成，不声称 CI 门已经建立。

## 8. 阶段 E：候选版本与发布 workflow

建议 `.github/workflows/release.yml`，通过 `workflow_dispatch` 启动候选发布，而不是等正式 Release 发布后才测试。

### 候选验证链

1. 固定候选 commit SHA；验证其位于 main 历史，初版建议就是启动时 main 的明确 SHA。
2. 从候选读取版本，检查版本格式、Changelog、tag 冲突和 npm 已存在版本。
3. 在两平台运行全部必需验证，不能只信任过去 main 的绿色记录。
4. 生成唯一 tarball，记录摘要；对这个 tarball运行包级回归。
5. 如采用跨 job artifact 传递，核验摘要和来源；产物来自本次可信候选，不从 PR 上传物直接发布。
6. 所有必需检查 success 后才进入发布环境；人工批准不能替代测试成功。
7. 发布同一 tarball，不在发布 job 重新打包变化后的 checkout。
8. npm 发布成功后创建/确认 tag 和正式 GitHub Release；tag、版本、包、候选 SHA 一致。
9. 记录发布结果与版本链接。

需要明确 tag 生成顺序：若先创建 tag，它只是版本标记，不是 npm/GitHub Release 已成功；失败后保留明确状态。正式 Release 必须在验证之后。

### 失败与重入

- 发布 job 使用 `needs`，所有必需验证为 success；禁止测试失败后 always 发布。
- 发布使用独立 concurrency，串行且不因新 PR/新 main 更新取消进行中的发布。
- npm 和 GitHub 不是一个事务。npm 成功、Release 失败时只补缺失步骤，不再次发布同一版本。
- 重入前确认已有 npm 包与原候选/产物证据匹配；不能仅凭“版本存在”判为成功。
- 工作流无需提供跳过测试的输入或开关。
- 分离验证和发布权限；发布 job 才有所需 OIDC/内容写权限。

### Trusted Publishing 与外部配置

优先 npm Trusted Publishing/OIDC，使用标准 GitHub-hosted runner。

实施时查询官方要求，选择满足当前 Node/npm最低版本的明确版本；不能假定 runner 自带 npm 足够新。

维护者需在 npm 包设置中授权准确的 GitHub owner/repo/workflow filename/environment。GitHub发布环境限制候选来源；如配置人工批准，确认账户计划支持且单维护者流程可操作。

限制/撤销不需要的 npm publish token，核对账户是否仍允许其他直接发布路径。仅添加 OIDC 不会自动禁用传统手动发布。

**权限边界：** workflow 和 ruleset能约束普通路径；有权限的管理员仍可能修改规则。未完成账户配置时只能说“发布工作流已实现”，不能说“所有外部发布路径已阻断”。

需要维护者在 dashboard 完成的部分，使用 wizard skill 或明确逐步操作清单；凭证不写入仓库或日志。

### 发布门负向验收

- 在不具备真实发布权限的验证环境中制造单元/系统/包检查失败，确认发布 job 不执行。
- 用独立控制测试验证需要的依赖结果与发布条件，不添加生产绕过旗标。
- 未授权正式发布前，不用真实 npm publish 来测试“失败会挡住”。

**完成标准：** 发布流程结构、实际失败阻断、账户绑定、权限例外和重入处理均有证据；未配置事项明确列出。

## 9. 阶段 F：版本与用户文档

### 版本选择

建议 `0.4.0`，不是已得到明确确认的版本号。原因：新增阶段性交付与放弃能力，旧开放 run 行为改变，新 init 退役预算旗标。正式修改前确认目标版本。

### 文件工作

- `package.json`：修改版本；当前无 lockfile，不生成不必要的锁文件。
- `CHANGELOG.md`：将当前 Unreleased 内容移入目标版本、实际发布日期；保留新 Unreleased；同步底部比较链接。
- `README.md` 和 `README.zh-CN.md`：同步删除 npm 安装章节中的可选 `npm test` 描述。
- 核对升级说明：旧未封账 run 采用新修复规则；旧记录不变；退役预算旗标；正常完成/放弃区分；无累计配额不保证总时间/费用有限。
- Release说明面向用户，描述影响和升级注意事项，不写内部算法或流水账。
- Release 不提 #18，不暗示当前平台派发问题已修复；不以本轮无模型 CI 宣称真实平台兼容性验收。
- 内部测试机制和覆盖边界留在贡献文档；如果更改用户README的其他章节，必须双语同步。

版本 PR 先过 CI再合并，最终发布候选再次验证。是否合并到一个 CI准备PR与版本PR，按可审查范围决定，不把首次CI调试与不可逆发布混为一步。

**完成标准：** 版本/Changelog/双语README一致；新候选通过发布门；正式发布前得到用户明确授权。

## 10. 推荐交付顺序

1. 覆盖矩阵与缺口报告，确定测试边界。
2. 确定性测试补齐、包级系统回归与本地验证。
3. CI workflow 的真实 Linux/macOS运行。
4. main 必需检查和失败PR验收。
5. release workflow、失败门与权限配置。
6. 版本准备和用户文档。
7. 用户授权后启动正式候选发布。
8. 发布后核对 npm版本/dist-tag、tag、Release和安装结果。

每个阶段报告：修改文件、测试命令/结果、远端 run URL、未配置事项、保证边界。不要把“YAML已提交”当成“远端CI验收完成”。

## 11. 最终验收清单

- [ ] 主体能力矩阵完整，缺口已补或注明真实模型边界。
- [ ] 所有已关闭issue按最终决定分类；#10不是实现承诺。
- [ ] 默认CI不运行模型探针，无模型费用和真实tracker写入。
- [ ] 完整源码测试在Linux/macOS通过。
- [ ] 实际tarball的文件、引用、CLI和系统回归通过。
- [ ] 本地提交/普通功能分支推送不等待CI。
- [ ] PR最新候选检查未通过时不能正常合并。
- [ ] main规则与bypass边界已核对。
- [ ] 手动验证不自动合并或发布。
- [ ] 发布任何必需验证失败、取消、缺失时均不执行发布任务。
- [ ] 验证和发布同一候选SHA与tarball。
- [ ] npm与Release部分成功有安全重入路径。
- [ ] Trusted Publishing/发布权限已配置，或明确报告尚未配置。
- [ ] README两种语言同步删除可选npm test；贡献文档保留源码测试入口。
- [ ] 版本、日期、比较链接、tag与包一致。
- [ ] 发布说明不涉及#18，也没有扩大平台验证承诺。
- [ ] CI不上传私有验收归档、凭证或敏感原始会话。
- [ ] 正式发布已得到用户明确授权。

## 12. 成本与待确认事项

仓库公开。标准GitHub-hosted Linux/macOS执行时间按当前官方规则免费；larger runners收费。Artifact存储仍需控制，初版建议7天保留期，不配置不必要缓存。实施时复核最新计费规则与账户预算，不承诺账户整体零费用。

开始实施时需要核实/确认：

1. Node 24、Ubuntu 24.04与macOS 15标签及架构是否适合当前测试。
2. 目标版本是否采用建议的0.4.0。
3. GitHub设置修改权限、main保护与管理员bypass政策。
4. npm维护权限、Trusted Publisher绑定与人工发布路径限制。
5. GitHub环境是否需要人工批准；不阻塞唯一维护者的合法操作。
6. 发布workflow的具体输入与tag顺序，保证候选固定与失败可恢复。

这些问题到相关阶段再确认，不用第一轮一次性要求用户完成全部dashboard设置。

## 13. 官方参考

配置前读取最新官方文档，尤其核对第三方Action版本、npm OIDC要求及GitHub runner标签。

- Actions运行环境：https://docs.github.com/en/actions/reference/runners/github-hosted-runners
- Actions安全：https://docs.github.com/en/actions/reference/security/secure-use
- Node包发布：https://docs.github.com/en/actions/publishing-packages/publishing-nodejs-packages
- npm Trusted Publishing：https://docs.npmjs.com/trusted-publishers/
- Actions计费：https://docs.github.com/en/billing/concepts/product-billing/github-actions
- 免费额度：https://docs.github.com/en/billing/reference/product-usage-included

相关本仓文档：`CONTEXT.md`、`docs/adr/0009-prompt-driven-repair-and-run-continuation.md`、`docs/agents/prompt-driven-scenario-acceptance.md`。已有场景证据只作历史背景，不执行归档workflow脚本作为新的run。
