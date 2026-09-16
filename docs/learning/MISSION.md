# Mission: 吃透 pi-matt-implement-flow，为维护与演进打底

## Why

用户是本 pi 插件的作者兼维护者。目标不是泛泛理解，而是达到**改得动**的程度：以后修 bug、调整流程（brief 措辞、review 策略、并发规则）、加功能（如 usageBudget 验证、上游 bug 跟踪）时，每一次改动都能建立在「真懂实现原理 + 平台机制」的基础上，而不是靠记忆和猜测。

## Success

- 能不看资料完整画出编排循环的状态机（前置检查 → Round 0 → 轮次循环 → 最终门），并说出每一步对应的平台机制依据（worktree 保留、resume、gate、acceptance）
- 能解释三个 agent（coder / reviewer / final-reviewer）的 persona 拆分逻辑、工具白名单取舍，以及 `package.json` → `pi install` → 全名注册的链路
- 能预测改动某处（如 Coder brief 模板、reviewer 工具表）会在哪些环节产生连锁反应，改动前先想到回归点
- 能低成本验证一个机制假设：知道去哪读实测事实（verified-facts §10）、怎么跑自检、怎么搭探针

## Constraints

- 教学语言：简体中文，专有名词带括注
- 教学工作区：本仓库 `docs/learning/`（用户明确选择：不进 .gitignore，随包发布）
- 会话以 brainstorming（头脑风暴）模式开启：教学文件本身经用户选定后创建；**不改动项目功能代码**，教学只做检索、阅读、分析

## Out of scope

- `pi-matt-flow` 六阶段状态机的内部实现（仅作背景读物）
- 向 pi-subagents 上游贡献代码（其 bug 报告只作为已知环境事实记录）
