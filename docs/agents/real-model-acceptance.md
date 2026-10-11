# Real-model acceptance entry

Use this run reference when you need to prove something about how the **real** platform behaves:
a real `pi` process, real subagents, a real model, real cost. It is a maintainer tool that lives in
`test/e2e/` — it is not part of `npm test`, not part of CI, and not shipped in the npm package.

Everything else in `npm test` is deterministic and free. If you only want to know whether the code is
still correct, you do not need this document.

Terms (`platform-contract probe`, `evidence`, `dispatch`) follow [CONTEXT.md](../../CONTEXT.md).
Companion procedures: [prompt-driven scenario acceptance](./prompt-driven-scenario-acceptance.md)
for repair/pause/continuation walkthroughs, and
[regression coverage](./regression-coverage.md) for what the deterministic layers do and do not prove.

## What this entry is, and what it is not

The single supported entry is `test/e2e/accept.js`. It runs a **batch** of scenarios, each of which
is a real model call (or several). Two facts to hold on to:

- The existing dual-axis probe (`test/e2e/probes/repro-reviewer-axes.js`) is a **platform-contract
  probe**: it checks one platform contract fact on a real dispatch. It is **not** a full
  `reviewer`/`final-reviewer` acceptance and **not** a full-flow E2E. Navigation acceptance (does the
  model find the disclosure docs from the skill trunk on its own?) and full-flow scenarios are
  separate batches with their own scenario definitions.
- The gate is **mis-trigger prevention, not a permission boundary**. It stops an unauthorized batch
  from starting. It does not stop a process with the same shell rights from calling a model directly.
  It also cannot make cost exact: call counts and timeouts bound calls, so they are not a precise
  money cap (provider billing is outside this harness).

## Plan

The default invocation makes **no model calls** and needs **no credentials**:

```bash
node test/e2e/accept.js          # human-readable plan
node test/e2e/accept.js --json   # same plan, machine-readable (includes approvalHash)
```

The plan it prints is the thing you are being asked to approve, and it covers: the version under test
(package version + git HEAD + whether the worktree is dirty), the scenarios and their declared
boundary, the comparison scope (`--baseline` or none), model / provider / thinking, the platform
binary and its version (a local `--version` probe, never a model call), run counts, the call cap,
concurrency, per-attempt timeout, retry budget, a cost statement or an explicit "cannot be
estimated" statement, and the file / network / remote-write scope of every scenario.

Everything inside the plan is hashed into the **approval hash** shown at the bottom. The hash is the
authorization unit: any change to the scenario set, run counts, retries, call cap, model, thinking,
baseline, platform binary, or scenario module changes the hash, so an old approval can no longer be
reused for a different batch.

Plan-only flags: `--scenario a,b`, `--runs n`, `--retries n`, `--call-cap n`, `--model id`,
`--thinking level`, `--baseline ref`, `--out dir`.

## Authorize

Copy the approval hash from the plan and pass it back in:

```bash
node test/e2e/accept.js --approve <approvalHash>
echo "<approvalHash>" | node test/e2e/accept.js --approve -    # hash from stdin
node test/e2e/accept.js --run                                  # interactive terminal: prompts for the hash
```

Rules the entry enforces:

- **No explicit approval for this exact batch, no execution.** `--run` without a matching
  `--approve` is refused before any process that could call a model is started. A non-interactive
  invocation that supplies no approval is refused as well — silence is never consent.
- **Only the approval hash counts.** "yes", "approved", a ticket reference, an implementation
  approval, or a `--yes`-style flag are not model-call authorization; unknown consent-style flags are
  usage errors.
- **A different batch's hash is refused.** Change the scope and you must approve again: new scenarios,
  more runs or retries, a different model / provider / thinking, a higher call cap, or a new
  real-remote-write requirement.
- **Retries consume the approved budget** and are only used for attempts that could not be judged
  (undetermined / infrastructure). A definitive product failure is never retried into a green run.
- **The call cap is enforced across the whole batch**, including retries. If a probe reports more
  calls than the plan declared, the batch stops and is recorded as not accepted; raising the cap
  means re-approving.

Refusals exit with code `1` and write `refusal.json` next to the (not-created) run artifacts,
recording the reason, the plan, and the fact that no model call happened.

## Execute

After a matching approval the entry runs the approved scenarios serially and stops at the first
condition that invalidates the approval:

```bash
node test/e2e/accept.js --approve <approvalHash> --json
```

Per scenario, the entry starts `node <probe> <scenario args> --model <model> --thinking <level>` with
`PI_E2E_RESULT_PATH`, `PI_E2E_ATTEMPT`, `PI_E2E_SCENARIO` and `PI_E2E_PI_BIN` in the environment.
The probe writes one machine-readable result (`{ schema, scenario, status, kind, calls, assertions,
notes }`) and exits `0` pass / `1` definitive failure / `2` undetermined. A report that contradicts
its own exit code, a missing result file, and a crashed probe all count as undetermined — never as
pass.

