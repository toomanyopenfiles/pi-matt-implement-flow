# ADR-0007: tracker 契约化——setup 产物判型选中随包预设，引擎吃契约跑全流程

- **Status:** accepted（已实现落地）
- **Date:** 2026-09-28
- **Deciders:** 本包维护者（经 brainstorm 会话定稿）
- **Context tags:** tracker, contract, preset, vocabulary, gitlab, anti-overengineering

## Context

tracker 支持（local markdown / GitHub Issues）长在两类地方：`gh` 命令行与 `github.com`
原址解析硬编码进 ledger 脚本，triage label 词表（五角色名）写死——ADR-0006 已裁决词表
的解析与钉死方式，但映射的**载体**仍是代码分支；setup 阶段由 `/setup-matt-pocock-skills`
选定的 tracker（local / github / gitlab / other）在运行时还要靠 `--tracker` 旗标手工重复
声明。配置双轨（setup 产物 vs 旗标）、形态分叉（per-tracker 代码分支）、词表硬编码三处
缺口互相放大：支持一个新 tracker 意味着引擎代码逐点开洞，而不是加一份数据。

而配置的真源早已存在：目标仓库的 `docs/agents/issue-tracker.md` 与
`docs/agents/triage-labels.md` 是 `/setup-matt-pocock-skills` 落盘的产物，明文支持用户
编辑。问题是怎么让机器吃到它：散文终归是给 LLM 读的，脚本要的是结构化能力声明。

**前提（spec 显式拍板）**：本包**不需要远端实时可见**——本地投影（tracker 快照 + 票文件）
是待推送的真相，同步是封账前单点批量推送（ADR-0003 骨架原样保留）；三种 tracker 的票号
皆 1–6 位数字（ADR-0004 免改）；事件格式与本地投影布局零迁移。

## Decision

**把 tracker 差异从代码分支搬进 setup 产物派生的机器契约：两份上游文档 → 判型选中一份
随包发布的契约预设（声明式数据），通用引擎此后吃契约对象跑完整流程。**

1. **契约解析核心，唯一新缝**：`scripts/tracker-contract-core.js` 的
   `resolveContract({ issueTracker, triageLabels })` 纯函数——输入两份上游文档文本，
   输出契约对象（预设副本 + 词表映射钉死）或 ok=false 显式错误。范本判型按结构性判据
   （H1 标题行 + 少量锚点短语，大小写与空白归一后比对），判据随预设发布，正文可被用户
   编辑、锚点不可缺；同时承担 triage-labels.md 的严格解析（ADR-0006 落地，见下）。
   判型失败发生在任何 tracker 调用与落盘之前——**零半成品**。
2. **三份契约预设，随包发布的声明式数据**（`scripts/tracker-contracts.js`）：local /
   github / gitlab。字段覆盖六个维度——detection（范本判据）、identity（票号语法、
   spec 引用语法、原址 URL 形态）、mapping（label→canonical 五角色、closed→本地
   Status、type 来源、阻塞边来源、viewShape 适配面）、ticketSet（票集边三层兜底链）、
   capabilities（占坑强度、closeWithComment、收尾面 PR/MR/none）、commands（取数/占坑/
   留评/关票/撤认领/changing 探测的 argv 命令模板；local 全 null——票文件即真相）、
   idempotency（marker 模板与载体）、lifecycle（spec 关票时点、abandon 语义）。
   预设是数据不是代码分支：**支持一个新 tracker = 新增一份预设数据 + 范本判据，不碰
   引擎代码**（spec User Story 23）。schema 校验档
   （`validateContract`）是三预设与合成契约同过的唯一校验点。
3. **词表解析落地 ADR-0006**：`parseTriageLabels(mdText)` 按表头定位列、恰好五行、
   label 唯一，违约报错到文件+行+列+期望；文件缺失落 canonical 默认并注记警告；解析
   结果覆盖预设的 canonical 默认，随快照钉死（拉取时钉死）。落地位置即本模块，ADR-0006
   状态随之转为 implemented。
