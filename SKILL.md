---
name: pi-matt-implement-flow
description: "Orchestrate the implement stage of a Matt-style ticket graph: read spec + tickets, compute the frontier, dispatch parallel coder subagents (each in its own managed worktree), run a two-axis review per ticket, send fixes back to the same coder, merge with an integration-test gate, recompute the frontier, and finish with a whole-branch final review. Replaces hand-worked blockers-first ticket queues and per-ticket /clear."
disable-model-invocation: true
---

# Implement, orchestrated (pi)

You are the **orchestrator**. You write no feature code: you dispatch, verify, merge, and keep the **frontier** moving until the spec is built on one branch.

The tickets came from `/to-tickets`: a **task graph** of tracer-bullet slices, each declaring the tickets that **block** it. The frontier is every open ticket whose blockers are all closed and that is `ready-for-agent` (tickets from `/to-tickets` are already agent-ready — never send them through `/triage`). Work it with up to N `coder` subagents at once. N comes from the skill argument (`/pi-matt-implement-flow [N]`); otherwise from `mattImplementFlow.maxConcurrent` in pi settings; otherwise 3.

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
- **Ignore rules for runtime state**: ensure `.gitignore` covers `.pi/matt-implement/` (append a marked block if missing; mention it once to the user). If ticket-status writes would dirty git (a git-visible truth layer, e.g. `.scratch/`) and that directory is not ignored, plan to commit ticket-status writes separately (see the loop).
- **Git repo with at least one commit** (worktrees cannot be created from an unborn HEAD).
- **Tracker setup artifacts (范本识别)**: the issue tracker should have been provided to you — the target repo's `docs/agents/issue-tracker.md` (with the `triage-labels.md` beside it), pointed at from its `## Agent skills` block. Both are `/setup-matt-pocock-skills` products and the run's single tracker configuration — there is no `--tracker` flag repeating the choice. At every tracker-touching ledger command (`init` / `snapshot-init` / `claim` / `sync`) the script reads the artifacts, identifies the upstream template (H1 heading + anchor phrases; user-edited prose is tolerated), and loads the matching contract preset. Two conditions are explicit stop-and-report failures, never a guess, a degradation, or a derived wizard: **artifact missing** → tell the user to run `/setup-matt-pocock-skills` and stop; **template unrecognized** → the script refuses with `仅支持 local / github / gitlab 三种` — pass that refusal on and stop. Follow that file; if the tickets it names cannot be found, stop and ask the user where they are.
- **Contract capabilities (按契约能力执行)**: every tracker difference in this file is a declared capability of the identified contract, never a per-tracker branch — reading this file tells you the behavior because the behavior follows the capabilities. Which tracker steps exist at all (snapshot pull, pre-seal sync, 占坑) is likewise a declaration: contracts with a tracker write surface have them, contracts where the ticket files are the truth layer have none (zero change). The four capabilities that shape the flow:
  - **占坑强度 (claim strength)**: the spec claim is an advisory lock — it reserves the feature and stops a second session before it writes; it is not an atomic mutex.
  - **closeWithComment**: whether a close carries its closing comment in one action, or the comment is noted first and the close follows — the pre-seal sync orders the actions.
  - **收尾面 (closing surface)**: the review surface the feature branch closes through — a PR, an MR, or none; the pre-seal sync always precedes marking it ready.
  - **票集边来源 (ticket-set edges)**: where the ticket set's blocking edges come from — native sub-issues, parent look-ups, or the declared ticket list.
