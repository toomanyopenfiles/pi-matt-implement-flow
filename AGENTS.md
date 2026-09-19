# pi-matt-implement-flow

pi 的 implement 阶段编排器：读 spec + 票 → 算前沿 → 并行派 coder（各自 worktree）→
逐个 review（可配置关闭，`mattImplementFlow.reviewer`，final-reviewer 固定不设开关）→
接回同一 coder 修复 → 合并 + 集成测试门 → 重算前沿 → 最终双轴 review。
流程开关/预算/并发的生效语义见 CONTEXT.md「流程形态」。

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label strings equal to their names
(`ready-for-agent` is the AFK-ready one). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` + `docs/adr/` at the repo root.
See `docs/agents/domain.md`.

## README languages

`README.md` (English) and `README.zh-CN.md` (简体中文) must be kept in sync: a
section change in one file means the matching section in the other changes too.
New language versions are named `README.<lang-code>.md` (e.g. `README.ja.md`)
and added to the language-switcher line at the top of both existing READMEs.
Do not add them to `package.json` `files`: npm force-includes every `README*`
variant automatically.
