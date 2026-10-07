# Prompt-driven scenario acceptance

Use this guide when validating repair/pause choices, cold continuation, final-review repair,
partial delivery, or abandonment. Read [ADR-0009](../adr/0009-prompt-driven-repair-and-run-continuation.md)
and the corresponding steps in [SKILL.md](../../SKILL.md) before choosing a scenario; domain terms
and evidence lifetimes are defined in [CONTEXT.md](../../CONTEXT.md).

This is a contributor acceptance procedure, not a runtime decision engine or required model CI.
Separate what the model recommended from what actually ran. A deterministic test or a green
suite does not prove that the model made the right decision in a native session.

## Evidence tiers and recorded coverage

The following summarizes retained spec #12 acceptance reports and selected source artifacts, not
a native replay performed by this documentation change. Their names identify run-local hand-off
artifacts, not permanent repository links or downloadable evidence. Archive the reports, native
session artifacts, and corresponding run evidence together, with a manifest mapping these names
and short identifiers to their retained locations.

| Tier | Recorded evidence | What it establishes | Boundary |
| --- | --- | --- | --- |
| Native cold-continuation | `scenario14-result.md`; package source at `d0fe12a` | A parent rebuilt an interrupted run, explained an unrecorded merge, selected only direct recovery, and dispatched a native integration coder; the coder repaired and the parent independently validated before recording the merge | Controlled repository, synthetic initial dispatch/settlement/approval; not a live customer run or proof of valid real review |
| Native cancellation | `scenario16-result.md` | A native child was stopped and terminal status checked before a real local abandonment seal; unfinished work stayed open and later writes were refused | Synthetic abandonment decision; local tracker only, not live remote claim handling or a guarantee for every provider |
| Controlled walkthrough A–F | `scenario-walkthrough-results.md` | A model selected actions and proposed notes from bounded inputs; D also read existing native-scene evidence | No dispatch, testing, sync, cancellation, edits, or sealing was executed by the walkthrough |
| CLI black-box | Repository tests linked below | Observable command results, append-only records, projections, refusals, and tracker-stub state changes | Synthetic fixtures and external command stubs; neither autonomous choices nor live tracker accounts |
| Native partial-delivery continuation: FAILURE | `scenario17-result.md`; fixture HEAD `6527c17` | Partial-stage retention and native C-only work ran, but the parent sealed before verifying all remote closures; C remained open | Required snapshot merge metadata was omitted; the sealed failed run is retained, not reopened |
| Native partial-delivery continuation: bounded success | `scenario17b-result.md`; independent fixture HEAD `41969fec` | Native C-only continuation, actual formal/whole-branch review, ordinary full sync, independent all-four-closed check before ready/seal, and normal close executed | A distinct run, not recovery of sealed scenario 17; synthetic A/B historical identities, user acceptance, permission and tracker |

## Reproduction and evidence capture

1. Use a disposable git repository with a real test command, setup files for a supported tracker,
   and explicit scenario tickets. Record the package commit, fixture branch/base/HEAD, test
   command, scenario input, and which identities, decisions, or approvals are synthetic. For a
   remote-contract fixture, use the existing stateful PATH stubs from the CLI tests; keep real
   tracker credentials out of the exercise. **Done:** the input and its synthetic boundaries can
   be reconstructed without trusting a success summary.
2. Read the relevant skill steps in a fresh parent context. Capture the chosen action, evidence
   consulted, and any requested user input in orchestration notes. Use the existing native
   dispatch/gate interfaces for execution, or label the exercise read-only if only asking for
   recommendations. **Done:** a reviewer can distinguish a decision from a command actually run.
3. Save command stdout/stderr and exit codes, git history/diffs, event history, ticket state,
   findings, and native child identities/status evidence. Use paths relative to the fixture or
   run directory in the acceptance report. Keep run-local files with the evidence archive rather
   than linking temporary traces as permanent docs. **Done:** every claimed transition has a
   retrievable source; gaps are named, not filled by inference.
