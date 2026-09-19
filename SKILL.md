---
name: pi-matt-implement-flow
description: "Orchestrate the implement stage of a Matt-style ticket graph: read spec + tickets, compute the frontier, dispatch parallel coder subagents (each in its own managed worktree), run a two-axis review per ticket, send fixes back to the same coder, merge with an integration-test gate, recompute the frontier, and finish with a whole-branch final review. Replaces hand-worked blockers-first ticket queues and per-ticket /clear."
disable-model-invocation: true
---

# Implement, orchestrated (pi)

You are the **orchestrator**. You write no feature code: you dispatch, verify, merge, and keep the **frontier** moving until the spec is built on one branch.

The tickets came from `/to-tickets`: a **task graph** of tracer-bullet slices, each declaring the tickets that **block** it. The frontier is every open ticket whose blockers are all closed and that is `ready-for-agent` (tickets from `/to-tickets` are already agent-ready — never send them through `/triage`). Work it with up to N `coder` subagents at once (N from the argument, default 3).

Talk to subagents through **context pointers** (paths, branch names, commit SHAs). Content they can read themselves stays out of the message.

This file is your instructions; the ledger, the event stream, and the orchestration notes (see Ledger) are your memory. **After any compaction, re-read this file, then run `build` + `check` and read their output before doing anything else.**

## Names you dispatch

Agents are registered as a pi package. Always use the full names — the bare `coder` resolves to the user's `worker` alias, and the bare `reviewer` to the builtin:

- `pi-matt-implement-flow.coder`
- `pi-matt-implement-flow.reviewer`
- `pi-matt-implement-flow.final-reviewer`

Skills are baked into the agents (`tdd`/`codebase-design` for the coder, `code-review` for the reviewers). You never call skills on their behalf. On a merge conflict you follow `resolving-merge-conflicts` yourself.

Verify registration once before the first dispatch (`subagent({ action: "list", capabilities: true })`). If the three agents are missing, stop and tell the user to run `pi install <this package path>`.

## Preconditions

Check all of these before dispatching; on a failure, stop and tell the user what to change.

