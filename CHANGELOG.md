# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
