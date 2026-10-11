# The ticket loop — dispatch, verify, fix, merge

pi-matt-implement-flow stage operation doc — `SKILL.md` (the always-loaded trunk) discloses this stage and is read first. **Continue:** per ticket — claim, dispatch, settle, review, repair, merge — and leave the stage once every merged ticket is closed and the frontier is recomputed.

### Each round — dispatch the frontier

Count running coders; while below N and the frontier is non-empty, claim the next tickets（认领）— write `Status: claimed` on the ticket's truth-layer file — the tracker snapshot's copy when the run reads one, the ticket file itself when the files are the truth layer; never a tracker-body write — tracker-side progress happens only at the pre-seal sync — and dispatch one wave. Dispatch delivery is always script-file form: **write the script below to a new file** `.pi/matt-implement/<slug>/wf/wave-<NN>.js` (one new file per call — the audit report recovers briefs from these files). The brief text for every dispatch below comes from the dispatch reference (`run/dispatch-reference.md`) — read it before writing any `task:` string. Then make one top-level `subagent` call naming that file: `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/wave-<NN>.js", async: true })`:

```js
const RUN_TIMEOUT_MS = 14400000; // ← substitute the number just printed by `node <this-package>/scripts/flow-config-cli.js run-timeout` (see **Run deadline** in `run/new-run.md`)

const results = await runs.all([
  {
    key: "t-01",
    agent: "pi-matt-implement-flow.coder",
    timeoutMs: RUN_TIMEOUT_MS,
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

- **Why a typed `gate` instead of an `acceptance` object** (they are mutually exclusive — a child has exactly one structured-output source): the report is assembled host-side from git truth plus a real test run, so you never parse model prose to decide a run. The gate's stdout becomes the structured output and its exit code is the verdict.
- **stdout contract**: the gate command must print a single JSON document of at most 12,000 characters; empty, truncated, non-JSON, or schema-mismatched output fails the gate fail-closed.
- **Gate timeout**: the dispatch pins `timeoutMs: 600000` (10 min) on the gate object — the gate budget, independent of the run deadline.
- **Mutual exclusion (iron rule)**: `gate`, a non-`false` `acceptance` object, and `outputSchema` are three-way exclusive — the coder dispatch carries the gate and neither of the other two. `acceptance: false` counts as omitted (what the read-only reviewer dispatch and the fix-loop resumes below use), but beside a `gate` it is no shield: the gate still normalizes into a `verified` acceptance carrying its report duty.
- **The fix loop** runs the same gate by hand (below): a gate is rejected on a retained resume, so you execute the identical script command in the retained worktree — the same standard every round, no second track.

### Verify each finished ticket

When a coder reports, first make its work mergeable, then review. The **formal-review round** `<k>` is independent of fix attempts: use the next unused review ordinal; the same ticket and same round cannot receive a duplicate formal verdict. Multiple repairs may follow one review before the next full review. To re-review without a new `fix`, obtain a fresh hand-run gate, bundle, and `settled` for the candidate, then dispatch the complete reviewer process below under the next round.

1. **Anchor the ticket branch** (git truth, not the report): `git branch ticket-<NN> <headSha>` (the `<headSha>` is the gate report's — mechanical truth, not model prose). If `headSha` is missing or unreachable, go into the coder's retained worktree, run `git status --porcelain` there, commit anything left (`ticket <NN>: orchestrator checkpoint`), and use that SHA.
2. **Write the review bundle**: `git diff <baseCommit>...refs/heads/ticket-<NN>` (three-dot) plus `git log --oneline` into `.pi/matt-implement/<slug>/reviews/<NN>-r<k>.diff`.
3. **Record `settled`**（记账：`--ticket --round --head-sha --worktree --gate` 一句门禁摘要）— the ticket's headSha and worktree are now anchored in the event stream; the `--gate` summary is the fresh gate report's `testResult` line.
4. **Dispatch the reviewer** for that ticket — only when the run's init snapshot has `reviewer=on` (the default). With `reviewer=off`, skip this step and the fix loop entirely and go straight to the merge: the platform gate and the post-merge integration suite are the remaining per-ticket defenses, and the whole-branch final-reviewer still runs at the end. Script-file delivery: write the script below to a new file `.pi/matt-implement/<slug>/wf/review-<NN>-r<k>.js`, then call `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/review-<NN>-r<k>.js", async: true })`:

```js
const RUN_TIMEOUT_MS = 14400000; // ← substitute the number just printed by `node <this-package>/scripts/flow-config-cli.js run-timeout` (see **Run deadline** in `run/new-run.md`)

const results = await runs.all([
  {
    key: "rev-01",
    agent: "pi-matt-implement-flow.reviewer",
    timeoutMs: RUN_TIMEOUT_MS,
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

(`acceptance: false` — this round's verdict is the hand-run gate you run below. Without it the resumed child inherits the first round's acceptance contract, and the platform rejects the finished fix for a report the model never writes before any check runs.)

Two rules the platform forces:

- A gate is rejected on a retained resume — so **you** hand-run the round's gate yourself: in the coder's retained worktree, execute the **same full script command** as the first round (`--base` is always the ticket base):

```sh
cd <coderWorktree> && node <this-package>/scripts/mechanical-report.js --base <ticketBase> --test-command "<testCommand>"
```

Its stdout is that round's report and its exit code is that round's gate; the `settled` `--gate` summary for the round comes from the fresh report's `testResult`, same source as round one.
- Judge the fix by **git truth** (new HEAD SHA on the coder's branch), never by run status — a rejected run may still contain the finished work.

Then `git branch -f ticket-<NN> <newSha>` and retain the fresh validation evidence. Use **Repair decisions**: perform another supported repair if needed, or rebuild the bundle, record `settled` for this candidate, and dispatch the next complete formal-review round. If the resume fails because the retained worktree is gone, fall back to a fresh coder — the ticket branch carries the accumulated commits — dispatched as `worktree: true, baseRef: "refs/heads/ticket-<NN>", acceptance: false, timeoutMs: RUN_TIMEOUT_MS` (a fresh dispatch is a new deadline, resolved per the **Run deadline** rule), with **no gate**: a gate would arm the platform's acceptance-report duty and settle the round by platform checks, while a fix round has exactly one verdict source — your hand-run gate. Record that fallback as a `fix` event too (new `--key`，`--resume-run-id` = the run it replaces).

### Merge and close

Serially, in the main checkout on the feature branch — merges never run in parallel with each other:

1. `git merge --no-ff -m "Merge ticket-<NN>: <title>" ticket-<NN>` — the message **must** contain the merge token (`ticket-<NN>` is a hard rule; the ledger script cross-checks merges by it). On a conflict, follow the `resolving-merge-conflicts` skill.
2. Run the full suite. Red means an integration problem no ticket-level review could see: save the failing output to `findings/integration-<NN>.md` and dispatch **one** coder **without isolation** (omit `worktree`) on the feature branch, guarded by a pure-verdict gate (command plus timeout only — no `output`/`schema`, zero report because zero consumers). Script-file delivery: write the script below to a new file `.pi/matt-implement/<slug>/wf/integration-<NN>.js`, then call `subagent({ workflow: "./.pi/matt-implement/<slug>/wf/integration-<NN>.js", async: true })`:

```js
const RUN_TIMEOUT_MS = 14400000; // ← substitute the number just printed by `node <this-package>/scripts/flow-config-cli.js run-timeout` (see **Run deadline** in `run/new-run.md`)

await runs.run("fix-integration-<NN>", {
  agent: "pi-matt-implement-flow.coder",
  timeoutMs: RUN_TIMEOUT_MS,
  task: `<integration fixer brief — see Briefs>`,
  gate: { command: "<testCommand>", timeoutMs: 600000 }
});
```

After each return, use **Repair decisions** to choose a supported next fix or request the user; a red gate is evidence to inspect, not an attempt-count stop. Only one such fixer at a time, on the main feature worktree.
3. Only after full-suite integration validation passes, record `merge`（记账：`--ticket --head-sha --merge-sha`）— the script verifies the merge commit exists, sits on the feature branch, and carries the token. Keep the actual merge → passing validation → merge accounting → ticket completion order, including on cold resume. Premature merge accounting or ticket closure to make check green is forbidden. Then close the ticket on its truth-layer file: `Status: resolved` with the merge commit SHA in the closing comment — on the snapshot's copy that is an appended `merge SHA: <merge-sha>` line under `## Comments` (the pre-seal sync turns it into the closing comment, ordering note-then-close when the contract's `closeWithComment` is false); on the ticket file itself when the files are the truth layer, per the tracker doc.
4. Recommit or ignore any tracker dirt (see `run/new-run.md` → Preconditions), then remove the reviewer worktree if one exists (`reviewer=off` runs have none) and `git branch -D ticket-<NN>`; after the ticket is closed the coder's retained worktree goes too (its resume value is spent).

Recompute the frontier. While eligible tickets remain: top the dispatch back up to N. An empty frontier with unfinished tickets is a pause, not permission to enter the normal Final gate or clean up. Explain the blockers to the user; if they want the completed portion, follow **Partial delivery** in `run/closing.md`. Escalated tickets still need a user decision or further work; only a complete delivery goes to the normal Final gate.

