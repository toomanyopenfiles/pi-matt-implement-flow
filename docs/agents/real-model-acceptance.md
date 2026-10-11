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

- Every scenario declares its own **tier**, and the plan prints it: the dual-axis probe
  (`test/e2e/probes/repro-reviewer-axes.js`) is a **platform-contract probe** — one platform contract
  fact on a real dispatch, not a full `reviewer`/`final-reviewer` acceptance and not a flow E2E.
  Navigation acceptance, full-flow scenarios, and controlled walkthroughs are separate entries in the
  same catalog with their own definitions (see [Scenario tiers](#scenario-tiers)).
- The gate is **mis-trigger prevention, not a permission boundary**. It stops an unauthorized batch
  from starting. It does not stop a process with the same shell rights from calling a model directly.
  It also cannot make cost exact: call counts and timeouts bound calls, so they are not a precise
  money cap (provider billing is outside this harness).

## Scenario tiers

| Tier | What it establishes | What it does not establish |
| --- | --- | --- |
| `platform-contract-probe` | One platform contract fact on a real dispatch (the dual-axis probe). | A whole `reviewer` / `final-reviewer` run, or a flow. |
| `navigation-acceptance` | On a real session, the model finds the stage document from the trunk and loads it **before** the action, picks the right branch, and stays inside the safety boundaries. | Implementation quality; it does not judge the work that was produced. |
| `full-execution` | The scenario runs to its own end condition on the real platform against an isolated scratch project — six flows plus both reviewer roles. | Any other scenario; a pass covers only the approved batch. |
| `controlled-walkthrough` | Read-only: the model reads its evidence before recommending a next step and executes nothing. | Anything actually executed — the recommendation itself is read by a human. |

The catalog (`test/e2e/scenarios.js`, seen through the plan; scenario data in
`test/e2e/flow-scenarios.js`):

- `flow-new-run` — normal new run, per-ticket review on.
- `flow-reviewer-off` — per-ticket review off: no per-ticket reviewer dispatch, the final review still runs.
- `flow-changes-requested-fix` — repair after `changes_requested`: retained resume, the same gate command run by hand.
- `flow-cold-resume-unrecorded-merge` — cold continuation with a merge that is in git but not on the ledger.
- `flow-partial-continuation` — continuation after an accepted partial delivery: remaining scope only.
- `flow-abandon` — explicit abandonment: the writer child is stopped and verified first, then the abandonment exit.
- `reviewer-role-axes` / `final-reviewer-role-axes` — the two reviewer roles on a real candidate: shared protocol discovery, both axes finishing before the verdict, each role's own duties (the final review additionally records its cross-ticket / deferred-findings check). These are **full agent runs**, not the local probe wearing a different name.
- `nav-stage-discovery` — navigation acceptance; `walkthrough-paused-repair` — controlled walkthrough.

`--scenario <id>[,<id>…]` selects them; the default is the whole catalog, so a real batch is normally
approved with an explicit `--scenario` selection (plus a cap that matches the declared call units).

## Plan

The default invocation makes **no model calls** and needs **no credentials**:

```bash
node test/e2e/accept.js          # human-readable plan
node test/e2e/accept.js --json   # same plan, machine-readable (includes approvalHash)
```

The plan it prints is the thing you are being asked to approve, and it covers: the version under test
(package version + git HEAD + whether the worktree is dirty), the scenarios and their declared
boundary, the comparison scope it records (`--baseline <ref>` names a baseline for the report; this
entry does **not** run comparison batches — before/after or candidate comparison facilities are
separate work), model / provider / thinking, the platform
binary and its version (a local `--version` probe, never a model call), run counts, the call cap,
concurrency, per-attempt timeout, retry budget, a cost statement or an explicit "cannot be
estimated" statement, and the file / network / remote-write scope of every scenario.

Counts mean what they say: `--runs n` is the number of repetitions the batch will actually execute,
`--retries r` allows up to `1 + r` attempts *per repetition*, and the plan's planned-call count is
`callsPerRun × runs`. Retries are extra attempts for a repetition that could not be judged; they are
never used to re-run a decided failure.

Everything inside the plan is hashed into the **approval hash** shown at the bottom. The hash is the
authorization unit: any change to the scenario set, run counts, retries, call cap, model, thinking,
baseline, platform binary, or scenario module changes the hash, so an old approval can no longer be
reused for a different batch.

Per scenario the plan also records what will be judged and what the scenario runs in:
`fixture` (its identifier, tracker stub, test command and a manifest hash), `brief` (the task-brief
identifier and hash), and `judgement` (which documents must be loaded before which action, which
safety boundaries and role duties are checked, and whether the scenario is read-only). All of it is
inside the approval hash.

Call counts are declared per scenario in their own unit (`counts.callsUnitNote`): `model-call` for
probes, `session` for the flow scenarios — one platform session per run, whose internal subagent
calls are not charged one by one against the guardrail budget. Neither unit is a precise money cap;
the provider's bill is. An approved batch executes the declared number of sessions and records how
many sessions each scenario actually started.

Plan-only flags: `--scenario a,b`, `--runs n`, `--retries n`, `--call-cap n`, `--model id`,
`--thinking level`, `--baseline ref`, `--candidate ref`, `--out dir`.

## Candidate, baseline, and what the evidence binds to

`--candidate <git-ref>` names the stage under test: the source baseline, the verbatim-migration stage,
or the final candidate. The plan records the ref, its resolved commit, whether that commit's
instruction content equals your working copy, and two content identifiers (a sha256 over the
registered instruction documents — the working copy's and the named ref's). A mismatch is printed,
not hidden: a run whose working copy differs from the named candidate must not claim to have validated
that candidate, and evidence affected by such a change has to be re-evaluated. The registered stage
references live in `test/e2e/flow-scenarios.js` (`KNOWN_STAGES`); an unlabelled candidate cannot use
the baseline-defect classification below. `--baseline <ref>` stays what you compare *against*. Both are
inside the approval hash — changing either means re-approving.

Comparison is **behavioural**: scenario results, action-before-load facts, branch selection and safety
boundaries. It is not a comparison of wording, token counts, or identical tool sequences, and each
candidate is approved as its own batch.

One caveat the plan prints as an unfixed condition: this entry installs nothing. What the model
actually loads is the copy of the package registered with your platform, so install the candidate you
intend to test before you approve the batch; the named ref and the working copy are compared and
recorded, the installed copy is not.

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
- **Retries consume the approved budget**, are per repetition, and are only used for attempts that
  could not be judged (undetermined / infrastructure / harness). A definitive failure is never
  retried, and a repetition that already passed never masks a later definitive failure.
- **Every approved repetition runs** (unless the cap or a cancellation stops the batch). A definitive
  failure stops that scenario's remaining repetitions; they are recorded as not run with the reason,
  and the batch is not accepted.
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

## Scenario fixtures, sessions, and the task brief

Every flow scenario runs in its own scratch project created under the system temp directory: a real
git repository with a **fixed initial state** (fixed commit author/date and fixed content, so the same
scenario builds the same SHAs), a `local` tracker stub, a small `npm test` suite, ticket files, and —
where the scenario needs history — a real event stream written by `scripts/ledger.js` itself (the
cold-resume fixture really does produce a non-zero reconciliation difference for its unrecorded
merge). `gh` and `glab` are PATH stubs that log every attempt and fail: a real remote tracker write
cannot succeed here, and an attempt is reported as a safety-boundary violation.

The **task brief** is the only instruction the model gets on top of the project. It carries the inputs
a run normally has (spec, ticket files, flow configuration, test command) and deliberately does **not**
name any instruction document — the model has to find the stage document from the trunk on its own.
That property is machine-checked against the contract registry `CONTRACT_DOCUMENTS` in
`scripts/registration-checks.js`, so relocating instructions does not weaken it. The brief is hashed
into the plan.

Sessions are new and disposable; nothing here touches your real project or a real tracker. A scenario
that cannot be executed (platform refused the invocation, no session artefacts) produces `undetermined`
— reported as unresolved, never as a pass.

## How a scenario verdict is decided

A scenario is judged from its **trace**, never from the model's own summary. The trace is harvested
from the session transcript (file reads, `subagent` dispatches, ledger/git commands, test runs,
collected claims) and from the fixture (event stream, ticket copies, git history, remote-write
attempts). The judge then checks:

- each required document was loaded **before** the action that needs it (a missing load is fatal, a
  load that happens after the action is fatal too — both are definitive failures);
- branch selection: required dispatches happened, forbidden ones did not, and continuation does not
  re-dispatch or re-merge work that is already delivered;
- safety boundaries: no merge before a passing validation, no real remote tracker write, no seal with
  open scope, and no abandonment before the still-running child is stopped and verified;
- the closing claim matches the lifecycle: a claim of completion that the event stream or the ticket
  copies contradict is reported as a misjudged completion;
- role duties: a verdict never lands before both axes complete, read-only roles do not write, and the
  final review records its cross-ticket / deferred-findings check.

Two harvest rules are worth knowing, because they are what keeps the waiting claims honest:

- **A blocking dispatch return is the only axis-completion evidence.** The definitions require
  `async: false`, so the axes call returning means both axes finished. If the call carried
  `async: true` the return proves nothing — that is recorded (`async: true` on the dispatch) and the
  dual-axis-wait duty fails outright, which is the issue #6 signature. If no `async` value can be
  observed at all, the check stays `inconclusive` rather than being assumed satisfied.
- **A verdict is the role's own output; the waiting is a platform fact.** For the flow scenarios the
  verdict value comes from the ledger record; for the reviewer role exercises it comes from the
  reviewer's reply (`source: "reply-text"`). In both cases the axis timing that decides "grounded in
  both axes" comes from the session trace, never from the reply.

Evidence that could not be collected makes the corresponding check `inconclusive` (never a pass), and
the trace records which facts were uncertain — for example a dispatch script whose agent name could not
be resolved, an axis call with no visible `async` value, or the seal-time scope read at harvest time.
Still-running writer children are re-checked at harvest time from the PIDs the fixture recorded, so an
abandonment that never stopped its child is visible as a live PID, not as a claim.

**Baseline defects are marked honestly.** When the batch carries a registered stage and the failure
matches a declared known baseline defect (for example the pre-migration dual-axis definition from
issue #6, whose early return let a verdict land before the axes finished), the verdict stays a failure
but is classified `baseline-defect`: reported as failed, not counted as a regression of the candidate.
An unlabelled candidate can never use that classification, and a failure that is not declared is a
`product-regression`.

## What the deterministic self-checks do and do not prove

`npm test` includes `test/e2e-flow-scenarios.test.js`, which builds the same fixtures, replays
**synthetic traces** through the same judge, and asserts that missed reads, late reads, wrong branches,
safety-boundary violations, role-duty violations, and a completion claim the lifecycle contradicts are
all caught — and that missing evidence is reported as missing rather than as a pass. The self-check
channel also runs without the entry:
`node test/e2e/probes/flow-scenarios.js --only <id> --replay <trace.json>` judges a trace file with zero
model calls. None of this is model acceptance: it proves the instrument, not the model. Only an
authorized batch on the real platform produces model-behaviour evidence, and a scenario that could not
be executed or judged stays unproven.

## Results

Every run writes into the evidence directory (`--out <dir>`, default
`.scratch/e2e-runs/<runId>/`, which git ignores):

- `results.json` — batch status, the approved plan, budget accounting (`usedCalls` vs `callCap`),
  the direct-child process record plus a best-effort scan for processes still matching the known
  probe/platform paths, and one entry per scenario with its repetition accounting
  (`runs: { planned, attempted, passed }`) and **every** attempt: repetition and attempt index, status,
  failure kind (`product-regression` / `infrastructure` / `harness` / `undetermined`), reported call
  count, exit code, end method, duration, and the log paths.
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
  not behave as the scenario requires (e.g. it never made the instructed call), or no session
  artefacts were produced at all; `infrastructure` means the platform or provider failed, timed out, or
  the process died; `harness` means this repository's own test gear failed (missing result file,
  contradictory exit code, fixture that could not be built). Only `product-regression` on a definitive
  `fail` says the code under test is wrong; `baseline-defect` on a `fail` says the failure is a
  declared, pre-existing baseline problem, not a regression of this candidate.
- **A flow scenario fails on a missing or late document load** — the attempt result names the
  contract (`missing-read:<contract>@<action>` / `late-read:…`). That is the navigation property the
  scenario exists for: the model acted before loading the instructions for the stage. Do not re-run the
  same batch to look for a green sample; a repetition is evidence too.
- **A flow scenario's trace says facts were uncertain** — `trace.uncertainty` lists what the harvest
  could not see. Those checks stay `inconclusive`; judge the case by hand (the session directory and the
  fixture notes are kept in the attempt result) instead of promoting it to a pass.
- **`budget-exhausted` / `not-run`** — the approved cap was reached, so the remaining repetitions or
  scenarios never ran. This is not a pass. Approve a larger cap (a new hash) if you want them
  executed.
- **A repetition stopped early after a definitive failure** — `runs.attempted < runs.planned` with a
  `definitive-failure` reason. The scenario stays `fail`: already-passed repetitions do not mask it,
  and the remaining repetitions were not re-run to look for a green one.
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

A scenario entry declares its probe, arguments, declared calls per run **and their unit**, timeout,
tier, boundary claim, write scope, and — for flow scenarios — its fixture, its task brief, and the
judgement contract that will be applied to the trace. Tiers are data, not prose: a scenario cannot
claim more than its tier.

The runner seams (`PI_E2E_SCENARIOS` for an alternative scenario module, `PI_E2E_PI_BIN` for an
alternative platform binary, `PI_E2E_CANDIDATE` / `PI_E2E_CANDIDATE_SHA` / `PI_E2E_STAGE` for the
candidate label passed down to the probes) exist so the guardrail itself can be tested at the call
boundary without paying for model calls. The candidate label is covered by the approval hash; the
others replace the runner, not the gate: an unauthorized batch is still refused before anything starts.
No production script or instruction document reads any of them — the acceptance harness stays inside
`test/e2e/`.
