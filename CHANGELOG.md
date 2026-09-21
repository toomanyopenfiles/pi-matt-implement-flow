# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-22
### Added

- `ledger add anomaly --ref-seq N` — the anomaly escape hatch can now point at the existing
  event it concerns or corrects, making the correction link machine-readable instead of
  prose. The pointer is validated at write time (positive integer, smaller than the current
  seq, pointing at an event already in the stream), `check` reports dangling or out-of-range
  pointers as ledger drift, and the timeline renders `↩ ref-seq N`.

### Changed

- Event envelope version bumped to 3: `anomaly` events may carry the optional `refSeq`
  correction pointer. Old ledgers (v1/v2, no `refSeq`) build and check with zero new noise —
  the reader has no version branches.
- Audit report severity now reflects what was actually remediated: a run rejected by
  acceptance and recovered by a later settle on the same ticket is downgraded to medium and
  tagged as recovered (with a link to the recovery run); `runId`s that are not UUID-shaped
  are treated as accounting pollution instead of missing platform evidence; and a polluted
  dispatch that carries a `refSeq` correction link is tagged as corrected instead of
  surfacing as a live evidence-missing risk.
- Whole-branch final review is now a first-class ledger event (`final`): the ledger
  header shows the latest verdict and run id, sealing the ledger is gated on a verdict
  once work has been merged, and the audit report derives the final-review run, cost,
  findings and verdict from the event stream instead of scanning artifact directories.
  Internal enhancement — the user-visible surface is a more complete ledger and audit
  report, with the final review now auditable.

### Fixed

- Audit report no longer double-joins absolute payload paths: `init --spec`, `verdict
  --findings` and `final --findings` may be recorded as absolute repo paths (per the
  brief's path rule) or relative ones — absolute paths are now used as-is instead of
  being joined onto the repo root, which previously degraded ticket-source evidence
  to `ticket-file-missing`.

[Unreleased]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/releases/tag/v0.1.0

## [0.1.0] - 2026-09-20

Initial public release.

### Added

- `/pi-matt-implement-flow [N]` — orchestrated parallel implementation of a spec's
  ticket graph: frontier computed automatically, up to N coders in parallel, each
  in its own managed worktree.
- Three registered agents: `pi-matt-implement-flow.coder` (test-first vertical
  slice per ticket), `pi-matt-implement-flow.reviewer` (per-ticket two-axis
  review), `pi-matt-implement-flow.final-reviewer` (whole-branch final review,
  including cross-ticket drift checks).
- Per-ticket review-and-fix loop: findings go back to the same coder via resume;
  tickets that exhaust their fix budget escalate instead of blocking the run.
- Integration test gate: full test suite runs after every ticket merge.
- Flow options (`mattImplementFlow` in pi settings): `reviewer` on/off,
  `maxFixRounds`, `maxConcurrent` — frozen at run start, so mid-run changes
  never affect a run in progress.
- `/matt-flow-config` — interactive, no-LLM wizard for model / thinking overrides
  and flow options.
- Journaled run state under `.pi/matt-implement/` (auto-gitignored): interrupted
  or compacted sessions resume deterministically.
- GitHub integration: draft PR opened on start, marked ready on completion.
- `npm test` self-check suite guarding package registration invariants.

### Changed

- READMEs polished: both now link to [mattpocock/skills](https://github.com/mattpocock/skills) up front;
  the Chinese version rewritten for natural phrasing with consistent English terminology
  (spec / ticket / coder / worktree / review).
- Package and repo descriptions now state the relationship to Matt Pocock's `/implement`.
