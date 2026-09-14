# 设计方案索引

> 状态：**设计阶段完成，代码未开始**。Q1–Q8 全部落定；机制探针已实测完成（`verified-facts.md` §10）。最后更新 2026-09-15（第二轮）。

## 这个项目要做什么

把 Matt Pocock 主流程的**最后一段**（implement）从「一票一 session、人工推进」升级为「编排器自动并行派发」：

> 读 spec + 票图 → 算前沿 → 并行派 N 个 coder（各自 worktree）→ 逐个 review → 修复送回同一 coder → 合并 + 集成测试门 → 重算前沿 → 直到全部完成 → 最终双轴 review

知识底本不是 Matt 的草稿，而是它的工程化完成品 **`implement-orchestrated`**（Claude Code 插件，本地路径见下）。

## 新 session 从这里开始

按顺序读：

| 顺序 | 文件 | 读它干什么 |
|---|---|---|
| 1 | 本文件 §现有生态（下面） | **这是本设计最大的前提**：项目定位与 `pi-matt-flow` 的关系 |
| 2 | [`decisions.md`](./decisions.md) | 已定的事、待你定的事（含推荐） |
| 3 | [`pi-capability-map.md`](./pi-capability-map.md) | B 的每个机制在 pi 里怎么落地；合并策略三方案 |
| 4 | [`verified-facts.md`](./verified-facts.md) | 已查证的事实 + 源码/文档出处；**§10 是机制探针实测**（含推翻了第一轮推断的那条） |

Q1（项目定位）已定：**纯独立实现，只做 implement，前置四阶段由用户手动跑**（见 `decisions.md` D7）。四个 agent、模型配置、批注全已落定，直接读 `decisions.md` §已定（第二轮）。

## 现有生态

> ⚠️ **2026-09-15 更新**：Q1 已定 → 本项目与现有项目**完全独立**。下面两个项目现在只是**参考读物**，不共享代码、不共享状态文件。

`~/Programs/llm-tools/plugins/` 下已有两个高度相关的项目，全部是 pi 侧的：

### `pi-matt-flow` ← 你自己的，**与本项目重叠最大**

Matt 六阶段主流程状态机：`setup → grill → spec → tickets → implement → review`。

| 文件 | 规模 | 干什么 |
|---|---|---|
| `flow-core.ts` | 1207 行 | 纯逻辑：阶段表、转移、**票队列拓扑**、配置分层、brief 渲染、请求解析 |
| `flow-core.test.ts` | 1042 行 | 上述全部行为锁定在测试里 |
| `matt-flow.ts` | 1106 行 | 状态机、阶段技能注入、`matt_flow` 工具、`/matt-flow` 命令、硬停 |
| `skill-alias.ts` | 191 行 | **别名层**：把 Matt 正文里的 `/grilling`、`/tdd` 转发到 pi 真实的 `/skill:x` |
| `spec-finder.ts` | 161 行 | spec 候选发现 |

**它已经有的、与本项目重叠的能力**：

- `Ticket { id, title, blockedBy[], status }` —— **票的依赖图**
- `queueReport(queue)` → `{ total, done, doing, todo, ready[], blocked[], missingDeps, stuck }` —— **这就是前沿（frontier）计算**，含依赖环检测（`stuck`）
- `pickTicket(queue, mode)` —— `fifo | smallest` 选票策略
- `claimTicket` / `ticketActionGate` —— 认领与阶段门禁
- `renderTicketBrief(ticket, queue, state)` —— 单票 brief 渲染
- 硬停机制（`halt` 支持 `after-stage` 与 `ticket` 边界）
- 双轨状态（session 轨 `pi.appendEntry` + 项目轨 `.pi/matt-flow/state.json`）

**关键冲突点**（必须解决）：

```ts
// flow-core.ts:150
currentTicket: string | null;   // ← 单值，设计上只能有一张票在做（串行）
```

README 把这条写成硬不变量：**「同一时刻最多一张 doing 票；`ticket-done` 只接受当前票」**。

而本项目的目标是**并行 N 个 coder**。所以：

| | pi-matt-flow 现状 | 本项目目标 |
|---|---|---|
| 并行度 | 1（`currentTicket: string \| null`） | N（默认 3） |
| 隔离 | 无（同一工作区） | 每 coder 独立 worktree |
| 验证 | 无自动 review | 每票过 reviewer + `gate` |
| 修复 | 无 | 送回同一 coder（resume） |
| 合并 | 无（coder 直接改当前分支） | 合并门 + 集成测试 |
| 推进 | 人工 `ticket-done` | 自动重算前沿 |

