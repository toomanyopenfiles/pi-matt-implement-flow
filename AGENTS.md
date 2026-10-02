# pi-matt-implement-flow

pi 的 implement 阶段编排器：读 spec + 票 → 算前沿 → 并行派 coder（各自 worktree）→
逐个 review（可配置关闭，`mattImplementFlow.reviewer`，final-reviewer 固定不设开关）→
接回同一 coder 修复 → 合并 + 集成测试门 → 重算前沿 → 最终双轴 review。
流程开关/预算/并发的生效语义见 CONTEXT.md「流程形态」。

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues (via the `gh` CLI).
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

## User-facing docs

Applies to everything a package user reads: `README*.md`, `audit-report/README*.md`,
`CHANGELOG.md`, `SECURITY.md`.

- **Write for the user, not the maintainer.** Cover what the user experiences: the problem the
  package solves, how to install and run it, what they get at the end, where to look afterwards,
  and what to do when something goes wrong (keep a FAQ / troubleshooting section).
- **Internal implementation stays out of user docs.** Mechanism prose (algorithms, internal
  identifiers and field names, sync protocols, packaging details, test fixtures) belongs in
  `docs/adr/`, `CONTEXT.md`, or contributor docs; link there if a user truly needs it. The test:
  a sentence that explains *how the package does it* rather than *what happens for the user* gets
  cut or moved.
- **Plain language over coined jargon.** Name the concrete thing (PR / MR, the run finishing
  cleanly) instead of home-grown terms; explain a term at first use when the audience won't know
  it. In Chinese, prefer 简体中文 phrasing with the English term in parentheses.
- **CHANGELOG entries state user impact**, not implementation history; design decisions live in
  `docs/adr/` and are referenced as `(Design: ADR-NNNN)`.
- **Both README languages carry the same content** (see README languages above).
