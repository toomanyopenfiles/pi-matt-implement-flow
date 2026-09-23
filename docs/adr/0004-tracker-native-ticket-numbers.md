# ADR-0004: 票号采用 tracker 原生编号

- **Status:** accepted
- **Date:** 2026-09-24
- **Deciders:** 本包维护者（经 brainstorm 会话定稿）
- **Context tags:** tracker, ticket-number, ledger-format

## Context

local tracker 的票号是 feature 局部两位序号（01–NN），账本的归一化函数（`^\d{1,3}$` +
补零两位）与票表排序（字典序）都隐含这个假设。GitHub 没有 feature 局部编号，唯一原生
编号是全局 issue number（跨 feature 连续、可达多位数）。要么引入映射表把 issue number
翻译成局部序号，要么让票号空间直接采用 tracker 原生编号。

## Decision

**票号一律采用 tracker 原生编号**：GitHub 即 issue number，分支名与合并令牌沿用
`ticket-<号>` 形态。账本侧两处适配：归一化放宽位数上限（补零语义保留——1–9 号显示为
`01`–`09`，读写同过一个转换点，自洽）；票号排序改数值键（字典序在混位数下会乱）。

## Considered Options

- **feature 局部序号 + 映射表**：账本格式不动，但映射表是一张要人工维护的第二真相
  面，close/对账都要反查——与"映射表越少越不漂"的取向相悖，弃。

## Consequences

- `ticket-1042` 形态的分支名/令牌进入提交历史；GitHub 全局唯一编号让多 feature 并行
  的令牌/分支天然不撞，比局部序号更干净。
- 归一化位数上限需覆盖现实的 issue number 量级；审计工具不共用此转换点，不受影响。
