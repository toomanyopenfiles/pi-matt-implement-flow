# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what each release means for users of the package. Design decisions and
implementation history live in [`docs/adr/`](./docs/adr/).

## [Unreleased]

### Changed

- Subagent runs get a 4-hour run deadline by default instead of 1 hour (`coder`, `reviewer`, and
  `final-reviewer`). Long tickets are cut off far less often. (#26)
  (Design: [ADR-0010](./docs/adr/0010-configurable-subagent-run-deadline.md).)

### Added

- `/matt-flow-config` can change the run deadline for these subagents (`mattImplementFlow.agentTimeoutMs`,
  in milliseconds; project settings win over user settings; the wizard inputs minutes). The saved
  value applies to each new subagent when it is dispatched, including a reviewer's two review checks,
  even while the flow is in progress. No restart or new initialization is needed. Subagents already
  running are not affected. Continuing an existing subagent (resume) follows the platform's rules;
  this setting does not override its resume timeout. Removing the key falls back to the user setting
  or the 4-hour default.
  Command and test-gate timeouts, concurrency limits, and cancellation are unchanged. A longer
  deadline does not guarantee any single task fits, and total runtime and cost remain unbounded. (#26)
  (Design: [ADR-0010](./docs/adr/0010-configurable-subagent-run-deadline.md).)

## [0.4.0] - 2026-10-08

### Changed

- Ticket repairs no longer have an attempt quota. Older runs that are still open also ignore
  their historical limits, without changing saved settings or past records. Timeouts,
  concurrency limits, and cancellation remain, but total runtime and cost are not guaranteed
  to be finite. (#13)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)

- Integration and final-review repairs no longer stop automatically after two failed attempts.
  Repairs continue when evidence supports a reasonable next step within the approved scope;
  missing decisions, permissions, external conditions, or a justified next step prompt a pause
  for your input instead. Pausing leaves the run open. (#14)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)

### Added

- You can explicitly accept partial delivery after the completed work is checked on the current
  branch. The hand-off provides branch, commit, and validation evidence, with unfinished items,
  their effects, risks, and next steps. The same open run retains its local ticket copies and
  evidence without final tracker updates, spec closure, or marking the PR / MR ready. Once the
  missing conditions are checked, it continues the remaining work without replaying completed
  tickets, and finishes normally only after everything is done. This is not abandonment, an
  automatic release, or a separate PR / MR. (#17)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)

- You can explicitly abandon a run without arranging a new final review or handing off every
  unfinished ticket. The run stops related agents, saves code and evidence, explains unfinished
  work, and handles the feature claim before closing. Failures leave it open for retry.
  Abandonment does not close unfinished tickets or mark the feature ready; closed runs cannot
  be reopened. The run summary and audit report distinguish abandonment from normal completion,
  without guessing the intent of older closing records. (#16)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)

### Fixed

- After you answer a hand-off question, the same open run can continue the original ticket
  once the new conditions and evidence have been checked. A later validated merge shows the
  ticket as complete and closes it normally, without erasing the hand-off history. Past
  anomalies are not treated as permanent faults: a checked successful tracker-update retry
  lets the run continue, while failures and risks remain visible. Where evidence is missing,
  the audit report asks you to check rather than claiming recovery. (#15)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)
- Normal completion no longer accepts a “not ready” final review or treats a hand-off of
  unfinished work as complete delivery. Pausing remains different from closing the run. (#16)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)
- An interrupted run can repair a merge that still needs passing integration tests, while
  unrelated work waits and the ticket is not prematurely reported complete. Final-review
  repairs are checked finding by finding, with another review when the change's impact or
  missing evidence calls for one; green tests alone are not enough. (#14)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)
- A full ticket review can now follow multiple repairs, or happen again without another code
  change. Clarifying or withdrawing a finding still does not replace the approval needed for
  the current code. Audit reports retain historical repair limits without presenting them as
  a current reason to stop. (#13)
  (Design: [ADR-0009](./docs/adr/0009-prompt-driven-repair-and-run-continuation.md).)
- The audit report no longer fails on older run records whose reviews, repairs, or dispatches
  carry no platform run identifier. Those spots now say the run reference was not recorded,
  instead of crashing the report.
- A ticket that was only handed off (escalated) — never implemented — now shows up in the
  audit report's ticket list with its hand-off history, instead of being left out entirely.
- The audit report now lists every ticket of the run, including tickets that were never
  started. Previously a run you abandoned or partly delivered could show fewer unfinished
  tickets than the run's ledger did.

## [0.3.1] - 2026-10-03
### Added

- Bug reports and feature requests now go through GitHub issue forms; see
  [CONTRIBUTING.md](./CONTRIBUTING.md) for how issues are handled, and [SECURITY.md](./SECURITY.md)
  for private vulnerability reporting.

### Changed

- The comments the run posts to the tracker before it finishes (merged / escalated / run
  abandoned) are now written in English, so colleagues and clients reading an English-language tracker can
  understand them. Comments posted by earlier versions (Chinese) are still recognised —
  re-running the sync against them posts nothing twice. (#8)
- The npm package no longer ships development-only code (the test suite and its manual
  acceptance probes): it now contains only what a run needs. In the repository the tests all
  live under `test/`, one entry point (`npm test`) covering the whole suite.
- All user-facing docs (both READMEs and the audit-report docs) rewritten from the user's point of
  view: plain language, no internal implementation details. The main READMEs gained a
  troubleshooting FAQ and a "what you get when the run finishes" section.

### Fixed

- A fix retry (after a review asks for changes) that lands a committed, green fix no longer fails
  with a false "Structured acceptance report not found": the fix is judged by the test run, so
  finished work is never mistaken for failed work. (#7)
  (Design: [ADR-0008](./docs/adr/0008-typed-gate-mechanical-report.md).)
- Run instructions no longer tell workers to withhold reports, so they can never conflict with
  an acceptance form the platform asks for; each round is judged by its commit and a real test
  run. (Design: [ADR-0008](./docs/adr/0008-typed-gate-mechanical-report.md).)
- Subagent dispatching now works on current pi-subagents. Every dispatch — the coder waves, the
  per-ticket review, the fix loop, the integration fixer, and the reviewers' two-axis fan-out —
  ships its script as a file and calls it by path. The previous form (pasting the script into the
  same reply as the call) is rejected or missed by current pi-subagents, so runs could fail at
  dispatch time before any ticket work started. (#9)
- Per-ticket and final reviews now always wait for both axis reports before writing their verdict.
  Previously a review could wrap up while its two axis children were still running and end without
  a structured verdict, dropping the ticket into the fix loop with no findings. (#6)

## [0.3.0] - 2026-09-30
### Added

- GitLab Issues is now a first-class tracker, alongside local markdown and GitHub Issues: when the
  run finishes, your tickets are updated automatically (merged tickets closed and linked to their
  commits, escalations commented and left open), and a draft PR or MR opened at the start is
  marked ready for review when everything lands. Self-hosted GitLab works too.
  (Design: [ADR-0003](./docs/adr/0003-tracker-snapshot-and-pre-seal-sync.md), [ADR-0007](./docs/adr/0007-tracker-contract-presets.md).)
- With a remote tracker (GitHub / GitLab), two sessions can never silently start the same feature
  ([ADR-0003](./docs/adr/0003-tracker-snapshot-and-pre-seal-sync.md)); renamed labels are still
  recognized ([ADR-0006](./docs/adr/0006-triage-label-vocabulary-resolution.md)).
- Audit reports are now bilingual: `--lang zh|en` (default `zh`) selects the language of the
  report site and every output.

### Changed

- Remote trackers no longer need a `--tracker` flag or hand-maintained branches: the run follows
  the tracker your repo's `/setup-matt-pocock-skills` setup declares, and stops with a clear error
  when the setup is missing or unrecognized (the implicit local-markdown fallback is gone).
  (Design: [ADR-0007](./docs/adr/0007-tracker-contract-presets.md).)
- The tracker setup file `docs/agents/issue-tracker.md` is no longer bundled in the npm package —
  it is per-repo setup produced by `/setup-matt-pocock-skills`.
- Ticket numbers now follow the tracker's native numbering (e.g. GitHub issue numbers above 999
  are accepted). Local two-digit numbering is unchanged.
  (Design: [ADR-0004](./docs/adr/0004-tracker-native-ticket-numbers.md).)
- What each coder reports is now assembled mechanically from git facts and a real test run instead
  of the model's self-report: per ticket you get verifiable changed files, a test summary, and the
  tail of the test output. (Design: [ADR-0008](./docs/adr/0008-typed-gate-mechanical-report.md).)
- `audit-report/` now ships in the npm package, so npm users can generate audit reports from
  their run directories.

## [0.2.0] - 2026-09-22
### Added

- Audit report (`audit-report/`): a purely local tool that turns a finished run into a browsable
  static report site — run overview with an "anomalies & risks" section found by rules (not by a
  model), the full story per ticket, a whole-branch final review page, and a glossary. No LLM
  calls, and it never changes your run data. An optional two-step AI analysis layer is kept
  strictly separate from fact (`--ai-brief` → `ai-analysis.json`).
- Anomaly records can point at the event they correct (`ledger add anomaly --ref-seq N`), so
  corrections are machine-readable and shown in the timeline as `↩ ref-seq N`.
- The whole-branch final review is now recorded as a first-class event: the run's ledger shows the
  latest verdict, and a run can only be closed once the branch has one.
  (Design: [ADR-0002](./docs/adr/0002-final-review-ledger-event.md).)

### Changed

- Residual risks left the mandatory acceptance list — they are advisory and never a rejection
  reason.

## [0.1.0] - 2026-09-20

Initial public release.

### Added

- `/pi-matt-implement-flow [N]` — implements a spec's whole ticket graph in one command: tickets
  with no unfinished prerequisites run in parallel (up to N coders), and blocked ones start
  automatically once their prerequisites close.
- Per-ticket quality: each ticket is reviewed on two axes (coding standards + against the spec)
  and fixed until it passes; the full test suite runs after every merge; a whole-branch final
  review catches what single-ticket reviews cannot.
- Three separately configurable roles (`coder`, `reviewer`, `final-reviewer`) — each with its own
  model and thinking level, set through `/matt-flow-config` (an interactive wizard that never
  calls a model).
- Flow options in pi settings (`mattImplementFlow`): `reviewer` on/off, `maxFixRounds`,
  `maxConcurrent` — a run in progress is never affected by mid-run changes.
- Interrupted runs resume from the recorded state (run data under `.pi/matt-implement/`,
  gitignored).
- GitHub integration: draft PR opened on start, marked ready on completion.
- `npm test` self-check suite.

### Changed

- READMEs polished: both now link to [mattpocock/skills](https://github.com/mattpocock/skills) up front;
  the Chinese version rewritten for natural phrasing with consistent English terminology
  (spec / ticket / coder / worktree / review).
- Package and repo descriptions now state the relationship to Matt Pocock's `/implement`.

[Unreleased]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/releases/tag/v0.1.0
