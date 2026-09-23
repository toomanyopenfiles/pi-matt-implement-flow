# ADR-0005: spec 识别靠 spec 引用与 Parent 边，不打 label、不改上游

- **Status:** accepted
- **Date:** 2026-09-24
- **Deciders:** 本包维护者（经 brainstorm 会话定稿）
- **Context tags:** tracker, spec-reference, upstream-boundary

## Context

封账门的 spec 母票豁免、`init --spec` 映射、终审"引用 spec 行"都需要一个"哪个 issue
是 spec"的识别信号。上游 `to-spec` 发布 spec issue 只打 `ready-for-agent`，与工单无从
区分；GitHub 版 `issue-tracker.md` 范本也没有 spec 约定节。约束：不改上游 skill。

## Decision

识别信号取自两处现成事实：**init 的 spec 引用**（用户参数为主，缺失则 ask once；
`## Parent` 反查结果可作默认候选呈现）与**上游 issue-template 自带的 `## Parent` 边**
（每张工单正文引用 spec issue——票集边界由此反查，顺带豁免 spec 母票）。显式 no：
**不引入 `type:spec` 之类的 label 约定**——label 须改上游词汇表才能自动产生，靠人手打
必漂；**不改上游 to-spec**。

## Consequences

- 票集边界三层兜底：spec issue 的 sub-issues → `## Parent` 反查 → init 票号清单
  （防中途偷加票，顺带冻结 run 的票集边界）。
- spec issue 的 GitHub 来源 URL 记于快照 `spec.md` 头部 `Source:` 行，同步动作由此
  解析收尾对象；将来若上游为 spec 增加了原生标记，识别层可无痛切换。
