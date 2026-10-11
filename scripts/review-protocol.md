# Shared review protocol — the dual-axis process (read-only)

pi-matt-implement-flow reviewer reference, shipped with the package next to `axis-axes.js`. It is
the **one** authority for what both reviewer types share: the per-ticket
`pi-matt-implement-flow.reviewer` and the whole-branch `pi-matt-implement-flow.final-reviewer`.
Your own agent definition keeps your role, your scope and your verdict values, and sends you here
before your first axis dispatch.

**Continue:** once one blocking dual-axis dispatch has returned both reports and you have
aggregated them under `## Standards` and `## Spec` — never before.

## Inputs arrive as pointers

Nothing is inlined here; every input is a path in your brief:

- **Review bundle** — a *file* holding the three-dot diff (`git diff <base>...<reviewed ref>`) plus
  the commit list. Read it first, then read the changed files in your worktree (checked out at the
  reviewed ref).
- **Ticket file, spec, findings, runtime paths** — absolute main-repo paths, marked read-only; the
  paths under `.pi/matt-implement/<slug>/` do not exist in your worktree.
- **Gate evidence** — the typed-gate report (`headSha`, `testResult`) the platform gate produced
  host-side from git truth plus a real test run. There is no model-written implementer report: the
  gate report and the artifacts are the claims you verify.
- **`Axis script`** — the absolute path of `axis-axes.js`; this protocol doc is the one beside it,
  and `Shared protocol` in your brief is its absolute path.
- **`Run timeout settings`** — absolute user/project settings paths from the main repo.

A missing or unreadable input is not a review finding: escalate (below) instead of reviewing from
memory.

## One blocking dual-axis dispatch

Exactly ONE top-level `subagent` call, in script-file form, runs both axes. `async: false` makes it
blocking on purpose: both reports are in hand before anything else happens.

```js
const RUN_TIMEOUT_MS = 14400000; // ← substitute the value you just resolved (see below)

subagent({
  workflow: "<this-package>/scripts/axis-axes.js",
  args: {
    agent: "<your package-full name>", // pi-matt-implement-flow.reviewer | .final-reviewer
    context: "fork",
    timeoutMs: RUN_TIMEOUT_MS,
    standards: "<Standards brief>",
    spec: "<Spec brief>"
  },
  async: false
});
```

- The script runs the two children in one `runs.all`; each axis item's `key` is pinned in code as
  `key: "standards"` and `key: "spec"` — a keyless item is rejected outright.
- Both children use your own agent with `context: "fork"` so they inherit your reading. Axis
  children are read-only and must not spawn further subagents.
- Axis packets must stand alone: include every path and instruction they need even though they fork
  your context.

**Resolve the deadline fresh, every dispatch.** Immediately before the call — even if you read the
files earlier — resolve the deadline following `run-timeout-settings.md` beside this doc, using the
brief's `Run timeout settings` paths, and pass it as `args.timeoutMs` (`timeoutMs: RUN_TIMEOUT_MS`
in the snippet). Never reuse your own launch value. Both axes share this resolution; a settings
change after their launch applies to the next dispatch.

## The two axis briefs

- **Standards brief** — the bundle path; the standards source files the reviewing agent located in
  the worktree (`CONTRIBUTING.md`, `CODING_STANDARDS.md`, `docs/adr/`, or similar — the axis
  searches further if that list turns out to be incomplete); and an explicit instruction to apply
  the full smell baseline from the code-review skill. Ask for: (a) every documented-standard
  violation with the standard cited (file + rule); (b) any baseline smell, named and quoted.
  Distinguish hard violations from judgement calls; a documented repo standard overrides the
  baseline; skip anything tooling enforces. Under 400 words.
- **Spec brief** — the bundle path, the spec path, the ticket path. Ask for: (a) requirements the
  spec asked for that are missing or partial; (b) behaviour in the diff that was not asked for
  (scope creep); (c) requirements that look implemented but wrong. Quote the spec line for each
  finding. Under 400 words.

Scope stays with your role: the per-ticket reviewer's axes read the ticket bundle against its
ticket and spec; the final-reviewer's Standards axis reads the whole-branch diff and its Spec axis
the feature spec. Same brief shapes, same protocol.

## Verdict discipline

- Never end your turn while an axis is still running: the verdict is written only after both axis
  reports have returned — a verdict that lands before the reports is the failure this rule exists to
  prevent.
- Aggregate both reports under `## Standards` and `## Spec` without merging or reranking findings,
  then a per-axis count and the worst issue within each axis. Never pick a single winner across
  axes.
- Filter by evidence, not severity: report only what you can justify from the diff, the worktree,
  or a contract contradiction, caused or made reachable by the reviewed change.
- P0 blocks the gate you serve; P1 should be fixed before the branch ships; P2 is report-only. Say
  exactly `No issues found.` per axis when nothing qualifies.

## Escalation

If a required input is missing, the spec contradicts the ticket, or you cannot reach a verdict, use
`contact_supervisor` with `reason: "need_decision"` and wait for the reply. If it is unavailable,
report the blocker in your final response.