4. **识别失败语义——两种显式停下，不猜测不降级不派生向导**：
   - **缺 setup 产物** → 提示运行 `/setup-matt-pocock-skills` 后停下；
   - **范本认不出（H1 对不上任何预设判据）或锚点缺失** → 显式
     「仅支持 local / github / gitlab 三种范本」，停下。
   两者都不是错误降级路径，而是能力边界声明；SKILL.md 的 Preconditions 段复述同一语义。
5. **引擎接线（票 05–07）**：既有纯模块（转写 / 同步规划 / 票集解析 / 原址解析）参数化
   吃契约对象；tracker 命令执行收敛为按契约命令模板执行的通用 driver；同步动作集由
   契约能力生成（GitLab closeWithComment=false 走 note 先行等价序列）；sync 评论统一
   携带 marker 幂等键（票 02）；SKILL.md 删 tracker 分支条款、改述为按契约能力执行。

### 被否的选项（spec 显式否决的过度设计，留给未来会话不再争论）

- **派生向导**（setup 产物缺失时现场问答生成 tracker 文档）：向导产物没有上游范本的
  判据背书，等于本包自造第二套 setup；缺产物 = 显式指路 `/setup-matt-pocock-skills`
  足够。弃。
- **契约文件随包发布之外再留用户可编辑的契约实例**：契约的编辑面在**上游范本**
  （改能力由改 setup 模板与预设数据承载）；给用户暴露契约实例就多一处可与
  triage-labels.md 打架的真源。弃。
- **用户可覆盖预设 / 预设层配置项**：预设是本包的能力声明，不是用户配置；覆盖入口
  （settings 节 / 覆盖文件）扩大配置面换取场景收益极小（真实需求是改词表，词表面已
  开放）。显式否决。
- **契约解析结果惰性缓存**：判型是纯函数级开销（字符串比对），且每个 tracker 触点
  （init / snapshot-init / claim / sync）都该按当下 setup 产物重新判型——缓存制造
  「产物改了、运行时还在用旧契约」的陈旧真源。弃。
- **逐票实时同步**：同 ADR-0003「逐票实时同步（形态 2）」的弃用理由——失败面散进每票
  流程，单人 AFK 场景实时性收益弱；权威方向不变（本地投影 = 待推送真相）。弃。
- **散文契约解释器**（LLM 读 setup 产物自由决定 tracker 行为）：把能力判定从数据退回
  模型注意力，恰是 ADR-0001 要消灭的失效模式；且散文解释追问下去就是"纯散文即可
  配置"，脚本退化为解释器。本包的"无硬编码"目标是**零 per-tracker 代码分支**，不是
  零代码协议——契约 schema、内部状态机、canonical 输出词表、本地投影布局是本包自己的
  协议，仍编译在代码里。弃。
- **票号语法放宽**（Jira `PROJ-123` 等非数字 ID）：三种已支持范本皆 1–6 位数字
  （ADR-0004），归一化与合并令牌零改动；放宽票号空间牵动 ADR-0004 的转换点与账本
  状态机，收益仅限尚未支持 tracker——本已显式不支持。不在本期。弃。

## Consequences

- 引擎不吃 tracker 名：同一套纯模块用例喂三预设 + 合成契约（假想 tracker，仅测试用）
  全绿即证明；tracker 名不再是分支条件，契约对象是唯一依赖。
- 上游范本漂移风险显式化：上游模板跨版本变形致判型失配 = 显式失败（提示重跑 setup 或
  升级本包预设），不是静默降级；预设随包发布，升级本包即升级判型与契约。
- README 支持矩阵对外声明：local / github / gitlab 一等支持，其他范本（other）显式
  不支持——能力边界是承诺的一部分。
- 词表与判型的裁决实现集中在 `scripts/tracker-contract-core.js`；ADR-0006 的
  「parseTriageLabels + statusOf 参数化」句柄已对上下文读者可见，词表解析的契约教材
  是解析错误文案本身。
