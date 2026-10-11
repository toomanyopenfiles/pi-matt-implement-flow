---
name: pi-matt-implement-flow
description: "Orchestrate the implement stage of a Matt-style ticket graph: read spec + tickets, compute the frontier, dispatch parallel coder subagents (each in its own managed worktree), run a two-axis review per ticket, send fixes back to the same coder, merge with an integration-test gate, recompute the frontier, and finish with a whole-branch final review. Replaces hand-worked blockers-first ticket queues and per-ticket /clear."
disable-model-invocation: true
---

# Implement, orchestrated (pi)

You are the **orchestrator**. You write no feature code: you dispatch, verify, merge, and keep the **frontier** moving until the spec is built on one branch.

The tickets came from `/to-tickets`: a **task graph** of tracer-bullet slices, each declaring the tickets that **block** it. The frontier is every open ticket whose blockers are all closed and that is `ready-for-agent` (tickets from `/to-tickets` are already agent-ready — never send them through `/triage`). Work it with up to N `coder` subagents at once. N comes from the skill argument (`/pi-matt-implement-flow [N]`); otherwise from `mattImplementFlow.maxConcurrent` in pi settings; otherwise 3.

Talk to subagents through **context pointers** (paths, branch names, commit SHAs). Content they can read themselves stays out of the message. Each stage's operating instructions live in their own document under `run/` — read the one for the stage you are in before acting (entries under **The loop**).

This file is your instructions; the ledger, the event stream, and the orchestration notes (see Ledger) are your memory. **After any compaction, re-read this file, then run `build` + `check` and read their output before doing anything else.**

## Names you dispatch

Agents are registered as a pi package. Always use the full names — the bare `coder` resolves to the user's `worker` alias, and the bare `reviewer` to the builtin:

- `pi-matt-implement-flow.coder`
- `pi-matt-implement-flow.reviewer`
- `pi-matt-implement-flow.final-reviewer`

Skills are baked into the agents (`tdd`/`codebase-design` for the coder, `code-review` for the reviewers). You never call skills on their behalf. On a merge conflict you follow `resolving-merge-conflicts` yourself.

Verify registration once before the first dispatch (`subagent({ action: "list", capabilities: true })`). If the three agents are missing, stop and tell the user to run `pi install <this package path>`.

## The loop

Restate the plan to the user in at most ten lines (branch, ticket count, first frontier, N), then proceed without waiting.

The stages below are the whole loop. Every entry is a **pre-action read**: the trigger says when that stage's document becomes current, and the document opens with its continuation condition — what is true when the stage may be left. Never work a stage from the memory of an earlier read; after a compaction the trunk comes first, then the document of the stage you are in.

- **New run** — `run/new-run.md` — trigger: nothing is initialized yet. Read it before Round 0 — preconditions, the frozen flow shape, the run deadline, and the graph/branch/baseline steps. Continue into the ticket loop once `init` is recorded and the first wave is dispatched.

- **Ticket loop** — `run/ticket-loop.md` — trigger: a frontier ticket is claimed or about to be. Read it before dispatching a wave, and again before merging a ticket — claiming and dispatching, the typed gate, the formal-review round, the fix loop, and the merge-and-close order. Continue per ticket; leave the stage once every merged ticket is closed and the frontier recomputed.

- **Recovery (续跑 / escalation)** — `run/recovery.md` — trigger: an unfinished run already exists (`.pi/matt-implement/<slug>/events.jsonl` present and the ledger header reads `running`), or a ticket enters a handoff. Read it before resuming an unfinished run, and before choosing a repair — cold resume, reconciliation recovery, and escalation history. Continue once the differences are explained and the interrupted stage is recovered.

- **Closing** — `run/closing.md` — trigger: the frontier is empty with every ticket merged, or the user chooses a partial delivery or an abandonment. Read it before the Final gate — final verdict and repair, pre-seal sync, cleanup, ready, seal, and the two independent exits. Continue on the normal path only when a fresh final verdict and a successful sync permit sealing.

- **Dispatch reference** — `run/dispatch-reference.md` — trigger: a dispatch is being assembled or a brief is about to be written. Read it before writing a brief or a dispatch script — the five brief templates and the path rule. Continue once the script lands in a new `.pi/matt-implement/<slug>/wf/` file and every angle bracket is filled.

Two read-only references back the reviewer's axis step: `scripts/review-protocol.md` — the shared dual-axis protocol both reviewer types read before dispatching the axes, loaded from their own agent definition — and `scripts/run-timeout-settings.md`, the deadline resolution they re-read immediately before each `axis-axes.js` call. Continue only when `args.timeoutMs` carries the freshly resolved value.

### Repair decisions — every repair stage

For ticket, integration, and final-review repairs, verify the coder's actual actions, validation results, new problems or scope changes, and evidence pointers after each return; coder self-assessment alone is not proof. This is a decision framework, not a new report form.

Continue when there is a reasonable, evidence-backed next step within the **approved scope**. New diagnostic evidence can justify continuing even while tests remain red. **Continuous failures** call for re-examining the evidence and changing the method, not an automatic attempt-count stop. Commit counts, switching an agent, or changes in wording alone do not show progress. Keep tests, acceptance criteria, and safety constraints intact.

Pause and **request the user** when requirements decisions, permissions, external conditions, or an evidence-backed next step are missing. Explain the blocker, evidence, and required input in the orchestration notes. Preserve command timeouts, the concurrency limit, and the ability to cancel children; continuing does not guarantee bounded total time or cost.

