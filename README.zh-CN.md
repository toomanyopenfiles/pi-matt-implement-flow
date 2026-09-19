# pi-matt-implement-flow

一条命令把 spec + 票图变成一条经过评审、通过测试的分支：多个 coder 并行实现票据——各自在自己的 worktree 里——每张票都要通过双轴评审、修复意见接回原 coder，完成的分支还要过全量集成测试和整分支终审。

它是 Matt Pocock 的 `/implement` 在多票图场景下的自动化、编排化后继。

[English](./README.md) | 简体中文

## 为什么不直接用 /implement？

如果你在用 Matt Pocock 的 engineering skills，上游流程照常走：`/grill-with-docs` → `/to-spec` → `/to-tickets`。本包只接管最后一步——实现。`/implement` 是给一摊工作用的轻量工具；当工作是一张**多票图**时，它的短板就出来了：

|                | `/implement`                                                         | pi-matt-implement-flow                                                                                                                                       |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 推进方式       | 单会话内按票顺序推进，你需要盯着哪张票解锁了                          | 自动计算票图前沿，一条命令推进到底                                                                                                                            |
| 并发           | 一次一张票                                                            | 最多 N 个 coder 并行，各自在隔离的 worktree 里工作，互不干扰                                                                                                  |
| 评审           | 收尾跑一轮 `/code-review`                                             | 每票双轴评审（代码规范 + 对照 spec），发现问题**接回原 coder 修复**——修复者带着这张票的完整上下文；修复预算用完就升级给你，不会卡死整个运行                     |
| 集成风险       | 全部做完才知道合在一起能不能跑                                        | 每张票合并后立刻跑全量测试，集成问题在当票暴露、当票修                                                                                                        |
| 会话中断       | 从上下文记忆里恢复，容易走样                                          | 运行状态落盘，中断或上下文压缩后从确定状态继续                                                                                                                |

Matt 的仓库里还有一个 in-progress 的 [`implement-spec`](https://github.com/mattpocock/skills/blob/main/skills/in-progress/implement-spec/SKILL.md)，思路与本包相同（worktree 并行 + 前沿推进）。区别在于它是一份散文式的编排指令，靠模型自由发挥：没有逐票评审与修复闭环、没有落盘的运行状态、行为不可配置——而这三点正是长票图能不能放心放手的关键。

### 代价

并行与逐票评审不是免费的：N 个 coder 各自跑测试、每票两轴评审、再加上修复轮次——token 消耗会明显高于单会话串行实现。你可以关掉逐票评审（`reviewer: false`，集成测试门和整分支终审仍然保留），或调低 `maxConcurrent` 来控制开销。

## 环境要求

- [pi](https://github.com/earendil-works/pi) coding agent，以及 [pi-subagents](https://github.com/nicobailon/pi-subagents) 包（并行派发、托管 worktree、resume）
- Matt Pocock 的 [engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering)——既包括上游流程（`/grill-with-docs` → `/to-spec` → `/to-tickets`），也包括各 agent 依赖的：`tdd`、`codebase-design`、`code-review`、`resolving-merge-conflicts`

## 安装

从本地路径安装进 pi：

```sh
pi install /path/to/pi-matt-implement-flow
```

可选：运行自检套件确认安装完好：

```sh
npm test
```

## 快速上手

1. **一次性配置**——安装 pi、pi-subagents 和 Matt Pocock 的 engineering skills，然后在你的仓库里跑一次 `/setup-matt-pocock-skills`。
2. **准备工作**：

   ```
   /grill-with-docs
   /to-spec
   /to-tickets
   ```

   开跑前确认：worktree 干净、仓库至少有一个 commit、全量测试命令可以运行。

3. **运行**：

   ```
   /pi-matt-implement-flow [N]
   ```

   `N` 是并行 coder 数（默认 3）。跑完后你会得到一条 feature 分支——如果仓库有 GitHub 远端则是一个 ready-for-review 的 PR——其中每张票都经过了实现、评审和集成测试，全程无需逐票盯梢。

## 工作原理

你把 spec 和它的票图交给编排器：它创建 feature 分支，把 coder 派往就绪的票据（各自在自己的 worktree 里），逐票评审、把修复意见发回做票的那个 coder，合并后跑全量测试，重算下一批就绪票，最后对整条分支做一次终审。

```mermaid
flowchart LR
    S[Spec + tickets] --> O["/pi-matt-implement-flow"]
    O --> P[Parallel coders<br>one ticket per worktree]
    P --> R[Every ticket reviewed,<br>fixes looped back]
    R --> M[Merge + full test suite]
    M --> F[Whole-branch final review]
    F --> PR[Ready PR]
```

修复预算用尽的票据会在结束时升级给你，不会阻塞其余票据的推进。

运行状态存放在 `.pi/matt-implement/`——已自动加入 gitignore，整目录可删。

## 配置

### `/matt-flow-config`

包内置的交互式配置向导（不经过大模型）：

```
/matt-flow-config        # 选角色 → 选 model / thinking 级别，或编辑流程选项
/matt-flow-config show   # 展示三个角色当前生效的 model / thinking 解析
```

它写入的是 pi 的 `subagents.agentOverrides`（用户级 `~/.pi/agent/settings.json` 或项目级 `<repo>/.pi/settings.json`；项目级逐字段优先于用户级）。写入后下一次派发即生效——无需重启 pi。

### 流程选项

```jsonc
{
  "mattImplementFlow": {
    "reviewer": true,      // 逐票评审 + 修复闭环；false = 测试门通过后直接合并
    "maxFixRounds": 2,     // 每张票升级前的修复尝试次数
    "maxConcurrent": 3     // 并行 coder 数；/pi-matt-implement-flow <N> 优先
  }
}
```

通过 `/matt-flow-config` → "Configure flow options" 设置，或直接编辑 pi `settings.json` 里的 `mattImplementFlow` 节。改动从下一次 run 开始生效——进行中的 run 不受影响。

## 许可证

[MIT](./LICENSE)