**结论**：本项目的核心增量 = 把 `pi-matt-flow` 的 implement 阶段从**串行人工**升级为**并行自动编排**。前沿计算、票图、brief 渲染这些已经被实现了。

### `pi-mainflow` ← 第三方（`github.com/fghosth/pi-mainflow`）

同样是六阶段状态机（`/flow begin|advance|goto`），但做的是**另一种事**：

- 自带 **10 个已适配 pi 的技能**随包分发（`grilling` / `domain-modeling` / `grill-with-docs` / `architecture-standards` / `to-spec` / `to-tickets` / `implement` / `code-review` / `tdd` / `setup-matt-pocock-skills`）
- 已完成三项适配：斜杠命令引用改按技能名、GitHub tracker 改为本地文件默认、code-review 子代理改用 pi 的 `subagent` 工具
- 只有单文件扩展 `extensions/mainflow.ts`，深度远不如 `pi-matt-flow`

**对本项目的意义**：它证明了「Matt 技能适配 pi」这件事已经有人做过并打包；**本项目的价值不在适配技能，而在编排 implement 阶段**。可以拿它的技能适配当参考，不必依赖它。

### 其他同级项目

- `implement-orchestrated` —— **知识底本**（Claude Code 插件，本项目要移植的对象）
- `spec-handoff` / `pi-goal-list-loop-audit` / `pi-smart-selection` / `aihubmix` / `session-mode` —— 无关

## 上游资产（绝对路径，供新 session 查证）

| 资产 | 路径 |
|---|---|
| **知识底本**（要移植的） | `/Users/gaosong/Programs/llm-tools/plugins/implement-orchestrated/` |
| Matt 的原始草稿 | `/Users/gaosong/Programs/llm-tools/skills/mattpocock-skills/skills/in-progress/implement-spec/` |
| Matt 技能全集（已软链进 pi） | `/Users/gaosong/Programs/llm-tools/skills/mattpocock-skills/skills/` |
| 用户级技能软链 | `~/.pi/agent/skills/` |
| pi-subagents 扩展（0.67.0） | `/Users/gaosong/.pi/agent/npm/node_modules/pi-subagents/` |
| pi 内置文档 | `/Users/gaosong/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/` |
| `pi-matt-flow`（复用对象） | `/Users/gaosong/Programs/llm-tools/plugins/pi-matt-flow/` |

## 已定的项目结构（D11 定稿）

```
pi-matt-implement-flow/
├── package.json        ← 唯一注册入口
│     { "name": "pi-matt-implement-flow", "keywords": ["pi-package"],
│       "pi": { "skills": ["./SKILL.md"],
│               "subagents": { "agents": ["./agents"] } } }
├── SKILL.md            ← 编排器正文（用户指定放项目根目录）
├── agents/
│   ├── coder.md              # package: pi-matt-implement-flow
│   ├── reviewer.md
│   └── final-reviewer.md
├── README.md
└── docs/design/        ← 本目录
```

**安装方式**：`pi install <本项目绝对路径>`（本地路径包只写 settings，**不复制文件**）。

**D4（根目录 SKILL.md）已解决**：`pi.skills: ["./SKILL.md"]` 可用——`package-manager.js` 对字面路径做 `isFile()` 判断后直接收下，**没有目录假设**（源码验证，见 `decisions.md` D11）。agent 侧由 `pi.subagents.agents` 声明（`agents.ts:517-545` 读该字段）。软链方案（`~/.pi/agent/skills/<name>.md`）作为备选也验证过可行，但只覆盖 skill 半边。

## 尚未做的事

- ✅ 设计文档（4 份）
- ✅ 机制探针（`/tmp/mif-probe`，12 项发现）
- ❌ 未写 `package.json` / pi manifest
- ❌ 未写 `agents/{coder,reviewer,final-reviewer}.md`
- ❌ 未写 `SKILL.md`
- ❌ 未 `git init`
- ❌ 未 `pi install` 注册（也就未验证 `agentOverrides` 的全名 key 能否生效）

**下一步顺序**（见 `decisions.md` 末节）：先 `package.json` + 三个 agent → `pi install` 验证注册链路 → 再写 `SKILL.md` 正文 → 真实 repo 试跑一轮。