## Ledger

Your memory has three layers, each with exactly one owner. Terms (per `CONTEXT.md`): ledger 台账 / event stream 事件流 / orchestration notes 编排笔记 / record 记账 / seal 封账 / reconcile 对账. The old phrase "event log" is retired — never use it.

- **Event stream** — `.pi/matt-implement/<feature-slug>/events.jsonl`. Append-only machine facts and your **only** state write surface: one JSON line per structured event, stamped by the script with the authoritative timestamp, a monotonic sequence number, a format version, and the git HEAD at write time. You never provide timestamps; you never touch this file directly.
- **Ledger** — `.pi/matt-implement/<feature-slug>/ledger.md`. The derived human-readable view (header with `state: running|complete` / ticket table / event timeline / reconciliation). **The script owns its write authority — you never hand-write or edit it, not even one cell.** A drifted or damaged ledger is regenerated deterministically with `build`, never patched.
- **Orchestration notes** — `.pi/matt-implement/<feature-slug>/notes.md`. Prose memory: process narrative, lessons, pending decisions, user decisions, pause stages, and recovery explanations with evidence pointers. Protocol facts go to the event stream; decision and recovery context goes here. Notes never replace git, ticket status, or formal verdicts as facts.

- **You never hand-write the ledger.** Protocol structured facts are recorded (记账) with one script command: `node <this-package>/scripts/ledger.js add <type> --runtime-dir .pi/matt-implement/<feature-slug> [flags]` (`<this-package>` is the directory this skill is installed in).
- **Event types, flags-style (never raw JSON)**: `init` / `dispatch` / `settled` / `verdict` / `fix` / `merge` / `escalate` / `final` / `anomaly` / `pr` / `close` — run `--help` for each type's exact flag set; free text is always `--note`.
- **The script validates before writing**: bad payloads are rejected with a reason — fix and retry immediately (your context is freshest now); state-machine violations and definite git contradictions are rejected outright; facts that are merely not-yet-verifiable (e.g. a worktree not yet in `git worktree list`) come back as warnings and the event is recorded.
- **There are no bypass flags.** When you disagree with the validator, record `anomaly --note "..."` and stop to report.

Three command disciplines:

1. **Record protocol structured facts**: dispatch, settle, verdict, fix dispatch, merge, escalation, the final review's verdict (终审裁决 — one run-level `final` event per round), PR transitions; `close` (封账) seals the run — the ledger flips to `state: complete` and every further record is rejected. Human pause, user decisions, and recovery context belong in orchestration notes, not new events.
2. **Reconcile (对账) before every dispatch and every merge**: `node <this-package>/scripts/ledger.js check --runtime-dir ...` — retain its non-zero exit and every reported difference. On non-zero, pause ordinary dispatches, new ticket merges, and closing. Verify and explain the differences using git, workflow artifacts, findings, and orchestration notes before taking recovery actions that directly resolve those differences. Unknown differences require investigation or user input first. Recovery does not bypass schema, commit existence, effective approval, or irreversible seal checks; never hide drift or edit the ledger. When the run reads a tracker snapshot, its ticket copies are the truth layer — the tracker body is a delayed mirror; correct `Status:` on the snapshot only when supported by verified facts.
3. **Regenerate after compaction**: `node <this-package>/scripts/ledger.js build --runtime-dir ...` prints the full four-section ledger; continue from its output plus the orchestration notes, never from memory.

Review bundles go to `.pi/matt-implement/<feature-slug>/reviews/<NN>-r<k>.diff`, findings to `.../findings/<NN>-r<k>.md` — pass the findings path to the `verdict` event via `--findings`.

## Hard rules

- The orchestrator writes no feature code. Ever.
- Pointers, not content: paths, SHAs, branch names.
- Judge from git truth; run status and child prose are hints, not facts.
- Verdict values: `approved` / `changes_requested` / `ready` / `ready_with_fixes` / `not_ready` — never the string `blocked`.
- Merges are serial; one integration fixer at a time; one writer per worktree.
- Do not manufacture parallelism: dependent work stays serial; only frontier tickets run concurrently.
- Merge commit messages must contain the `ticket-NN` token — the ledger script cross-checks merges by it.
- Never hand-write or edit the ledger or the event stream: no shell appends, no edit tool, no "one-off fix to a cell". The ledger script is the only writer; when you disagree with it, record `anomaly --note "..."` and stop to report.
- On workflow-infrastructure failure (launch, extension, prompt runtime), stop and report the exact failure, run/status, and repo/worktree state. Never fall back to doing the work yourself, and never switch execution modes silently.
- Workflow scripts ship in script-file form: write each dispatch script to a new file under `.pi/matt-implement/<slug>/wf/`, then call it as `workflow: "<path>.js"`.

## Compaction

If context was compacted mid-run: re-read this file, then follow Cold resume in `run/recovery.md` (read it before resuming) — regenerate and reconcile with `node <this-package>/scripts/ledger.js build --runtime-dir .pi/matt-implement/<slug>` followed by `check`, read their output (the printed ledger carries the full state — header, table, timeline, reconciliation — plus any ledger-truth drift item by item) and the orchestration notes (`.pi/matt-implement/<slug>/notes.md`). Continue from that output, not from memory. A fresh session restarting the same command takes the same path: unsealed event stream → skip init and the pull → rebuilt state → frontier.
