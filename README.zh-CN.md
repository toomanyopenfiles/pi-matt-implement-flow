# pi-matt-implement-flow

一条命令，把一份 spec 和它的 ticket 依赖图跑成一条通过 review、通过测试的分支：多张 ticket 由多个 coder 并行实现，各自在独立的 worktree 里工作；每张 ticket 完成后都要过一遍双轴 review，发现的问题交回原来的 coder 修复；全部合并后跑一遍全量集成测试，最后对整条分支做一次 final review。

它是 Matt Pocock 的 [`/implement`](https://github.com/mattpocock/skills) 的增强版——他的 [mattpocock/skills](https://github.com/mattpocock/skills)（"Skills for Real Engineers"）上游流程照常使用，本包只接管最后一步：当工作量大到一张 ticket 依赖图装不下、需要并行推进时，交给编排器自动跑完。

[English](./README.md) | 简体中文

## 为什么不直接用 /implement？

如果你已经在用 Matt Pocock 的 engineering skills，上游流程照旧：`/grill-with-docs` → `/to-spec` → `/to-tickets`，本包只接管最后一步——实现。`/implement` 适合一次搞定一摊工作；可一旦工作是一张**多 ticket 依赖图**，它的局限就暴露出来了：

|          | `/implement`                                                   | pi-matt-implement-flow                                                                                                                                                        |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 推进方式 | 单会话里一张张做，你需要自己盯着哪些 ticket 解锁了             | 自动计算依赖图的前沿，一条命令推进到底                                                                                                                                        |
| 并发     | 一次一张 ticket                                                | 最多 N 个 coder 并行，各自在隔离的 worktree 里工作                                                                                                                            |
| review   | 收尾时跑一轮 `/code-review`                                    | 每张 ticket 都做双轴 review（代码规范 + 对照 spec），发现的问题**交回原来那个 coder 修复**——修的人就是写的人，上下文是现成的；fix 预算用完就转交你人工处理，不会卡住整个 run |
| 集成风险 | 全部做完才知道合在一起能不能跑                                 | 每张 ticket 合并后立刻跑全量测试，集成问题当场暴露、当场修                                                                                                                    |
| 会话中断 | 靠上下文记忆恢复，容易走样                                     | run 状态落盘保存，中断或上下文被压缩后，都能从确定的状态继续                                                                                                                  |

Matt 的仓库里还有一个开发中的 [`implement-spec`](https://github.com/mattpocock/skills/blob/main/skills/in-progress/implement-spec/SKILL.md)，思路与本包相同（worktree 并行 + 前沿推进）。区别在于：它是一份交给模型自由发挥的指令文档，没有逐 ticket 的 review 与修复闭环，没有落盘的 run 状态，行为也不可配置——而这三点，恰恰决定了你敢不敢把一长串 ticket 放手交给它。

### 代价

并行和逐 ticket review 都有成本：N 个 coder 各自跑测试、每张 ticket 两轴 review、再加上修复轮次——token 消耗会明显高于单会话串行实现。想省一点，可以关掉逐 ticket review（`reviewer: false`；集成测试和整条分支的 final review 仍然保留），或者调低 `maxConcurrent`。

## 环境要求

- [pi](https://github.com/earendil-works/pi) coding agent，以及 [pi-subagents](https://github.com/nicobailon/pi-subagents) 包（提供并行派发、托管 worktree 和 resume 能力）
- Matt Pocock 的 [engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering)——上游流程（`/grill-with-docs` → `/to-spec` → `/to-tickets`）和各 agent 依赖的 `tdd`、`codebase-design`、`code-review`、`resolving-merge-conflicts` 都来自这里

## 安装

```sh
pi install npm:pi-matt-implement-flow
```

可选：跑一遍自检，确认安装完好（测试文件不随包发布，需从仓库克隆运行）：

```sh
git clone https://github.com/toomanyopenfiles/pi-matt-implement-flow.git
cd pi-matt-implement-flow && npm test
```

## 快速上手

1. **一次性配置**——装好 pi、pi-subagents 和 Matt Pocock 的 engineering skills，然后在你的仓库里跑一次 `/setup-matt-pocock-skills`。
2. **准备工作**：

   ```
   /grill-with-docs
   /to-spec
   /to-tickets
   ```

   开跑前确认三件事：worktree 是干净的、仓库至少有一个 commit、全量测试命令能跑通。

3. **运行**：

   ```
   /pi-matt-implement-flow [N]
   ```

   `N` 是并行 coder 的数量（默认 3）。跑完你就得到一条 feature 分支——如果仓库配了 GitHub 远端，则直接是一个可以开始 review 的 PR——每张 ticket 都经过了实现、review 和集成测试，全程无需你逐张盯着。

## 工作原理

把 spec 和它的 ticket 依赖图交给编排器：它会创建 feature 分支，把 coder 派往当前就绪的 ticket（各自在独立的 worktree 里），逐张 review、把问题发回写这张 ticket 的 coder 修复，合并后跑全量测试，再计算下一批就绪的 ticket，最后对整条分支做一次 final review。

```mermaid
flowchart LR
    S[Spec + tickets] --> O["/pi-matt-implement-flow"]
    O --> P[Parallel coders<br>one ticket per worktree]
    P --> R[Every ticket reviewed,<br>fixes looped back]
    R --> M[Merge + full test suite]
    M --> F[Whole-branch final review]
    F --> PR[Ready PR]
```

fix 预算用完的 ticket 会在 run 结束时转交你人工处理，不会阻塞其他 ticket 继续推进。

run 状态保存在 `.pi/matt-implement/`——已自动加入 gitignore，整个目录随时可以删掉。

## 配置

### `/matt-flow-config`

包内置的交互式配置向导（不走大模型）：

```
/matt-flow-config        # 选角色 → 选 model / thinking 档位，或编辑流程选项
/matt-flow-config show   # 查看三个角色当前生效的 model / thinking 档位
```

它修改的是 pi 的 `subagents.agentOverrides`（用户级 `~/.pi/agent/settings.json` 或项目级 `<repo>/.pi/settings.json`，项目级逐字段优先于用户级）。改完在下一次派发时就生效——不用重启 pi。

### 流程选项

```jsonc
{
  "mattImplementFlow": {
    "reviewer": true,      // 逐 ticket review + 修复闭环；false = 通过集成测试后直接合并
    "maxFixRounds": 2,     // 每张 ticket 转交人工处理前的 fix 轮次上限
    "maxConcurrent": 3     // 并行 coder 数；/pi-matt-implement-flow <N> 优先
  }
}
```

通过 `/matt-flow-config` → "Configure flow options" 设置，或直接编辑 pi `settings.json` 里的 `mattImplementFlow` 一节。改动从下一次 run 开始生效——进行中的 run 不受影响。

## 许可证

[MIT](./LICENSE)