4. Check the scenario-specific observations below and run the relevant deterministic tests.
   Report executed actions, results, missing evidence, and remaining scenarios separately.
   **Done:** neither a walkthrough nor CLI-only evidence is promoted to a native execution claim.

### Native cold-continuation (scenario 14)

Prepare a real ticket merge whose integration test fails before merge accounting. Leave another
unrelated ticket open. Interrupt before recording the merge, retaining the failing log and notes.
On cold continuation, follow the skill's recovery steps in a new context, rebuild the ledger and
run reconciliation in new CLI processes. Confirm that the unrecorded merge still produces a
nonzero check and that ordinary dispatch, unrelated merges, and finishing remain paused.

Explain the difference, dispatch only a directly scoped integration fixer on the feature worktree,
and preserve its reproduction, code diff, commit, and full gate result. Independently validate the
current branch. Reconciliation must still show the unrecorded merge even after tests turn green;
only then record the actual merge and finish that ticket. Check again and verify the unrelated
ticket has no new implementation or events. This sequence tests recovery without concealing drift.

**Recorded result:** the native coder reproduced 2/3 passing tests, identified boundary whitespace,
changed one source line without changing tests/API, and committed `2a2a749`; the parent independently
observed 3/3 passing tests. Check remained nonzero before accounting, then passed after recording
merge `0fd5ee9` with original ticket head `33e2d6e` and resolving ticket 01. Ticket 02 stayed open;
no fix, final, or close event was fabricated. These are fixture commit identifiers, not package
commits. Initial approval was synthetic; later merge-schema acceptance does not validate a real
formal approval.

**Verification entry:** in that scene's run directory, inspect `events.jsonl`, `ledger.md`,
`notes.md`, findings, and `evidence/parent-cold-build.log`, `parent-cold-check.log`,
`parent-postfix-test.log`, `parent-green-before-account.log`, `parent-record-merge.log`, and
`parent-final-check.log` (the latter filenames also under `evidence/`). Check git history and the
source/test diff against the captured branch and heads. These logs belong to the retained scene,
not this repository; if they are unavailable, rerun rather than claiming they were verified.

### Native cancellation (scenario 16)

Use an initialized, open local-tracker fixture with saved merged work, an unfinished ticket, and
no final approval. Have a native child active at the abandonment decision. Stop the exact child
and query native status until its termination is confirmed; a prose claim that it stopped is not
sufficient. If termination is not established, keep the run open. Preserve code, branches, any
uncommitted work, findings, and the unfinished-work explanation before sealing. Follow the tracker
contract: local has no remote write surface. Seal through the existing explicit abandonment entry,
then attempt a later write and confirm refusal without changing the historical records.

**Recorded result:** child `3cebcc68` was natively stopped and observed terminal before local
`close --outcome abandoned` succeeded at sequence 6. Ticket 02 remained open, commit `2a2a749`
was retained, no final/escalation/ready was invented, and a subsequent anomaly write failed with
history still six lines. The user's decision was synthetic and this was not abandonment of the
real spec #12 run.

**Verification entry:** inspect the native stop/status and session artifacts, retained notes,
branch/commit/ticket facts, `events.jsonl`, and `evidence/parent-abandon-close.log` plus
`evidence/parent-abandon-sealed-refusal.log`. Remote abandonment failure/retry is separately
covered by GitHub/GitLab CLI stubs, not by this native local scene.

### Controlled walkthrough A–F

Supply bounded inputs to a read-only model and retain the prompt, source revision, response,
evidence references, and proposed notes. Ask for the next action and missing evidence; mark every
recommendation as unexecuted. The recorded walkthrough made these choices:

