# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Audit report output is bilingual: `--lang zh|en` (default `zh`) selects the language of the
  report site — page chrome, deterministic risk texts, forensics warnings, timeline narration,
  glossary definitions — and of every by-product (AI analysis brief, CLI output). All copy lives
  in `audit-report/i18n.js` as paired zh/en catalogs (key parity is test-guarded); facts,
  evidence and risk findings are language-independent.

## [0.2.0] - 2026-09-22
### Added

- `audit-report/` — offline post-mortem audit tool for a finished run:
  `node audit-report/report.js --runtime-dir <repo>/.pi/matt-implement/<slug>` collects the
  event stream, platform subagent evidence, main-session dispatch briefs and git facts into a
  browsable static report site (run overview with a deterministic risk section, per-ticket
  evidence chains, a final-review page, and a glossary). Zero LLM calls, zero main-flow
  intrusion, tested against synthetic fixtures (`node --test audit-report/collect.test.js`);
  not shipped in the npm `files` allowlist. As-shipped behavior worth noting:
  - Deterministic risk rules (failed runs, rejected acceptance, anomalies, escalations,
    exhausted fix budgets, unsealed runs, sealing with a `not_ready` final verdict, missing
    platform evidence, unrestored dispatch briefs, repeated `changes_requested` verdicts),
    with three presentation tags that never delete a risk: a run failed/rejected and recovered
    by a later settle on the same ticket is downgraded to medium and tagged as recovered
    (linking the recovery run); an anomaly whose `refSeq` correction was superseded by a
    same-ticket record is tagged as corrected (its derived evidence-missing risk likewise);
    `runId`s that are not UUID-shaped are accounting pollution — flagged as `run-ref-dead`
    instead of surfacing as missing platform evidence.
  - The final-review run, cost, findings and verdict are derived from the `final` event;
    pre-`final` ledgers fall back to artifact-directory scanning.
  - Payload paths (`init --spec`, `verdict --findings`, `final --findings`) are located
    whether recorded as absolute repo paths (per the brief's path rule) or relative ones —
    no double-joining onto the repo root degrading ticket-source evidence to
    `ticket-file-missing`.
  - Optional two-step AI opinion layer, kept strictly separate from fact: `--ai-brief` exports
    a self-contained evidence brief; the analyzed `ai-analysis.json` (placed in the report
    directory or passed via `--ai-analysis`) renders as an explicitly non-factual opinion
    section.
- `ledger add anomaly --ref-seq N` — the anomaly escape hatch can now point at the existing
  event it concerns or corrects, making the correction link machine-readable instead of
  prose. The pointer is validated at write time (positive integer, smaller than the current
  seq, pointing at an event already in the stream), `check` reports dangling or out-of-range
  pointers as ledger drift, and the timeline renders `↩ ref-seq N`.

### Changed

- Event envelope version bumped to 3: `anomaly` events may carry the optional `refSeq`
  correction pointer. Old ledgers (v1/v2, no `refSeq`) build and check with zero new noise —
  the reader has no version branches.
- Whole-branch final review is now a first-class ledger event (`final`): the ledger
  header shows the latest verdict and run id, and sealing the ledger is gated on a verdict
  once work has been merged. Every round of final review is one event, and the latest
  verdict is the branch's readiness.
- Acceptance contract softened: `residual-risks` left the mandatory dispatched-evidence
  list — it is advisory and never a rejection reason. The mandatory five (changed files,
  new tests, run command, verify output, no-staged-files) are unchanged; registration
  self-check gains an invariant pinning the contract.

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

[Unreleased]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/toomanyopenfiles/pi-matt-implement-flow/releases/tag/v0.1.0
