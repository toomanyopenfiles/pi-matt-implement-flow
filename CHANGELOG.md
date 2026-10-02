# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe what each release means for users of the package. Design decisions and
implementation history live in [`docs/adr/`](./docs/adr/).

## [Unreleased]
### Added

- Bug reports and feature requests now go through GitHub issue forms; see
  [CONTRIBUTING.md](./CONTRIBUTING.md) for how issues are handled, and [SECURITY.md](./SECURITY.md)
  for private vulnerability reporting.

### Changed

- All user-facing docs (both READMEs and the audit-report docs) rewritten from the user's point of
  view: plain language, no internal implementation details. The main READMEs gained a
  troubleshooting FAQ and a "what you get when the run finishes" section.

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

[Unreleased]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/releases/tag/v0.1.0