| Case | Input | Recorded recommendation and check |
| --- | --- | --- |
| A | Four red integration outputs with successive hypotheses ruled out and a new import-order diagnosis; all traces synthetic | Continue with one directly scoped fixer; verify reproduction, diff and full gate without weakening assertions. Count diagnosis evidence, not commits or agent swaps |
| B | Synthetic 403 for C; A/B complete; first “continue”, then an unverified claim of permission | Pause, request usable authorization, and require a successful probe before continuing C; do not complete C or unlock dependents |
| C | Synthetic `ready_with_fixes`; only a README command typo with same-candidate evidence | Check each finding and command evidence; a local correction can proceed without a full repeat review, with reasons recorded |
| D | Existing scenario-14 trim repair and 3/3 log; previous full final only hypothetical | Obtain a full final review for the behavior change; old approval and green tests alone do not mark current code ready. An unproven Unicode concern is not a confirmed defect |
| E | Synthetic successful comment, failed unclaim, then evidence of only the missing action succeeding | Check required actions, retain anomaly history, record handling in notes, and continue only with the required user decision and verified result |
| F | Synthetic explicit abandonment while a child still writes | Stop and confirm termination first; preserve work/evidence, follow declared tracker capabilities, keep open on failure, and seal only after success |

**Recorded boundary:** A/B/C/E/F did not execute any action chain. D inspected existing controlled
scene material but did not replay native fixing, independently verify git history, or stop a
child. This checks prompt consistency on six examples, not universal model correctness. B is
not a completed partial-delivery scene; F does not substitute for actual cancellation.

### Partial delivery and same-run continuation (#17)

Two independent bounded native scenes have executed this sequence: original scenario 17 failed
operational acceptance, and scenario 17b passed the bounded continuation/closing checks below.
For reproduction, use a fresh fixture, never a sealed scenario-16 or scenario-17 run.

1. Complete A and B with real commits and passing validation; leave C blocked on a verifiable
   external permission. Record the missing condition without treating escalation as completion.
   Check the completed part on the **current** feature branch and present branch/commit/validation
   evidence, unfinished scope and its effects, risks, and next steps. **Done:** the proposed
   partial result has evidence of usability, not just evidence of past merges.
2. Obtain explicit user acceptance of that partial result. Save the decision and continuation
   conditions in notes. Inspect the open ledger, retained tracker snapshot (for a remote tracker),
   findings, and other recovery evidence. Check remote-stub state/call logs and closing-surface
   state: no final sync, spec close, ready-to-close chain, or final snapshot cleanup. No new
   pause/resume/partial-delivery event is expected. **Done:** the evidence shows an open run and
   preserved artifacts, not abandonment or full delivery; idle `running` is explained correctly.
3. Interrupt, supply the actual missing permission, and resume in a fresh context using the same
   command. Follow the existing continuation steps: reread the flow, build/check, read notes and
   evidence, and verify permission. Retain the original event prefix and snapshot; do not init or
   pull delayed remote state again. If check finds a known unvalidated merge, handle only that
   difference with valid recovery evidence first. **Done:** C alone continues; A/B are not
   reimplemented, redispatched, or merged again, and historical escalation is not a permanent stop.
4. Complete C with required current-candidate validation and review. Verify that the snapshot
   includes the exact git/event merge SHA in the existing closing-comment format, then perform
   final review and ordinary idempotent final sync where declared. Independently check that all
   three tickets and the spec are closed while the PR is still draft and the run unsealed, before
   readiness, cleanup and normal sealing. Test sealed-write refusal. **Done:** tracker-stub state,
   git, notes and ledger agree on full completion, not just a zero sync exit or a completed close
   payload. Follow the skill's existing metadata and finishing steps; this adds no new mode.

Capture pre-acceptance, post-acceptance, cold-resume, and completed evidence separately. Inspect
snapshot retention and the absence of closing calls at the partial stage; the sync CLI does not
recognize user acceptance or implement a partial-sync mode. This exercise does not include
publishing a release, automatically splitting a PR/MR, or reopening a sealed run.

**Recorded status:** native C-only continuation and ordinary sync/normal close executed in
scenario 17b. Keep the original scenario-17 operational failure alongside that result; these are
different runs, not a continuation or reopening of the original sealed run.

#### Original scenario 17 — FAILURE

