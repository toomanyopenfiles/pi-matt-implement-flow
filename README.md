# pi-matt-implement-flow

pi 的 implement 阶段编排器：读 spec + 票图 → 算前沿 → 并行派 coder（各自 worktree）→ 逐个 review → 修复接回同一 coder → 合并 + 集成测试门 → 重算前沿 → 最终双轴 review。

纯声明式 pi 包：无依赖、无安装构建步骤，注册正确性由 `npm test` 自检套件守护。

## 安装

包以本地路径安装进 pi：

```sh
pi install <本包路径>   # 例如 pi install /path/to/this/package
```

安装后无需其他步骤。可运行自检确认注册面完好：

```sh
npm test   # 校验声明路径存在、SKILL.md frontmatter 合法、三个 agent 全名正确、
           # ledger 脚本存在且 --help 退 0；另含 fixture 临时仓上的 ledger CLI 黑盒测试
```

> 已知环境限制：git < 2.41 的机器上，pi-subagents 的 patch 捕获会静默降级为空（`npm test` 会在诊断输出中提醒）。

## 调用

skill 已禁用模型自动触发，只能作为斜杠命令手动调用：

```
/pi-matt-implement-flow [N]
```

- `N`：并发 coder 数，默认 3。
- 调用前确认：干净 worktree、git 仓库至少一个 commit、票图每张票都有 `Blocked by` 行、测试命令明确。
- 编排记忆采用机械台账协议（LLM 永不手写台账，见 `CONTEXT.md` 与 ADR-0001）：包内 `scripts/ledger.js`
  是运行状态的唯一写面（`add` 记账 / `build` 再生 / `check` 对账），事件流与台账写在
  `.pi/matt-implement/<slug>/`（已 gitignore）；散文记忆在编排笔记 `notes.md`。

## 三个 agent

| 全名 | 职责 |
|---|---|
| `pi-matt-implement-flow.coder` | 在自己的 worktree 里按票实现一个垂直切片（red → green），跑测试门，提交并回报 headSha / commits / 测试结果 / seams |
| `pi-matt-implement-flow.reviewer` | 逐票两轴 review（设计 + 验收），产出 review bundle 与 blocker 列表 |
| `pi-matt-implement-flow.final-reviewer` | 全部票合并后对整条分支做最终双轴 review |

派发时一律使用上表全名——裸名 `coder` 会解析到用户的 `worker` 别名，裸名 `reviewer` 会解析到 pi 内置 agent。

## 配置

### 模型与思考级别（/matt-flow-config）

包自带一个无 LLM 的配置向导（pi 扩展），在 pi 输入框直接运行：

```
/matt-flow-config          # 交互菜单：选角色 → 选生效级别 → 选 model / thinking
/matt-flow-config show     # 展示三角色当前生效解析（frontmatter 基线 → 覆盖 → 最终值）
```

- 写入目标是 pi 的 `subagents.agentOverrides`（user 级 `~/.pi/agent/settings.json` 或
  project 级 `<repo>/.pi/settings.json`，project 逐字段赢 user）；键为 agent 运行时全名
  （如 `pi-matt-implement-flow.coder`）。
- **写入后无需重启 pi**：pi-subagents 每次 subagent 调用都重读 settings，下一次派发即
  生效；正在运行的 child 不受影响。
- 不想手动改配置文件也可直接编辑同一位置（向导只是帮你在对话里完成写入）。

### 超时契约

| 层 | 值 | 说明 |
|---|---|---|
| agent run 级（每个 dispatch child，含 fix-resume） | `3600000`（1h，三个 agent frontmatter） | 平台默认是 30 分钟（`DEFAULT_ASYNC_TIMEOUT_MS`），对慢模型/大票不够（实测触发过）。想改默认只两条路：改本包 frontmatter，或写平台扩展配置 `~/.pi/agent/extensions/subagent/config.json` 顶层 `timeoutMs`（全局，影响所有 subagent；注意它**不是** settings 键） |
| gate verify 命令（coder 交付时的测试门） | `600000`（10min，SKILL.md 派发模板） | 平台默认固定 120 秒且不可配置，全量套件慢于 2 分钟会被误杀 |
| 单次工具调用 | 不限制 | 平台对 bash 等长跑工具本就无硬死线（run 级 1h 兜底）；按「不配无上限项」原则不设 |
| fix-resume | 继承同一 frontmatter `timeoutMs` | resume 解析 agent 默认值的路径与首次派发相同 |

超时到期是 terminal（run 不可恢复），但工作不丢：retained worktree 保留，编排器按 git
真值接续（参见 SKILL.md 的锚定流程）。

## 与 pi-matt-flow 的关系

**完全独立。** 本包不读 pi-matt-flow 的状态文件、不复用它的代码；两者不共享任何状态或实现。[pi-matt-flow](../pi-matt-flow/) 只是背景读物（其 implement 阶段是串行人工流程，本包将其升级为并行自动编排），采用本包不需要它。
