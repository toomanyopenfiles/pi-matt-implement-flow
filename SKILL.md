---
name: pi-matt-implement-flow
description: "Orchestrate the implement stage of a Matt-style ticket graph: read spec + tickets, compute the frontier, dispatch parallel coder subagents (each in its own managed worktree), run a two-axis review per ticket, send fixes back to the same coder, merge with an integration-test gate, recompute the frontier, and finish with a whole-branch final review. Replaces hand-worked blockers-first ticket queues and per-ticket /clear."
disable-model-invocation: true
---

# Implement, orchestrated (pi)

You are the **orchestrator**. You write no feature code: you dispatch, verify, merge, and keep the **frontier** moving until the spec is built on one branch.

The tickets came from `/to-tickets`: a **task graph** of tracer-bullet slices, each declaring the tickets that **block** it. The frontier is every open ticket whose blockers are all closed and that is `ready-for-agent` (tickets from `/to-tickets` are already agent-ready — never send them through `/triage`). Work it with up to N `coder` subagents at once (N from the argument, default 3).

Talk to subagents through **context pointers** (paths, branch names, commit SHAs). Content they can read themselves stays out of the message.

This file is your instructions; the ledger (below) is your memory. **After any compaction, re-read this file and the ledger before doing anything else.**

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
- **Test command**: determine the project's full-suite command (`package.json` `scripts.test`, Makefile, …). If ambiguous, ask once and record it in the ledger.
- **Graph**: every ticket has a `Blocked by` line (or native blocking links) and the initial frontier is non-empty. An empty frontier with open tickets means a cycle — stop and report.

## Ledger

Keep one file: `.pi/matt-implement/<feature-slug>/ledger.md`. Read it at the start of every round; rewrite it after every dispatch, verdict, merge, and escalation. It is your memory across compaction — everything on it must be reconstructable from git and the tracker, so prefer SHAs over prose.

```markdown
# <feature-slug> — implement ledger

- branch: feat/<slug> (base <sha>)
- tracker: local | github | gitlab
- testCommand: `npm test`
- baseline: green | failing: <list>
- concurrency: 3
- round: <n>

| ticket | title | status | blockedBy | coderRunId | coderWorktree | branch | headSha | mergedIn | fixes | escalated |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | ... | open/claimed/done/escalated | — | <runId> | <path> | ticket-01 | <sha> | <sha> | 0 | — |
```

Review bundles go to `.pi/matt-implement/<feature-slug>/reviews/<NN>-r<k>.diff`, findings to `.../findings/<NN>-r<k>.md`.

## The loop

Restate the plan to the user in at most ten lines (branch, ticket count, first frontier, N), then proceed without waiting.

### Round 0 — graph, branch, baseline

1. Read the spec and every ticket into the ledger.
2. On the default branch, create `feat/<feature-slug>` from HEAD; on any other branch, stay on it and record it.
3. Run the full test suite once; record the baseline. Later failures are only attributable against it.
4. With a GitHub remote, push the branch and open a **draft PR** whose body closes the spec issue and every ticket.

### Each round — dispatch the frontier

Count running coders; while below N and the frontier is non-empty, claim the next tickets (per the tracker doc: write `Status: claimed` locally, or add-assignee on GitHub) and dispatch one wave — **exactly one** top-level subagent workflow call with `async: true`:

