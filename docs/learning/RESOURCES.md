# pi-matt-implement-flow 学习资源

> 知识来源以**本仓库自身的一手资料**为主（最高可信度：既是被维护的对象，也是实测记录）。每条注一行用途。

## Knowledge

### 本仓库（一手，最权威）

- [SKILL.md](../../SKILL.md)（仓库根）
  编排器正文，流程的最终权威。Use for: 任何「流程到底怎么走」的争议，以它为准；段落锚点：Preconditions / The loop / Briefs / Hard rules / Compaction。
- [agents/coder.md](../../agents/coder.md)、[agents/reviewer.md](../../agents/reviewer.md)、[agents/final-reviewer.md](../../agents/final-reviewer.md)
  三个子代理的 persona、工具白名单、报告契约。Use for: 讲 agent 策略（D9/D16）与嵌套 fanout。
- [docs/design/README.md](../../docs/design/README.md)
  项目定位、与 pi-matt-flow / pi-mainflow / implement-orchestrated 的关系、D11 定稿的包结构。Use for: 「为什么这个项目长这样」的第一站。
- [docs/design/decisions.md](../../docs/design/decisions.md)
  D1–D19 决策记录（已定 + 被探针修正的过程）。Use for: 每个设计选择的「为什么」；特别是 D8/D14/D15/D16/D17/D19。
- [docs/design/pi-capability-map.md](../../docs/design/pi-capability-map.md)
  B→pi 的机制映射表 + 最终轮次骨架（§6）。Use for: 理解每个机制对应 pi 的哪个原生能力。
- [docs/design/verified-facts.md](../../docs/design/verified-facts.md)
  全部实测事实（机制探针 §10.1–10.17 + E2E dogfood §10.18），每条带源码出处。Use for: 改动前查「这个机制真实行为是什么」；**不要重复查证**。
- [docs/agents/issue-tracker.md](../../docs/agents/issue-tracker.md)、[triage-labels.md](../../docs/agents/triage-labels.md)、[domain.md](../../docs/agents/domain.md)
  tracker 约定（本仓库用 local markdown + `.pi/matt-implement/` 双忽略）、五个 triage 角色串、领域文档消费规则。
- [scripts/registration-checks.js](../../scripts/registration-checks.js) + [scripts/self-check.test.js](../../scripts/self-check.test.js) + [scripts/git-version-check.js](../../scripts/git-version-check.js)
  注册不变量的纯函数自检套件（5 条不变量）。Use for: 讲「注册正确性由 npm test 守护」。

### pi 平台（一手文档与源码，绝对路径）

- pi 内置文档 `~/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
  34 个文件。最常回查：`skills.md`（技能发现）、`packages.md`（pi manifest）、`agents.md`（agent frontmatter、agentOverrides）、`tool-reference.md`（worktree/resume/gate/acceptance 语义）。
- pi-subagents 0.67.0 `~/.pi/agent/npm/node_modules/pi-subagents/`
  文档在 `docs/`，源码在 `src/`。最常回查：`src/runs/shared/worktree.ts`（干净性检查 `:351`、MACHINE_DIFF_OPTIONS）、`docs/workflows.md`（worktree 生命周期、递归守卫）、`docs/agents.md`、`docs/tool-reference.md`。
- pi-subagents bundled skill `~/.pi/agent/npm/node_modules/pi-subagents/skills/pi-subagents/SKILL.md` + `references/multi-lane-orchestration.md`
  多 lane 纪律原文（「一个 cwd 一个写者」「不发明的并行」「brief 自足」）。Use for: 派发纪律的出处。

### 上游资产（背景读物）

- `~/Programs/llm-tools/plugins/implement-orchestrated/`
  知识底本（Claude Code 插件 B）。其流程知识（brief 措辞、两轮修复升级、集成门位置）与 harness 无关，是本项目的移植源。
- `~/Programs/llm-tools/plugins/pi-matt-flow/`
  用户自己的六阶段状态机（**已废弃为参考读物**，D7）。Use for: `queueReport()` 纯函数写法参考；8 条不变量与「环境不会告诉你的坑」章节（verified-facts §7）。
- Matt 技能全集 `~/Programs/llm-tools/skills/mattpocock-skills/skills/`（已软链 `~/.pi/agent/skills/`）
  `tdd` / `code-review` / `codebase-design` / `resolving-merge-conflicts` 是三个 agent 直接受益的技能资产。

## Wisdom (Communities)

- （暂未查证）pi / pi-subagents 的官方 issue tracker 或社区频道
  在查证到高信誉社区前，先不推荐任何链接——宁缺毋滥。

## Gaps

- pi 的线上社区（讨论区 / Discord / GitHub Discussions）是否存在、活跃度如何——未查证
- pi-subagents 上游仓库地址与 issue 提交口径——未查证（两份设计文档已列出待报的 bug：git < 2.41 patch 静默降级、嵌套 fanout 不稳定）
- 嵌套轴 child 的 usage 是否汇入根级 usageBudget——**未证实**，E2E 待验证（verified-facts §10.14 / §10.18-8）