- **Clean tree**: `git status --porcelain` must be empty (pi rejects worktree dispatch on a dirty tree — untracked files count). If it is dirty, classify first: tracker/ledger runtime files → fix the ignore rules (below); your own pending status writes → commit them as `chore(tickets): ...`; anything else → stop and ask. Never stash on your own.
- **Ignore rules for runtime state**: ensure `.gitignore` covers `.pi/matt-implement/` (append a marked block if missing; mention it once to the user). If the tracker is local markdown and `.scratch/` is not ignored, plan to commit ticket-status writes separately (see the loop).
- **Git repo with at least one commit** (worktrees cannot be created from an unborn HEAD).
- **Tracker**: read `docs/agents/issue-tracker.md` and follow it. If it is missing, fall back to local markdown under `.scratch/<feature-slug>/issues/`; if no ticket directory exists either, stop and ask the user where the tickets are.
- **Spec**: locate it (tracker doc convention, or the user's argument). Every review needs it.
- **Test command**: determine the project's full-suite command (`package.json` `scripts.test`, Makefile, …). If ambiguous, ask once and pass it to the `init` event.
- **Graph**: every ticket has a `Blocked by` line (or native blocking links) and the initial frontier is non-empty. An empty frontier with open tickets means a cycle — stop and report.

## Ledger

Your memory has three layers, each with exactly one owner. Terms (per `CONTEXT.md`): ledger 台账 / event stream 事件流 / orchestration notes 编排笔记 / record 记账 / seal 封账 / reconcile 对账. The old phrase "event log" is retired — never use it.

- **Event stream** — `.pi/matt-implement/<feature-slug>/events.jsonl`. Append-only machine facts and your **only** state write surface: one JSON line per structured event, stamped by the script with the authoritative timestamp, a monotonic sequence number, a format version, and the git HEAD at write time. You never provide timestamps; you never touch this file directly.
- **Ledger** — `.pi/matt-implement/<feature-slug>/ledger.md`. The derived human-readable view (header with `state: running|complete` / ticket table / event timeline / reconciliation). **The script owns its write authority — you never hand-write or edit it, not even one cell.** A drifted or damaged ledger is regenerated deterministically with `build`, never patched.
- **Orchestration notes** — `.pi/matt-implement/<feature-slug>/notes.md`. Prose memory: process narrative, lessons, the user's verbal decisions. Facts ("what happened, when") go to the event stream; prose ("why, what we learned") goes here. Prose never competes with the event stream as a source of truth.

- **You never hand-write the ledger.** Every state transition is recorded (记账) with one script command: `node <this-package>/scripts/ledger.js add <type> --runtime-dir .pi/matt-implement/<feature-slug> [flags]` (`<this-package>` is the directory containing this SKILL.md).
- **Event types, flags-style (never raw JSON)**: `init` / `dispatch` / `settled` / `verdict` / `fix` / `merge` / `escalate` / `anomaly` / `pr` / `close` — run `--help` for each type's exact flag set; free text is always `--note`.
- **The script validates before writing**: bad payloads are rejected with a reason — fix and retry immediately (your context is freshest now); state-machine violations and definite git contradictions are rejected outright; facts that are merely not-yet-verifiable (e.g. a worktree not yet in `git worktree list`) come back as warnings and the event is recorded.
- **There are no bypass flags.** When you disagree with the validator, record `anomaly --note "..."` and stop to report.

Three command disciplines:

1. **Record on every state transition**: dispatch, settle, verdict, fix dispatch, merge, escalation, PR transitions; `close` (封账) seals the run — the ledger flips to `state: complete` and every further record is rejected.
2. **Reconcile (对账) before every dispatch and every merge**: `node <this-package>/scripts/ledger.js check --runtime-dir ...` — non-zero exit means ledger-truth drift, listed item by item. Fix the world to match truth or truth to match the world; never the ledger by hand.
3. **Regenerate after compaction**: `node <this-package>/scripts/ledger.js build --runtime-dir ...` prints the full four-section ledger; continue from its output plus the orchestration notes, never from memory.

Review bundles go to `.pi/matt-implement/<feature-slug>/reviews/<NN>-r<k>.diff`, findings to `.../findings/<NN>-r<k>.md` — pass the findings path to the `verdict` event via `--findings`.

## The loop

Restate the plan to the user in at most ten lines (branch, ticket count, first frontier, N), then proceed without waiting.

### Round 0 — graph, branch, baseline

1. Read the spec and every ticket, then record `init`（记账）— `--branch --branch-base --baseline-sha --spec --test-command --tracker` — as the ledger's first event. Everything downstream is derived from it; the baseline the init pins is what later failures are attributable against.
2. **Environment survey**: read `.gitignore` and enumerate every runtime path a coder worktree will not contain (`.scratch/`, `.pi/`, `data/`, …). Write the survey into a **环境事实 (environment facts)** section of the orchestration notes with exactly three elements: the gitignored path list, where real data actually lives, and the validation discipline (validate against real data through the scratch directory). Every coder brief's Worktree-reality parenthetical and its data paths are picked per ticket from this section — filtering is your job; coordination prose (routing decisions, user rulings, process narrative) never enters a brief, and coders never read the notes file whole. The survey is prose: it lands only in the orchestration notes, never in the event stream (no new event type).
3. On the default branch, create `feat/<feature-slug>` from HEAD; on any other branch, stay on it and record it.
4. Run the full test suite once; record the baseline (green or the failing list) in the orchestration notes.
5. With a GitHub remote, push the branch and open a **draft PR** whose body closes the spec issue and every ticket; record `pr --state opened-draft`.

Optionally, when a survey finding is a durable repo-level lesson (e.g. a CLI syntax trap), suggest graduating it into the committed `AGENTS.md` — coder worktrees carry committed files automatically, at zero brief cost.

### Each round — dispatch the frontier

Count running coders; while below N and the frontier is non-empty, claim the next tickets (per the tracker doc: write `Status: claimed` locally, or add-assignee on GitHub) and dispatch one wave — **exactly one** top-level subagent workflow call with `async: true`:

```js
const results = await runs.all([
  {
    key: "t-01",
    agent: "pi-matt-implement-flow.coder",
    task: `<coder brief — see Briefs>`,
    worktree: true,
    acceptance: {
      level: "verified",
      criteria: [
        "Implement the requested change without widening scope",
        "Return evidence sufficient for an independent acceptance review"
      ],
      evidence: ["changed-files", "tests-added", "commands-run", "validation-output", "residual-risks", "no-staged-files"],
      report: "on",
      verify: [{ id: "gate", command: "npm test", timeoutMs: 600000 }]
    },
    outputSchema: {
      type: "object",
      properties: {
        headSha: { type: "string" },
        branch: { type: "string" },
        commits: { type: "array", items: { type: "object", properties: { sha: { type: "string" }, message: { type: "string" } }, required: ["sha", "message"] } },
        testResult: { type: "string" },
        seams: { type: "array", items: { type: "string" } }
      },
      required: ["headSha", "branch", "commits", "testResult", "seams"]
    }
  }
  // ...one entry per claimed ticket, up to N
]);
return results.map(r => ({ key: r.key, ok: r.ok, runId: r.runId ?? null, structured: r.structuredOutput ?? null, artifacts: r.artifactPaths ?? null }));
```

Record each child as a `dispatch` event（记账：`--ticket --key --run-id`，`--worktree` 取自 handoff manifest 的 `artifacts`）— the fix loop, the fallback, and compaction recovery all read them from the event stream. If the tree was dirty at dispatch, the whole call fails with a worktree-admission error: fix the tree, do not retry blindly.

- **Why an explicit `acceptance` object instead of the `gate` shorthand** (they are mutually exclusive): it pins the evidence contract at dispatch time instead of letting the platform infer it from task wording.
- **`report: "on"`** moves the report-format checks into the final `structured_output` call — a missing or malformed `acceptanceReport` fails the tool call and the coder retries in-session, instead of the whole run being rejected after the child is gone; it also injects the exact report field list into the coder's prompt, so field names are no longer guessed.
- **Gate timeout**: the platform's verify-command default is a fixed 120 s — too short for full suites in a cold worktree, and the constant is not configurable; the dispatch pins `timeoutMs: 600000` (10 min) per verify entry.
- **Remaining limit**: evidence *completeness* (e.g. a present-but-empty `validationOutput`) is still checked only at run settlement — that is what the `## Acceptance Contract` block in the brief covers. `outputSchema` is required for `report: "on"` (the dispatch above already has it).
- **The fix loop** needs no acceptance of its own: a retained resume replays the stored contract, so the follow-up brief only has to ask for the full report again.

### Verify each finished ticket

When a coder reports, first make its work mergeable, then review:

1. **Anchor the ticket branch** (git truth, not the report): `git branch ticket-<NN> <headSha>`. If `headSha` is missing or unreachable, go into the coder's retained worktree, run `git status --porcelain` there, commit anything left (`ticket <NN>: orchestrator checkpoint`), and use that SHA.
2. **Write the review bundle**: `git diff <baseCommit>...refs/heads/ticket-<NN>` (three-dot) plus `git log --oneline` into `.pi/matt-implement/<slug>/reviews/<NN>-r<k>.diff`.
3. **Record `settled`**（记账：`--ticket --round --head-sha --worktree --gate` 一句门禁摘要）— the ticket's headSha and worktree are now anchored in the event stream.
4. **Dispatch the reviewer** for that ticket:

```js
const results = await runs.all([
  {
    key: "rev-01",
    agent: "pi-matt-implement-flow.reviewer",
    task: `<reviewer brief — see Briefs>`,
    worktree: true,
    baseRef: "refs/heads/ticket-01",
    acceptance: false,
    outputSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
        standards: { type: "string" },
        spec: { type: "string" },
        findings: { type: "array", items: { type: "object", properties: { severity: { type: "string" }, file: { type: "string" }, line: { type: "string" }, issue: { type: "string" } }, required: ["severity", "file", "issue"] } }
      },
      required: ["verdict", "standards", "spec", "findings"]
    }
  }
]);
```

(`acceptance: false` — the reviewer is read-only; the platform gate already covered tests. Never use the verdict value `blocked`; that string has unrelated lane semantics.)

On a verdict, record it: `verdict`（记账：`--ticket --round --verdict --findings <path> --rev-run-id`）— reviewer dispatches are not recorded as separate events; `--rev-run-id` carries them. Judged from git truth plus the structured verdict:

- **approved** → merge (below).
- **changes_requested** → fix loop (below); if the script rejects the fix because two rounds are already dispatched, record **`escalate`** and a tracker comment instead, leave the ticket claimed, continue the frontier, and tell the user at the end.

### Fix loop — send it back to the same coder

Write the findings to `findings/<NN>-r<k>.md`. **Record the fix first**: `fix`（记账：`--ticket --fix-no --key --resume-run-id <coderRunId>`）— the budget is consumed at dispatch time, and the script mechanically rejects a third fix; that rejection is the escalation trigger. Then resume the coder in a **new** workflow call (new stable key; the revived child keeps its agent, model, worktree, and context):

```js
const r = await runs.run("fix-01-r2", { resume: "<coderRunId>", task: `<fix follow-up brief — see Briefs>` });
return { ok: r.ok, structured: r.structuredOutput ?? null };
```

Three rules the platform forces:

- `gate` is rejected on a retained resume — **you** run the full suite in the coder's retained worktree (`cd <coderWorktree> && <testCommand>`) and treat the result as the gate.
- The resumed child replays its stored acceptance contract: the follow-up brief must tell it to report the full structured output again (`value` + `acceptanceReport`).
- Judge the fix by **git truth** (new HEAD SHA on the coder's branch), never by run status — a rejected run may still contain the finished work.

Then `git branch -f ticket-<NN> <newSha>`, rebuild the bundle, and dispatch a fresh review round. If the resume fails because the retained worktree is gone, fall back to a fresh coder with `worktree: true, baseRef: "refs/heads/ticket-<NN>"` — the ticket branch carries the accumulated commits; record that fallback as a `fix` event too (new `--key`，`--resume-run-id` = the run it replaces).

### Merge and close

Serially, in the main checkout on the feature branch — merges never run in parallel with each other:

1. `git merge --no-ff -m "Merge ticket-<NN>: <title>" ticket-<NN>` — the message **must** contain the `ticket-<NN>` token (hard rule below; the ledger script cross-checks merges by it). On a conflict, follow the `resolving-merge-conflicts` skill.
2. Run the full suite. Red means an integration problem no ticket-level review could see: save the failing output to `findings/integration-<NN>.md` and dispatch **one** coder **without isolation** (omit `worktree`) on the feature branch. Only one such fixer at a time.
3. Record `merge`（记账：`--ticket --head-sha --merge-sha`）— the script verifies the merge commit exists, sits on the feature branch, and carries the token. Then close the ticket per the tracker doc, with the merge commit SHA in the closing comment.
4. Recommit or ignore any tracker dirt (see Preconditions), then remove the reviewer worktree and `git branch -D ticket-<NN>`; after the ticket is closed the coder's retained worktree goes too (its resume value is spent).

Recompute the frontier. While tickets remain: top the dispatch back up to N. Done when every ticket is closed or escalated.

### Final gate

1. Write the whole-branch bundle `git diff <feature-base>...HEAD` and dispatch `pi-matt-implement-flow.final-reviewer` with `worktree: true, baseRef: "refs/heads/feat/<slug>", acceptance: false` and a verdict schema of `ready | ready_with_fixes | not_ready`.
2. **With fixes**: one coder without isolation fixes every finding, commit; re-run the final review only if the changes are substantial. **Not ready**: escalate to the user with the review pointers.
3. Push. Mark the PR ready for review, or report the branch name when there is no remote; record `pr --state ready` if a PR exists.
4. Remove every remaining worktree and ticket branch.
5. **封账**: record `close` — the ledger flips to `state: complete`, and a sealed run can never be mistaken for an active one by the next session.

Report: tickets closed with their merge SHAs, the PR link or branch, and every escalated ticket with its review pointer.

## Briefs

Fill the angle brackets; send nothing else.

**Path rule for all briefs**: any path that does not physically exist inside the recipient's worktree (everything gitignored — `.scratch/`, `.pi/`, `data/`, …) is given as an absolute main-repo path and marked read-only. The rule covers all four brief templates below; there are no special cases for isolation shape.

### Coder brief

```
Ticket 07: add a farewell module. (ticket number and title first — your commit messages must reference it)

Ticket file: <absolute main-repo path>. Spec: <absolute main-repo path>.
Base commit: <sha>. Test command: `npm test`.

## Worktree reality
Your worktree contains ONLY committed files — everything gitignored (data/, .scratch/,
.pi/, …) does not exist inside it. The ticket, spec, findings, and data paths in this
brief are absolute main-repo paths (read-only). Everything you edit and commit stays
inside your own worktree. Other tickets under .scratch/ and anything else in the main
repo are context, not scope — never implement them.

You are in your own pi-managed worktree on your own branch based at that commit; every command and edit stays inside it. Run the project's install step (e.g. `npm ci`) before the first test if node_modules is not linked. Build this ticket: work test-first at the pre-agreed seams, full suite once at the end, then commit everything and report headSha, commits, test result, and seams.

## Acceptance Contract
Your final structured_output call must have TWO SIBLING top-level keys (never nested):
- value: { headSha, branch, commits, testResult, seams }
- acceptanceReport: { criteriaSatisfied, changedFiles, testsAddedOrUpdated, commandsRun, validationOutput, residualRisks, noStagedFiles }
Rules:
- validationOutput carries the VERBATIM key lines of the gate command you ran (e.g. "274 passed in 40.35s") — never null, never empty, never a paraphrase; an empty validationOutput fails the run.
- testsAddedOrUpdated lists every test file you created or modified; use [] only when none.
- criteriaSatisfied[].id must match the criteria above, answered with concrete proof.
- Empty-but-applicable is fine ([]); MISSING fields are not — missing evidence rejects the run.
```

### Reviewer brief

```
Ticket 07 (ticket file: <absolute main-repo path>). Spec: <absolute main-repo path>.
Review bundle: <absolute main-repo path>/.pi/matt-implement/<slug>/reviews/07-r1.diff (three-dot diff + commit list against base <sha>).
Implementer's report: headSha <sha>; seams: <...>; test: `npm test` — 2 pass 0 fail (platform-gate evidence).
Your worktree is checked out at refs/heads/ticket-07 — the post-change tree. Read the changed files there; review-bundle and findings paths are main-repo paths (read-only).

Run your two-axis process and return the structured verdict.
```

### Fix follow-up (to the same coder, via resume)

```
Review round <k> found issues: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/<NN>-r<k>.md.
Fix them in your worktree, rerun the full suite, commit everything, and report exactly as before — the full structured output with value and acceptanceReport as SIBLING top-level keys (never nested), every `## Acceptance Contract` field filled: validationOutput with the real rerun output (verbatim pass/fail lines, never null), testsAddedOrUpdated listing any test files touched ([] only if none).
```

### Integration fixer (no isolation)

```
The full suite is red after merging ticket <NN>: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/integration-<NN>.md.
You are on the feature branch in the main checkout; this is an integration problem ticket-level reviews could not see. Fix it, run the full suite, commit on the feature branch.
```

## Hard rules

- The orchestrator writes no feature code. Ever.
- Pointers, not content: paths, SHAs, branch names.
- Judge from git truth; run status and child prose are hints, not facts.
- Verdict values: `approved` / `changes_requested` / `ready` / `ready_with_fixes` / `not_ready` — never the string `blocked`.
- Merges are serial; one integration fixer at a time; one writer per worktree.
- Do not manufacture parallelism: dependent work stays serial; only frontier tickets run concurrently.
- Two fix rounds then escalate — a stuck ticket must not block the frontier. The ledger script enforces this at the write point; do not argue with the rejection, escalate.
- Merge commit messages must contain the `ticket-NN` token — the ledger script cross-checks merges by it.
- Never hand-write or edit the ledger or the event stream: no shell appends, no edit tool, no "one-off fix to a cell". The ledger script is the only writer; when you disagree with it, record `anomaly --note "..."` and stop to report.
- On workflow-infrastructure failure (launch, extension, prompt runtime), stop and report the exact failure, run/status, and repo/worktree state. Never fall back to doing the work yourself, and never switch execution modes silently.

## Compaction

If context was compacted mid-run: re-read this file, then regenerate and reconcile — `node <this-package>/scripts/ledger.js build --runtime-dir .pi/matt-implement/<slug>` followed by `check` — and read their output: the printed ledger carries the full state (header, table, timeline, reconciliation) plus any ledger-truth drift item by item. Then read the orchestration notes (`.pi/matt-implement/<slug>/notes.md`). Continue from that output, not from memory.