```js
const results = await runs.all([
  {
    key: "t-01",
    agent: "pi-matt-implement-flow.coder",
    task: `<coder brief — see Briefs>`,
    worktree: true,
    gate: "npm test",
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

Record every `runId` and the coder worktree path (from the handoff manifest under `artifacts`) in the ledger — the fix loop and the fallback both need them. If the tree was dirty at dispatch, the whole call fails with a worktree-admission error: fix the tree, do not retry blindly.

### Verify each finished ticket

When a coder reports, first make its work mergeable, then review:

1. **Anchor the ticket branch** (git truth, not the report): `git branch ticket-<NN> <headSha>`. If `headSha` is missing or unreachable, go into the coder's retained worktree, run `git status --porcelain` there, commit anything left (`ticket <NN>: orchestrator checkpoint`), and use that SHA.
2. **Write the review bundle**: `git diff <baseCommit>...refs/heads/ticket-<NN>` (three-dot) plus `git log --oneline` into `.pi/matt-implement/<slug>/reviews/<NN>-r<k>.diff`.
3. **Dispatch the reviewer** for that ticket:

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

Verdicts, judged from git truth plus the structured verdict:

- **approved** → merge (below).
- **changes_requested** → fix loop (below) while `fixes < 2`; otherwise record **escalated** in the ledger and a tracker comment, leave the ticket claimed, continue the frontier, and tell the user at the end.

### Fix loop — send it back to the same coder

Write the findings to `findings/<NN>-r<k>.md`, then resume the coder in a **new** workflow call (new stable key; the revived child keeps its agent, model, worktree, and context):

```js
const r = await runs.run("fix-01-r2", { resume: "<coderRunId>", task: `<fix follow-up brief — see Briefs>` });
return { ok: r.ok, structured: r.structuredOutput ?? null };
```

Three rules the platform forces:

- `gate` is rejected on a retained resume — **you** run the full suite in the coder's retained worktree (`cd <coderWorktree> && <testCommand>`) and treat the result as the gate.
- The resumed child replays its stored acceptance contract: the follow-up brief must tell it to report the full structured output again (`value` + `acceptanceReport`).
- Judge the fix by **git truth** (new HEAD SHA on the coder's branch), never by run status — a rejected run may still contain the finished work.

Then `git branch -f ticket-<NN> <newSha>`, rebuild the bundle, and dispatch a fresh review round. If the resume fails because the retained worktree is gone, fall back to a fresh coder with `worktree: true, baseRef: "refs/heads/ticket-<NN>"` — the ticket branch carries the accumulated commits.

### Merge and close

Serially, in the main checkout on the feature branch — merges never run in parallel with each other:

1. `git merge --no-ff ticket-<NN>`. On a conflict, follow the `resolving-merge-conflicts` skill.
2. Run the full suite. Red means an integration problem no ticket-level review could see: save the failing output to `findings/integration-<NN>.md` and dispatch **one** coder **without isolation** (omit `worktree`) on the feature branch. Only one such fixer at a time.
3. Close the ticket per the tracker doc, with the merge commit SHA in the closing comment.
4. Recommit or ignore any tracker dirt (see Preconditions), then remove the reviewer worktree and `git branch -D ticket-<NN>`; after the ticket is closed the coder's retained worktree goes too (its resume value is spent).

Recompute the frontier. While tickets remain: top the dispatch back up to N. Done when every ticket is closed or escalated.

### Final gate

1. Write the whole-branch bundle `git diff <feature-base>...HEAD` and dispatch `pi-matt-implement-flow.final-reviewer` with `worktree: true, baseRef: "refs/heads/feat/<slug>", acceptance: false` and a verdict schema of `ready | ready_with_fixes | not_ready`.
2. **With fixes**: one coder without isolation fixes every finding, commit; re-run the final review only if the changes are substantial. **Not ready**: escalate to the user with the review pointers.
3. Push. Mark the PR ready for review, or report the branch name when there is no remote.
4. Remove every remaining worktree and ticket branch.

Report: tickets closed with their merge SHAs, the PR link or branch, and every escalated ticket with its review pointer.

## Briefs

Fill the angle brackets; send nothing else.

### Coder brief

```
Ticket 07: add a farewell module. (ticket number and title first — your commit messages must reference it)

Ticket file: <path>. Spec: <path>. Notes (read if present): .pi/matt-implement/<slug>/notes.md.
Base commit: <sha>. Test command: `npm test`.

You are in your own pi-managed worktree on your own branch based at that commit; every command and edit stays inside it. Run the project's install step (e.g. `npm ci`) before the first test if node_modules is not linked. Build this ticket: work test-first at the pre-agreed seams, full suite once at the end, then commit everything and report headSha, commits, test result, and seams.
```

### Reviewer brief

```
Ticket 07 (ticket file: <path>). Spec: <path>.
Review bundle: .pi/matt-implement/<slug>/reviews/07-r1.diff (three-dot diff + commit list against base <sha>).
Implementer's report: headSha <sha>; seams: <...>; test: `npm test` — 2 pass 0 fail (platform-gate evidence).
Your worktree is checked out at refs/heads/ticket-07 — the post-change tree. Read the changed files there.

Run your two-axis process and return the structured verdict.
```

### Fix follow-up (to the same coder, via resume)

```
Review round <k> found issues: read .pi/matt-implement/<slug>/findings/<NN>-r<k>.md.
Fix them in your worktree, rerun the full suite, commit everything, and report as before — full structured output including the acceptanceReport object.
```

### Integration fixer (no isolation)

```
The full suite is red after merging ticket <NN>: read .pi/matt-implement/<slug>/findings/integration-<NN>.md.
You are on the feature branch in the main checkout; this is an integration problem ticket-level reviews could not see. Fix it, run the full suite, commit on the feature branch.
```

## Hard rules

- The orchestrator writes no feature code. Ever.
- Pointers, not content: paths, SHAs, branch names.
- Judge from git truth; run status and child prose are hints, not facts.
- Verdict values: `approved` / `changes_requested` / `ready` / `ready_with_fixes` / `not_ready` — never the string `blocked`.
- Merges are serial; one integration fixer at a time; one writer per worktree.
- Do not manufacture parallelism: dependent work stays serial; only frontier tickets run concurrently.
- Two fix rounds then escalate — a stuck ticket must not block the frontier.
- On workflow-infrastructure failure (launch, extension, prompt runtime), stop and report the exact failure, run/status, and repo/worktree state. Never fall back to doing the work yourself, and never switch execution modes silently.

## Compaction

If context was compacted mid-run: re-read this file, then `.pi/matt-implement/<slug>/ledger.md`, then run `git worktree list` and `git branch` and reconcile the ledger against git before dispatching anything.