- **Spec 引用 (spec reference)**: the identifier that locates this run's spec (tracker doc convention, or the user's argument), in the reference form the identified contract declares — a spec file path, or a native ticket reference (`42` / `#42` / a full issue URL). Every review needs it; the `init` event pins the local spec file it resolves to.
- **占坑 (claim the spec)** — when the contract has a claim (a tracker write surface), it is the run's first write on the tracker, before any pull: `node <this-package>/scripts/ledger.js claim --runtime-dir .pi/matt-implement/<slug> --spec <spec 引用>` — the contract's claim template reserves the spec to this run so the tracker shows the feature as in-flight. Conflicts (the spec already claimed by someone else) come back as a script refusal naming the assignee: stop and ask before any further write — change target, take over, or coordinate. The claim is released at the end: the pre-seal sync closes the spec, or the abandon sync (`sync --mode abandon`) unassigns it. Contracts without a tracker write surface have no claim step — the ticket files are the truth layer (zero change).
- **Test command**: determine the project's full-suite command (`package.json` `scripts.test`, Makefile, …). If ambiguous, ask once and pass it to the `init` event.
- **Graph**: every ticket has a `Blocked by` line (or a native blocking link, where the contract's edge sources provide one) and the initial frontier is non-empty. An empty frontier with open tickets means a cycle — stop and report.

## Flow configuration

This run's shape — whether each ticket gets a reviewer and the coder concurrency — is read from the package-private `mattImplementFlow` key in pi settings (`<repo>/.pi/settings.json` wins per field over `~/.pi/agent/settings.json`; never write any other settings key), then **frozen as `init` flags** in the ledger:

| key | default | meaning |
|---|---|---|
| `reviewer` | `true` | per-ticket two-axis review + fix loop; `false` = merge straight after the platform test gate (the whole-branch final-reviewer still runs) |
| `maxConcurrent` | `3` | parallel coders; the skill argument wins |

Pass them to `init` as `--reviewer on|off --max-concurrent N`; omitted flags mean the defaults. The ledger script enforces the frozen shape from that point on: with `reviewer=off` it rejects `verdict`/`fix` events and lets `merge` proceed without a verdict. Configure via `/matt-flow-config` → "Configure flow options"; changes apply from the next run's `init`, never mid-run.

## Ledger

Your memory has three layers, each with exactly one owner. Terms (per `CONTEXT.md`): ledger 台账 / event stream 事件流 / orchestration notes 编排笔记 / record 记账 / seal 封账 / reconcile 对账. The old phrase "event log" is retired — never use it.

- **Event stream** — `.pi/matt-implement/<feature-slug>/events.jsonl`. Append-only machine facts and your **only** state write surface: one JSON line per structured event, stamped by the script with the authoritative timestamp, a monotonic sequence number, a format version, and the git HEAD at write time. You never provide timestamps; you never touch this file directly.
- **Ledger** — `.pi/matt-implement/<feature-slug>/ledger.md`. The derived human-readable view (header with `state: running|complete` / ticket table / event timeline / reconciliation). **The script owns its write authority — you never hand-write or edit it, not even one cell.** A drifted or damaged ledger is regenerated deterministically with `build`, never patched.
- **Orchestration notes** — `.pi/matt-implement/<feature-slug>/notes.md`. Prose memory: process narrative, lessons, the user's verbal decisions. Facts ("what happened, when") go to the event stream; prose ("why, what we learned") goes here. Prose never competes with the event stream as a source of truth.

- **You never hand-write the ledger.** Every state transition is recorded (记账) with one script command: `node <this-package>/scripts/ledger.js add <type> --runtime-dir .pi/matt-implement/<feature-slug> [flags]` (`<this-package>` is the directory containing this SKILL.md).
- **Event types, flags-style (never raw JSON)**: `init` / `dispatch` / `settled` / `verdict` / `fix` / `merge` / `escalate` / `final` / `anomaly` / `pr` / `close` — run `--help` for each type's exact flag set; free text is always `--note`.
- **The script validates before writing**: bad payloads are rejected with a reason — fix and retry immediately (your context is freshest now); state-machine violations and definite git contradictions are rejected outright; facts that are merely not-yet-verifiable (e.g. a worktree not yet in `git worktree list`) come back as warnings and the event is recorded.
- **There are no bypass flags.** When you disagree with the validator, record `anomaly --note "..."` and stop to report.

Three command disciplines:

1. **Record on every state transition**: dispatch, settle, verdict, fix dispatch, merge, escalation, the final review's verdict (终审裁决 — one run-level `final` event per round), PR transitions; `close` (封账) seals the run — the ledger flips to `state: complete` and every further record is rejected.
2. **Reconcile (对账) before every dispatch and every merge**: `node <this-package>/scripts/ledger.js check --runtime-dir ...` — retain its non-zero exit and every reported difference. On non-zero, pause ordinary dispatches, new ticket merges, and closing. Verify and explain the differences using git, workflow artifacts, findings, and orchestration notes before taking recovery actions that directly resolve those differences. Unknown differences require investigation or user input first. Recovery does not bypass schema, commit existence, effective approval, or irreversible seal checks; never hide drift or edit the ledger. When the run reads a tracker snapshot, its ticket copies are the truth layer — the tracker body is a delayed mirror; correct `Status:` on the snapshot only when supported by verified facts.
3. **Regenerate after compaction**: `node <this-package>/scripts/ledger.js build --runtime-dir ...` prints the full four-section ledger; continue from its output plus the orchestration notes, never from memory.

Review bundles go to `.pi/matt-implement/<feature-slug>/reviews/<NN>-r<k>.diff`, findings to `.../findings/<NN>-r<k>.md` — pass the findings path to the `verdict` event via `--findings`.

## The loop

Restate the plan to the user in at most ten lines (branch, ticket count, first frontier, N), then proceed without waiting.

### Repair decisions — every repair stage

For ticket, integration, and final-review repairs, verify the coder's actual actions, validation results, new problems or scope changes, and evidence pointers after each return; coder self-assessment alone is not proof. This is a decision framework, not a new report form.

Continue when there is a reasonable, evidence-backed next step within the **approved scope**. New diagnostic evidence can justify continuing even while tests remain red. **Continuous failures** call for re-examining the evidence and changing the method, not an automatic attempt-count stop. Commit counts, switching an agent, or changes in wording alone do not show progress. Keep tests, acceptance criteria, and safety constraints intact.

Pause and **request the user** when requirements decisions, permissions, external conditions, or an evidence-backed next step are missing. Explain the blocker, evidence, and required input in the orchestration notes. Preserve command timeouts, the concurrency limit, and the ability to cancel children; continuing does not guarantee bounded total time or cost.

### Cold resume (续跑) — the same command, an unfinished run

Before Round 0, check whether this run already exists: if `.pi/matt-implement/<slug>/events.jsonl` exists and the ledger header reads `state: running` (not sealed), the same command is a **continuation (续跑)**, not a new run — skip ahead and keep going:

1. **Skip init and the pull — both.** Never re-record `init` (the script rejects a second one), and never re-run `snapshot-init`: an existing snapshot is refused, never overwritten or re-pulled — a re-pull would let the tracker's lagging state overwrite the local truth (ADR-0003). The refusal is the continuation guard, not an error to work around. **One recovery wedge inside the guard**: if the snapshot already exists but the event stream carries **no `init` event** (a crash between `snapshot-init` and the `init` recording — the pull landed, the ledger did not), record `init` with `--spec .pi/matt-implement/<slug>/tracker/spec.md`, the snapshot's own spec copy — the truth layer enumerates ticket files by the same `dirname(spec)/issues/` convention — and continue with the rest of Round 0; the pull is still never re-run.
2. **Rebuild, then reconcile**: `node <this-package>/scripts/ledger.js build --runtime-dir .pi/matt-implement/<slug>` (台账再生) followed by `check` (对账); read their output — the regenerated ledger carries the full state and any ledger-truth drift item by item — then read the orchestration notes.
3. **Recover the interrupted stage before ordinary progress**: read the notes and referenced evidence alongside git and workflow artifacts. If an unrecorded merge is awaiting integration validation, explain that check difference and dispatch only the integration fixer needed for it (Merge and close below); leave unrelated tickets and new merges paused. Validation must pass before recording `merge` and completing the ticket. For other differences, follow the reconciliation discipline above. Once reconciled, continue the remaining frontier, fix loop, merges, or final gate from the verified state, not just the last recorded event.

For every unfinished old run, historical repair budgets no longer limit attempts: explain the new repair rules to the user on resume. Leave old settings, init fields, and event lines unchanged; they are readable history, not active quotas. Sealed runs are historical only — never reopen them.

(续跑 is a run-level action. A subagent's retained-context resume inside the loop is a platform mechanism — the glossary keeps the two apart.)

### Round 0 — graph, branch, baseline

1. Read the spec and every ticket, resolve the flow configuration (above), then record `init`（记账）— `--branch --branch-base --baseline-sha --spec --test-command [--reviewer on|off --max-concurrent N --tickets 01,02,1042]` — as the ledger's first event. There is no `--tracker` flag: the script auto-identifies the tracker from the setup artifacts and records the identified tracker with the event. The flow flags freeze this run's shape; everything downstream is derived from it; the baseline the init pins is what later failures are attributable against. `--tickets` (the same list snapshot-init takes) freezes the run's ticket-set boundary — once recorded, out-of-boundary dispatches are refused mid-run; omit it when the set resolves from the contract's edge sources (native sub-issues / parent look-ups). `--spec` is the spec file the run actually reads:
   - **The contract materializes a tracker snapshot** — pull first, read after: `node <this-package>/scripts/ledger.js snapshot-init --runtime-dir .pi/matt-implement/<slug> --spec <spec 引用>`（the reference form the contract declares；add `--tickets 01,02,1042` only when the ticket-set resolution needs the fallback list）materializes the whole tracker into the **tracker snapshot** under `.pi/matt-implement/<slug>/tracker/` — the spec with a `Source:` line for its tracker origin, one local-shaped file per ticket. The snapshot is the pending-push truth; the tracker body is its delayed mirror, not written to mid-run. From here on the orchestrator, the coder briefs, the ledger, and both reviewers read and write those local paths with zero form fork, and `init`'s `--spec` is the snapshot's `spec.md`. A refusal because a snapshot already exists is the continuation guard — the run already started; go to Cold resume (above).
   - **The truth layer is already the local files** — nothing to pull: the spec and tickets under `.scratch/<slug>/` are the local files every brief has always pointed at (zero change).
2. **Environment survey**: read `.gitignore` and enumerate every runtime path a coder worktree will not contain (`.scratch/`, `.pi/`, `data/`, …). Write the survey into a **环境事实 (environment facts)** section of the orchestration notes with exactly three elements: the gitignored path list, where real data actually lives, and the validation discipline (validate against real data through the scratch directory). Every coder brief's Worktree-reality parenthetical and its data paths are picked per ticket from this section — filtering is your job; coordination prose (routing decisions, user rulings, process narrative) never enters a brief, and coders never read the notes file whole. The survey is prose: it lands only in the orchestration notes, never in the event stream (no new event type).
3. On the default branch, create `feat/<feature-slug>` from HEAD; on any other branch, stay on it and record it.
4. Run the full test suite once; record the baseline (green or the failing list) in the orchestration notes.
5. With a remote, push the branch and open a **draft closing surface** — a PR where the host runs pull requests, an MR where it runs merge requests — whose body's closing keywords cover the spec and merged tickets only — escalated tickets stay open (their sync keeps them open with an explanatory comment), so never list them in the closing list; record `pr --state opened-draft`.

Optionally, when a survey finding is a durable repo-level lesson (e.g. a CLI syntax trap), suggest graduating it into the committed `AGENTS.md` — coder worktrees carry committed files automatically, at zero brief cost.

### Each round — dispatch the frontier

Count running coders; while below N and the frontier is non-empty, claim the next tickets（认领）— write `Status: claimed` on the ticket's truth-layer file — the tracker snapshot's copy when the run reads one, the ticket file itself when the files are the truth layer; never a tracker-body write — tracker-side progress happens only at the pre-seal sync — and dispatch one wave. Dispatch delivery is always script-file form: **write the script below to a new file** `.pi/matt-implement/<slug>/wf/wave-<NN>.js` (one new file per call — the audit report recovers briefs from these files), then make one top-level `subagent` call naming that file: `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/wave-<NN>.js", async: true })`:

```js
const results = await runs.all([
  {
    key: "t-01",
    agent: "pi-matt-implement-flow.coder",
    task: `<coder brief — see Briefs>`,
    worktree: true,
    gate: {
      command: "node <this-package>/scripts/mechanical-report.js --base <baseCommit> --test-command \"<testCommand>\"",
      output: "json",
      schema: {
        type: "object",
        required: ["headSha", "testResult", "changedFiles", "validationOutput"],
        properties: {
          headSha: { type: "string" },
          testResult: { type: "string" },
          changedFiles: { type: "array", items: { type: "string" } },
          validationOutput: { type: "array", items: { type: "string" } }
        },
        additionalProperties: false
      },
      timeoutMs: 600000
    }
  }
  // ...one entry per claimed ticket, up to N
]);
return results.map(r => ({ key: r.key, ok: r.ok, runId: r.runId ?? null, structured: r.structuredOutput ?? null, artifacts: r.artifactPaths ?? null }));
```

The `schema` in the dispatch above is a copy of the mechanical-report contract. Its single source of truth is `scripts/mechanical-report.js` (`REPORT_SCHEMA`, self-describing via `--print-schema`) — the copy must stay verbatim-identical (the self-check cross-compares them; drift fails the suite):

```json
{
  "type": "object",
  "required": [
    "headSha",
    "testResult",
    "changedFiles",
    "validationOutput"
  ],
  "properties": {
    "headSha": {
      "type": "string"
    },
    "testResult": {
      "type": "string"
    },
    "changedFiles": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "validationOutput": {
      "type": "array",
      "items": {
        "type": "string"
      }
    }
  },
  "additionalProperties": false
}
```

Record each child as a `dispatch` event（记账：`--ticket --key --run-id`，`--worktree` 取自 handoff manifest 的 `artifacts`）— the fix loop, the fallback, and compaction recovery all read them from the event stream. If the tree was dirty at dispatch, the whole call fails with a worktree-admission error: fix the tree, do not retry blindly.

- **Why a typed `gate` instead of an `acceptance` object** (they are mutually exclusive — a child has exactly one structured-output source): the report is assembled host-side, after the child ends, by a script from git truth plus a real test run — double-encoding and dropped fields are structurally impossible. The gate's stdout becomes the structured output and its exit code is the verdict, so you never parse model prose to decide a run.
- **stdout contract**: the gate command must print a single JSON document of at most 12,000 characters; empty, truncated, non-JSON, or schema-mismatched output fails the gate fail-closed. The script keeps itself inside the limit (over-long output is truncated and marked, never fatal).
- **Gate timeout**: the platform's verify default is a fixed 120 s — too short for full suites in a cold worktree, and the constant is not configurable; the dispatch pins `timeoutMs: 600000` (10 min) on the gate object.
- **Mutual exclusion (iron rule)**: `gate`, a non-`false` `acceptance` object, and `outputSchema` are three-way exclusive — the coder dispatch carries the gate and neither of the other two (`acceptance: false` counts as omitted — what the read-only reviewer dispatch and the fix-loop resumes below use; beside a `gate` it is no shield: the gate still normalizes into a `verified` acceptance carrying its report duty, so `acceptance: false` never de-risks a gate dispatch).
- **The fix loop** runs the same gate by hand (below): a gate is rejected on a retained resume, so you execute the identical script command in the retained worktree — the same standard every round, no second track.

### Verify each finished ticket

When a coder reports, first make its work mergeable, then review. The **formal-review round** `<k>` is independent of fix attempts: use the next unused review ordinal; the same ticket and same round cannot receive a duplicate formal verdict. Multiple repairs may follow one review before the next full review. To re-review without a new `fix`, obtain a fresh hand-run gate, bundle, and `settled` for the candidate, then dispatch the complete reviewer process below under the next round.

1. **Anchor the ticket branch** (git truth, not the report): `git branch ticket-<NN> <headSha>` (the `<headSha>` is the gate report's — mechanical truth, not model prose). If `headSha` is missing or unreachable, go into the coder's retained worktree, run `git status --porcelain` there, commit anything left (`ticket <NN>: orchestrator checkpoint`), and use that SHA.
2. **Write the review bundle**: `git diff <baseCommit>...refs/heads/ticket-<NN>` (three-dot) plus `git log --oneline` into `.pi/matt-implement/<slug>/reviews/<NN>-r<k>.diff`.
3. **Record `settled`**（记账：`--ticket --round --head-sha --worktree --gate` 一句门禁摘要）— the ticket's headSha and worktree are now anchored in the event stream; the `--gate` summary is the fresh gate report's `testResult` line.
4. **Dispatch the reviewer** for that ticket — only when the run's init snapshot has `reviewer=on` (the default). With `reviewer=off`, skip this step and the fix loop entirely and go straight to the merge: the platform gate and the post-merge integration suite are the remaining per-ticket defenses, and the whole-branch final-reviewer still runs at the end. Script-file delivery: write the script below to a new file `.pi/matt-implement/<slug>/wf/review-<NN>-r<k>.js`, then call `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/review-<NN>-r<k>.js", async: true })`:

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

- **approved** → check that the full approval and fresh validation evidence cover the **current candidate** before merging (below). Clarification, single-finding withdrawal, notes, or anomaly cannot substitute for `approved`; while the latest full verdict is `changes_requested`, do not merge. The `reviewer=off` exception above is unchanged.
- **changes_requested** → use **Repair decisions** to choose the next repair (fix loop below), a further complete formal review when no code repair is needed, or a request for user input.

### Fix loop — send it back to the same coder (reviewer=on runs only)

Write the findings to `findings/<NN>-r<k>.md`. **Record the fix first**: `fix`（记账：`--ticket --fix-no --key --resume-run-id <coderRunId>`）— `--fix-no` counts attempts in sequence (the next number after the ticket's last fix), not quota consumption. Use **Repair decisions** after each return to choose a supported next action. Then resume the coder in a **new** workflow call (new stable key; the revived child keeps its agent, model, worktree, and context). Script-file delivery: write the script below to a new file `.pi/matt-implement/<slug>/wf/fix-<NN>-<fixNo>.js`, then call `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/fix-<NN>-<fixNo>.js", async: true })`:

```js
const r = await runs.run("fix-01-<fixNo>", { resume: "<coderRunId>", task: `<fix follow-up brief — see Briefs>`, acceptance: false });
return { ok: r.ok, structured: r.structuredOutput ?? null };
```

(`acceptance: false` — this round's verdict is the hand-run gate you run below. Without it the resumed child inherits the first round's acceptance obligations — level `verified` plus an attestation report — and a completed fix ends `rejected` with "Structured acceptance report not found" before any check runs.)

Two rules the platform forces:

- A gate is rejected on a retained resume — so **you** hand-run the round's gate yourself: in the coder's retained worktree, execute the **same full script command** as the first round (`--base` is always the ticket base):

```sh
cd <coderWorktree> && node <this-package>/scripts/mechanical-report.js --base <ticketBase> --test-command "<testCommand>"
```

Its stdout is that round's report and its exit code is that round's gate; the `settled` `--gate` summary for the round comes from the fresh report's `testResult`, same source as round one.
- Judge the fix by **git truth** (new HEAD SHA on the coder's branch), never by run status — a rejected run may still contain the finished work.

Then `git branch -f ticket-<NN> <newSha>` and retain the fresh validation evidence. Use **Repair decisions**: perform another supported repair if needed, or rebuild the bundle, record `settled` for this candidate, and dispatch the next complete formal-review round. Review ordinals count reviews, not fixes plus one. If the resume fails because the retained worktree is gone, fall back to a fresh coder — the ticket branch carries the accumulated commits — dispatched as `worktree: true, baseRef: "refs/heads/ticket-<NN>", acceptance: false`, with **no gate**: a gate would arm the platform's acceptance-report duty and settle the round by platform checks, while a fix round has exactly one verdict source — your hand-run gate. Record that fallback as a `fix` event too (new `--key`，`--resume-run-id` = the run it replaces).

### Merge and close

Serially, in the main checkout on the feature branch — merges never run in parallel with each other:

1. `git merge --no-ff -m "Merge ticket-<NN>: <title>" ticket-<NN>` — the message **must** contain the `ticket-<NN>` token (hard rule below; the ledger script cross-checks merges by it). On a conflict, follow the `resolving-merge-conflicts` skill.
2. Run the full suite. Red means an integration problem no ticket-level review could see: save the failing output to `findings/integration-<NN>.md` and dispatch **one** coder **without isolation** (omit `worktree`) on the feature branch, guarded by a pure-verdict gate (command plus timeout only — no `output`/`schema`, zero report because zero consumers). Script-file delivery: write the script below to a new file `.pi/matt-implement/<slug>/wf/integration-<NN>.js`, then call `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/integration-<NN>.js", async: true })`:

```js
await runs.run("fix-integration-<NN>", {
  agent: "pi-matt-implement-flow.coder",
  task: `<integration fixer brief — see Briefs>`,
  gate: { command: "<testCommand>", timeoutMs: 600000 }
});
```

After each return, use **Repair decisions** to choose a supported next fix or request the user; a red gate is evidence to inspect, not an attempt-count stop. Only one such fixer at a time, on the main feature worktree.
3. Only after full-suite integration validation passes, record `merge`（记账：`--ticket --head-sha --merge-sha`）— the script verifies the merge commit exists, sits on the feature branch, and carries the token. Keep the actual merge → passing validation → merge accounting → ticket completion order, including on cold resume. Premature merge accounting or ticket closure to make check green is forbidden. Then close the ticket on its truth-layer file: `Status: resolved` with the merge commit SHA in the closing comment — on the snapshot's copy that is an appended `merge SHA: <merge-sha>` line under `## Comments` (the pre-seal sync turns it into the closing comment, ordering note-then-close when the contract's `closeWithComment` is false); on the ticket file itself when the files are the truth layer, per the tracker doc.
4. Recommit or ignore any tracker dirt (see Preconditions), then remove the reviewer worktree if one exists (`reviewer=off` runs have none) and `git branch -D ticket-<NN>`; after the ticket is closed the coder's retained worktree goes too (its resume value is spent).

Recompute the frontier. While tickets remain: top the dispatch back up to N. Escalated tickets still need a user decision or further work; only a complete delivery goes to the normal Final gate.

### Final gate

This is the normal completed-delivery path: escalation is not ticket completion and cannot substitute for it. With merged work, a full final verdict is required; a latest `not_ready` rejects normal sealing. For an explicit decision to stop unfinished work, use **User abandonment** below from any stage.

1. Write the whole-branch bundle `git diff <feature-base>...HEAD` and dispatch `pi-matt-implement-flow.final-reviewer` with `worktree: true, baseRef: "refs/heads/feat/<slug>", acceptance: false` and a verdict schema of `ready | ready_with_fixes | not_ready` — its task carries the same `Axis script: <absolute path to this package>/scripts/axis-axes.js` pointer as the Reviewer brief.
2. **Record the verdict**（记账 `final`）: write the findings to `.pi/matt-implement/<feature-slug>/findings/final-r<k>.md` (`<k>` = final-review round), then record — `node <this-package>/scripts/ledger.js add final --runtime-dir .pi/matt-implement/<feature-slug> --final-verdict <ready|ready_with_fixes|not_ready> --run-id <runId> [--findings .pi/matt-implement/<feature-slug>/findings/final-r<k>.md]`. It is a run-level event (no `--ticket`); the final-reviewer's dispatch is not recorded separately — `--run-id` carries it, the same shape as a ticket reviewer's `--rev-run-id`. Every round of final review is one `final` event, and the **latest** verdict is the branch's readiness — never an earlier round's.
3. **With fixes**: dispatch one `pi-matt-implement-flow.coder` without isolation to fix every finding, guarded by the same pure-verdict gate (`gate: { command: "<testCommand>", timeoutMs: 600000 }` — no `output`/`schema`); commit on the feature branch. After each return, use **Repair decisions** to choose a supported next fix or request the user; a red gate is not an attempt-count stop. Check each finding against the actual diff and validation evidence after repairs. Local, explicit corrections may proceed after your verification; changes involving requirements, behavior, broader impact, or insufficient evidence require another final review. Write the per-finding checks, evidence pointers, and re-review choice with reasons in orchestration notes. Green tests, an old final verdict, or coder self-assessment alone do not prove the repaired candidate is acceptable. Every re-review gets its own `final` event; if the latest verdict is `not_ready`, obtain a new complete final verdict permitting normal closing before proceeding. **Not ready**: use the same repair decisions, retaining the review pointers and recording why repair can continue or which user input is needed. If the user explicitly calls the run off, switch to **User abandonment** below.
4. **Pre-seal sync** — after the last `final` verdict is in, and before the closing surface is ever marked ready: write the run's closing into the snapshot's `spec.md` (`closing: <交付指引>` under `## Comments` — the delivery note the closing comment will carry), then `node <this-package>/scripts/ledger.js sync --runtime-dir .pi/matt-implement/<slug>`: merged tickets close with their merge SHAs, escalated tickets get their comments and stay open, the spec closes with the delivery note. The sync is idempotent — after a partial failure, re-running plans only the still-missing actions. **A failed sync must not seal the run**: record `anomaly --note "sync failed: ..."` and stop to report — after `close` the event stream rejects every write, so a tracker failure can only be accounted for while the run is still open. The script itself refuses to sync a sealed run or one whose closing surface is already `ready`; the sync always precedes `pr --state ready`, so the closing keywords can never race-close a ticket the sync hasn't handled yet. Runs whose truth layer is the local files have no sync step: the local ticket files are the tracker already (zero change).
5. **Clean up after a green sync** — the cleanup disciplines are per-runtime-file category, per the glossary, not per tracker: the **tracker snapshot** (a third category of its own, not a transfer artifact) and the **transfer artifacts** spent by the sync — the review bundles — are removed once the sync lands (`rm -rf .pi/matt-implement/<slug>/tracker/` and `reviews/`). Keep `findings/` (the event stream references those paths) and the ledger三件套 (`events.jsonl` / `ledger.md` / `notes.md`) for good. The sync command prints this checklist — execute it as printed.
6. Push. Mark the closing surface ready — a PR ready for review, an MR ready — or report the branch name when there is no remote or the contract declares no closing surface; record `pr --state ready` when a closing surface exists.
7. Remove every remaining worktree and ticket branch.
8. **封账**: record `close --outcome completed` (the outcome may be omitted for normal completion) — the ledger flips to `state: complete`, and a sealed run can never be mistaken for an active one by the next session.

Report: tickets closed with their merge SHAs, the closing surface link or branch, and every escalated ticket with its review pointer.

### User abandonment — an independent exit

Use this exit only when the user explicitly decides to abandon the unfinished run, at any stage. A pause or acceptance of some completed work is not that decision.

1. **Stop** all related children and confirm they have stopped before any cleanup or sealing. If stopping fails or a child is still writing, keep the run open and resolve it first.
2. **Preserve** code and evidence: keep branches, commits, any uncommitted work, worktrees needed to retain it, findings, workflow artifacts, and the ledger files. Explain completed and unfinished items, their effects and risks, with branch names, SHAs, and validation/evidence pointers. Write the user's decision and this evidence in orchestration notes; existing commits and merges remain real — abandonment does not undo them.
3. **Handle the tracker by contract**: when it has a tracker write surface, run `node <this-package>/scripts/ledger.js sync --runtime-dir .pi/matt-implement/<slug> --mode abandon --claimant <the original claimant> --reason "<user's abandonment reason>"`. This leaves the abandonment explanation and releases the claim. If it fails, keep the run open, record `anomaly --note "abandon sync failed: ..."`, retain the snapshot, and handle the failure; retry only the missing actions using the same idempotent command. A contract with no tracker write surface has no claim or sync step: preserve its local truth files and perform the same safe exit, with no remote action. Explain any gap between merged local tickets and delayed tracker state, retaining evidence rather than claiming they were synchronized as completed.
4. **Seal only after success** of the required tracker actions (or when the contract requires none): `node <this-package>/scripts/ledger.js add close --runtime-dir .pi/matt-implement/<slug> --outcome abandoned --note "<user's decision and evidence pointer>"`. There is no need to fabricate `final` or per-ticket `escalate` events. Never close unfinished tickets or mark the feature/closing surface `ready`; skip the normal Final gate sync/ready/cleanup chain. Report the run as abandoned, not delivered; retain the saved code and evidence.

Both close outcomes require valid input, an initialized run, and an unsealed event stream. Sealed runs reject all new events, including another close or anomaly. Old `close` records without `outcome` remain readable: do not infer their intent or rewrite them to add an outcome.

## Briefs

Fill the angle brackets; send nothing else.

**Path rule for all briefs**: any path that does not physically exist inside the recipient's worktree (everything gitignored — `.scratch/`, `.pi/`, `data/`, …) is given as an absolute main-repo path and marked read-only. The rule covers all five brief templates below; there are no special cases for isolation shape. When the run reads a tracker snapshot, the ticket and spec paths in every brief are the snapshot's copies under `.pi/matt-implement/<slug>/tracker/` — same rule, same read-only marking.

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

You are in your own pi-managed worktree on your own branch based at that commit; every command and edit stays inside it. Run the project's install step (e.g. `npm ci`) before the first test if node_modules is not linked. Build this ticket: work test-first at the pre-agreed seams, full suite once at the end, then commit everything and report the headSha and branch by context pointer. Keep the tree fully committed: a dirty tree or an empty diff fails the gate.
```

### Reviewer brief

```
Ticket 07 (ticket file: <absolute main-repo path>). Spec: <absolute main-repo path>.
Review bundle: <absolute main-repo path>/.pi/matt-implement/<slug>/reviews/07-r1.diff (three-dot diff + commit list against base <sha>).
Implementer's report: the typed-gate report (`headSha` <sha>, `testResult` <one-line summary>) — mechanical gate evidence.
Axis script: <absolute path to this package>/scripts/axis-axes.js (read-only) — you spawn both axes through it.
Your worktree is checked out at refs/heads/ticket-07 — the post-change tree. Read the changed files there; review-bundle and findings paths are main-repo paths (read-only).

Run your two-axis process and return the structured verdict.
```

### Fix follow-up (to the same coder, via resume)

```
Review round <k> found issues: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/<NN>-r<k>.md.
Fix them in your worktree, rerun the full suite, commit everything, and report the new headSha by context pointer. The orchestrator hand-runs the gate for this round (see Fix loop).
```

### Integration fixer (no isolation)

```
The full suite is red after merging ticket <NN>: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/integration-<NN>.md.
You are on the feature branch in the main checkout, without isolation and as its sole writer for this repair; stay in this cwd and branch. This is an integration problem ticket-level reviews could not see. Fix it within the approved scope, run the full suite, commit on the feature branch, and report the new headSha and evidence pointers by context pointer. A pure-verdict gate re-runs the suite after you finish.
```

### Final fixer (no isolation)

```
The final review found issues: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/final-r<k>.md.
You are on the feature branch in the main checkout, without isolation and as its sole writer for this repair; stay in this cwd and branch. Fix every finding within the approved scope, run the full suite, commit on the feature branch, and report the new headSha and per-finding evidence pointers by context pointer. A pure-verdict gate re-runs the suite after you finish.
```

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

If context was compacted mid-run: re-read this file, then follow Cold resume (above) — regenerate and reconcile with `node <this-package>/scripts/ledger.js build --runtime-dir .pi/matt-implement/<slug>` followed by `check`, read their output (the printed ledger carries the full state — header, table, timeline, reconciliation — plus any ledger-truth drift item by item) and the orchestration notes (`.pi/matt-implement/<slug>/notes.md`). Continue from that output, not from memory. A fresh session restarting the same command takes the same path: unsealed event stream → skip init and the pull → rebuilt state → frontier.