The original fixture ended sealed at HEAD `6527c17` with 20 events. Its original 11-event prefix
and A/B snapshot hashes survived partial selection and C-only continuation. Native coder
`f56a60ad` committed `5a7d907`; candidate/integration tests passed 4/4, formal reviewer `9237b010`
approved, and whole-final reviewer `cee34925` reviewed the source. A local descriptive README
finding was corrected at `6527c17`; the parent checked unchanged source/tests and recorded why
that correction did not require another full review. Earlier merge-message and missing spec
closing-guidance failures were recorded and corrected, not erased.

**Operational failure:** the parent marked C resolved in the snapshot but omitted the required
`merge SHA:` closing comment from the existing skill's Merge and close step. Ordinary sync
closed A, B and the spec, but only posted C's historical escalation comment: C remained open.
The parent incorrectly marked the PR ready and sealed as completed before independently checking
that result. Post-seal assertions exposed the open C ticket. A successful sync command or a
recorded completed outcome was therefore **not** evidence of complete operational delivery.
This was a parent omission, not evidence of a production sync defect or a reason to add a bypass.
The sealed failed run is retained and not reopened; later ledger writes were refused.

**Verification entry:** retain `scenario17-result.md`, the original `events.jsonl`/notes/snapshot,
C and whole-final findings, git history, external tracker-stub state and call log. Within the run's
`evidence/`, inspect `parent-partial-prefix.jsonl`, `parent-partial-AB-snapshots.sha256`,
`parent-resume-build.log`, `parent-resume-check.log`, `parent-C-candidate-tests.log`,
`parent-C-integration-tests.log`, `parent-postfinding-tests.log`, `parent-final-sync.log`,
`parent-final-sync-retry.log` (three closes and a C comment), and
`parent-postseal-write-refused.log`. Compare C's open tracker-stub state with the completed close
payload rather than relying on the parent's mistaken completion note. All inputs concerning
user acceptance, permission, tracker and historical A/B reviews were controlled and synthetic;
git, tests, ledger commands and native C/review/final execution were actual.

#### Independent scenario 17b — bounded success

Scenario 17b is a distinct run in an independent fixture, not a resume of sealed scenario 17.
Its baseline was `8367fa9` and final fixture HEAD `41969fec`. The parent executed real snapshot/init,
git merges, tests and ledger commands. Initial A/B dispatch identities and historical approvals,
user acceptance of partial delivery, permission and the tracker were synthetic fixture inputs.
The current A/B-only tests passed 2/2; the initial full suite failed the two unimplemented C tests.

At partial delivery, the parent retained the 11-event prefix, snapshot, findings and claim, with
no final sync, spec closure, PR ready, seal or final cleanup. A positive controlled permission
probe and fresh build/check preceded C dispatch. Prefix and A/B snapshot comparisons confirmed
no reinit, repull, A/B redispatch or repeat merge. Only C's ticket events followed the pause.

| Executed stage | Native identity / retained report | Recorded result and evidence |
| --- | --- | --- |
| Isolated C coding | Native run `13089448`; `coder17b.md`, artifact `6c4f6bea` | RED reproduced the two C failures, then commit `ce268f4` changed only `src/farewell.js`; actual platform typed gate reported 4/4. The coder report records permission scope, commit and gate command |
| Full C formal review | Native run `95d7aabf`; `reviewC17b.md`, artifact `822ba0bf` | Both axes completed with zero findings and approved candidate `ce268f4`. The reviewer explicitly identifies the 4/4 platform gate as parent-reported, not independently verified from a separate platform artifact; it ran no tests |
| C merge and snapshot facts | Parent actions | Real no-ff merge `41969fec`, independently run integration tests 4/4 before merge accounting at sequence 15, then C resolved with the exact `merge SHA:` comment. Parser evidence agrees with git/event SHA and retains historical escalation |
| Fresh whole-branch final review | Native run `4d12d7b9`; `final17b.md`, artifact `518393bb` | Read all current source, tests and pinned whole-branch diff rather than trusting synthetic A/B approval history; both axes and cross-ticket hunt had zero findings, verdict ready at sequence 16. It independently read the parent's 4/4 integration log, not a platform gate-provenance artifact, and did not run tests |
| Ordinary sync and close | Parent commands and independent state assertions | Ordinary full sync closed A, B, C and spec. An independent assertion found all four closed before ready or seal, with the PR still draft and 16 events/unsealed. Actual PATH-stub PR ready was sequence 17, completed close sequence 18; post-seal writing was rejected |

