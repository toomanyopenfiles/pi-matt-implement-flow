# audit-report — 流程审计报告（旁路取证工具）

对一次已完成的 pi-matt-implement-flow 流程运行做**纯本地旁路取证**，生成可浏览的静态报告网站，
供人类审核者检查全流程执行情况、暴露潜在问题。

- **零大模型调用**：全部内容从事件流、平台留存的子代理证据、主会话与 git 事实机械收集。
- **主流程零侵入**：不修改 SKILL.md / ledger 脚本 / agents；对主流程文件与目标仓库源码只读。
  报告默认写入运行目录下的 `report/`（该路径已被 gitignore，属运行期产物区）；如需完全
  不触碰仓库目录，用 `--out` 指到仓库外。本目录不进 npm 发布面（`package.json` `files`
  白名单未包含）。
- **事实与观点分层**：报告主体是确定性事实（每条可回溯出处）；AI 分析意见是显式的
  两步回填流程（见下），渲染时标注为非事实。
- **附带产物**：报告目录中还会写入 `model.json`（中间取证模型，供调试与二次分析）与
  `analysis-brief.md`（仅 `--ai-brief` 时），均为本工具自身产物，非目标仓库文件。

## 用法

```bash
# 最简：对一次运行生成报告（输出到 <运行目录>/report/，浏览器直接打开 index.html）
node audit-report/report.js --runtime-dir <repo>/.pi/matt-implement/<slug>

# 导出 AI 分析简报（可选）
node audit-report/report.js --runtime-dir <...> --ai-brief

# 回填 AI 分析意见后重渲染（可选）
node audit-report/report.js --runtime-dir <...> --ai-analysis <report>/ai-analysis.json
```

## 报告内容

| 页面 | 内容 |
|---|---|
| `index.html` | 运行总览（分支/spec/流程形态/PR/封账）、**异常与风险区**（确定性检出）、票目总表、叙述化事件时间线、用量与成本、名词表 |
| `ticket-NN.html` | 每票完整证据链：派发任务书原文 → 实现者结构化报告与验收详情（含门禁输出）→ 评审裁决与问题清单全文 → 评审 diff → 修复轮 → 合并 |
| `final.html` | 终审（整分支评审）结论与全文（有 `final` 事件时裁决取自事件）、异常记录与升级、封账对账、编排笔记全文 |

「异常与风险区」的确定性检出规则：失败的子代理运行、验收被拒、异常记录（anomaly）、
升级（escalate）、修复轮耗尽预算、未封账、封账时最新终审裁决为 `not_ready`（带伤封账）、
证据缺失、任务书未恢复等。

## AI 分析意见层（可选，两步回填）

确定性检测只能查「已建模的异常」；跨证据的语义矛盾值得一次 LLM 分析补充。为保持
「事实/观点」分层，采用离线两步而不是在线调用：

1. `--ai-brief` 导出 `analysis-brief.md`（自包含的证据简报，附回填格式说明）；
2. 把简报交给大模型（或在 pi 会话中分析），按说明写 `ai-analysis.json` 放进报告目录，
   带 `--ai-analysis` 重跑。意见渲染进独立的「AI 分析意见」区块，明确标注为非事实。

## 测试

```bash
node --test audit-report/collect.test.js
```

测试使用合成 fixture（临时目录 + 假会话数据，自动清理），不依赖任何真实运行数据。

## 数据源与关联

| 证据 | 位置 | 用途 |
|---|---|---|
| 事件流 | `<运行目录>/events.jsonl` | 时间线、票状态机、运行 ID |
| `final` 事件 | `<运行目录>/events.jsonl` 中的 `final` 事件 | 终审运行的 runId 与裁决：事件驱动路径的终审清单、成本桶与 findings 原文均由此定位（账上无 `final` 事件的旧账降级为下行的目录扫描） |
| 平台证据四件套 | `~/.pi/agent/sessions/--<仓库路径>--/subagent-artifacts/<runId>_*` | 结构化输出、验收账、门禁输出、过程记录 |
| 主会话 | `~/.pi/agent/sessions/--<仓库路径>--/*.jsonl` | 恢复每次派发任务书原文（平台 artifact 中的输入是红断占位，原文只在主会话） |
| 票与 spec | `<repo>/.scratch/<slug>/` | 票面原文与标题 |
| 评审材料 | `<运行目录>/reviews|findings/` | 评审输入 diff 与问题清单 |
| git | 只读查询 | 提交存在性与主题 |

任何一层缺失都降级为页面标注与取证警告，不影响其余证据。