Exit codes: `0` accepted (every scenario passed inside the approved cap), `1` refused,
`2` usage/config error, `3` not accepted (failed / undetermined / not run / cap exceeded),
`4` cancelled. Undetermined is never promoted to pass.

**Cancel** with Ctrl-C (or `SIGTERM`). The entry stops starting new attempts, terminates the child
running at that moment, records how each direct child ended, and writes what is known about the
remaining scenarios as not run. It also records that direct-child termination is *not* proof that all
background work stopped — a probe may have left platform sub-sessions or independent processes
behind, so check the platform session state yourself after a cancel.

## Results

Every run writes into the evidence directory (`--out <dir>`, default
`.scratch/e2e-runs/<runId>/`, which git ignores):

- `results.json` — batch status, the approved plan, budget accounting (`usedCalls` vs `callCap`),
  the direct-child process record plus a best-effort scan for processes still matching the known
  probe/platform paths, and one entry per scenario with **every** attempt: status, failure
  kind (`product-regression` / `infrastructure` / `harness` / `undetermined`), reported call count,
  exit code, end method, duration, and the log paths.
- `logs/<scenario>-attempt-N.log` — sanitized stdout/stderr of that attempt.
- `attempts/<scenario>-attempt-N.result.json` — the probe's raw result for that attempt.
- `refusal.json` — present instead when an execution request was refused.

Evidence is **sanitized**: values of environment variables that look like credentials
(`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIAL`, `*_AUTH*`) are replaced with
`<redacted:NAME>` in every artifact and in the console output; the full user configuration is never
copied. Records bind to the tested commit, the scenario set, the model/platform versions, and the
approved scope, so a green result cannot silently apply to a different candidate. All attempts are
kept — a later success does not erase the failed attempts that preceded it.

Read the result honestly: `passed` covers the approved scenarios of that batch only. It is not a
statement about model reliability in general, and undetermined scenarios stay undetermined.

## Troubleshooting

- **"refused … 缺少本批计划的明确授权"** — you asked to run without approving this batch. Re-run the
  plan, copy the hash, and pass `--approve <hash>`. Confirm the scope in the plan is what you want.
- **"授权不匹配"** — the hash belongs to a different plan. Something in the scope changed (scenario
  set, counts, model, cap, baseline, platform binary, scenario module). Look at the plan again and
  approve the new hash if the new scope is intended.
- **A scenario stays `incomplete`** — look at the attempt's `kind`: `undetermined` means the model did
  not behave as the scenario requires (e.g. it never made the instructed call); `infrastructure`
  means the platform or provider failed, timed out, or the process died; `harness` means this
  repository's own test gear failed (missing result file, contradictory exit code). Only
  `product-regression` on a definitive `fail` says the code under test is wrong.
- **`budget-exhausted` / `not-run`** — the approved cap was reached, so the remaining scenarios never
  ran. This is not a pass. Approve a larger cap (a new hash) if you want them executed.
- **`budget-overrun`** — a probe reported more calls than the plan declared. Nothing further ran;
  re-plan with honest call counts before approving again.
- **The run was cancelled** — check the platform session state for the probe's sub-sessions, keep the
  evidence, and re-approve a fresh batch when you are ready. Cancelled work is never reported as
  passed. `results.json` lists how each direct child ended and adds a best-effort scan for leftover
  processes matching the known probe/platform paths; an empty scan does **not** mean all background
  work stopped (platform sub-sessions may not carry those paths).
- **The provider is down** — retries inside the approved budget may absorb a blip; otherwise the
  batch ends as not accepted with `infrastructure` classification. That is an unknown, not a code
  verdict.

## Evidence retention and cleanup

- Evidence lives outside the source tree (git-ignored `.scratch/e2e-runs/`, or whatever `--out`
  points at). It is not committed and not published: the npm package excludes everything under
  `test/`.
- Retention: `passed` runs may be cleaned once they are older than the retention window (default
  14 days). Runs that failed, were undetermined, were cancelled, or were refused are kept by default —
  the only evidence of a failure is not deleted immediately.
- Cleanup is explicit and never part of a run:

```bash
node test/e2e/accept.js --clean                       # default 14 days, failures kept
node test/e2e/accept.js --clean --keep-days 30 --out .scratch/e2e-runs
node test/e2e/accept.js --clean --force               # also delete failure evidence
```

Cleaning makes no model calls and touches nothing but the evidence directories.

## Adding a scenario (harness development seam)

Scenario definitions are data in `test/e2e/scenarios.js`; each entry declares its probe, arguments,
declared model calls per run, timeout, verification level, boundary claim, and write scope. New
scenarios inherit the same plan → authorize → execute gate and show up in the plan (and therefore in
the hash).

Two environment variables exist so the guardrail itself can be tested at the call boundary without
paying for model calls: `PI_E2E_SCENARIOS` points at an alternative scenario module, and
`PI_E2E_PI_BIN` at an alternative platform binary. Both are printed in the plan and covered by the
approval hash. They replace the runner, not the gate: an unauthorized batch is still refused before
anything starts.