**Verification entry:** archive `scenario17b-result.md`, the three native reports above, native
session/gate artifacts, git history/diffs, findings and ledger/notes with the tracker-stub state
and call log. The native run identifiers and report-artifact identifiers name different objects;
use the archive manifest to resolve both. In the run's `evidence/`, retain:

- Partial/continuation: `parent-partial-AB.log`, `parent-partial-build.log`,
  `parent-partial-check.log`, `parent-partial-prefix.jsonl`,
  `parent-partial-AB-snapshots.sha256`, `parent-permission-green.log`,
  `parent-resume-build.log`, `parent-resume-check.log`.
- C validation/accounting: `C-candidate.diff`, `parent-C-integration-tests.log`,
  `parent-C-snapshot-facts.json`, `parent-presync-check.log`.
- Closing assertions: `parent-final-sync.log` (four closes, no escalation-only substitute),
  `parent-preseal-remote-check.json` (all four closed, PR draft, run unsealed, 16 events),
  `parent-sealed-check.log`, `parent-postseal-write-refused.log`,
  `parent-final-assertions.json` (original prefix unchanged, init once, A/B dispatch/merge once,
  post-pause ticket events C-only, closure-before-ready, 18 events, completed outcome, refusal).

Snapshot data was retained throughout partial delivery and continuation; only after the completed
normal flow was it copied to external `archived-tracker/` for audit and removed from the active run.
Findings, events, ledger, notes and evidence were retained. Full managed-worktree cleanup was not
yet established by the scene report. Archive the evidence before any later cleanup; none of these
files is promised as permanently available or downloadable from this repository.

**Boundaries:** this is actual bounded native C-only execution with explicit briefs, actual git,
tests and ledger commands, actual C formal/source final review, and stateful tracker stubs. It is
not live GitHub or service authorization, autonomous native implementation/review of the synthetic
A/B history, or approval of the plugin implementation itself. The final source review did not
certify remote closure; the parent's later independent state assertions supply that evidence.
Session-registered agent profiles may predate the modified source definitions, so this does not
prove runtime reload/registration of the newer profiles. Neither this success nor the preserved
failure guarantees general model correctness or finite total runtime/cost.

## Deterministic validation entry points

Run from the package repository; capture output and exit codes with a 600-second command timeout.

```sh
node --test test/ledger-cli.test.js test/init-cli.test.js
node --test test/sync-cli.test.js test/gitlab-cli.test.js test/snapshot-cli.test.js
node --test test/self-check.test.js test/audit-report.test.js
npm test
```

- [Ledger CLI tests](../../test/ledger-cli.test.js) exercise real subprocesses and temporary git
  repositories: repair/review independence, current approval, escalation history, unrecorded
  merge differences, explicit seal outcomes/refusals, and historical compatibility.
- [GitHub sync tests](../../test/sync-cli.test.js) and [GitLab CLI tests](../../test/gitlab-cli.test.js)
  exercise stateful external command stubs, failure/retry and idempotence; [snapshot CLI tests](../../test/snapshot-cli.test.js)
  cover the snapshot boundary. These fixtures are not live remote runs.
- [Self-check tests](../../test/self-check.test.js) check that flow/brief conventions are present;
  [audit tests](../../test/audit-report.test.js) check history, evidence gaps and closing-result
  presentation. Static checks cannot verify autonomous pause, permission, or delivery judgment.

Keep contributor evidence separate from user-facing promises. Acceptance reports should name
remaining native scenarios and unavailable artifacts explicitly; model correctness and finite
aggregate runtime/cost are not deterministic guarantees.
