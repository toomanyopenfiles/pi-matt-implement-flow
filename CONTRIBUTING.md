# Contributing to pi-matt-implement-flow

Thanks for your interest in contributing! This package is a [pi](https://github.com/earendil-works/pi)
package: one skill plus three agents (`coder`, `reviewer`, `final-reviewer`) that take over the
implementation stage of [Matt Pocock's engineering flow](https://github.com/mattpocock/skills).

## Getting started

- Requirements: Node.js (for the scripts and tests), [pi](https://github.com/earendil-works/pi) with
  the [pi-subagents](https://github.com/nicobailon/pi-subagents) package.
- Run the test suite: `npm test` (plain `node --test test/*.test.js`, no build step, no install needed).
- Test layers (all inside `npm test`, all also run in CI): **unit/integration** (pure logic in
  `scripts/` and `audit-report/`), **CLI black-box** (real `node` subprocesses on temporary git repos
  with a stateful `gh`/`glab` PATH stub), **static contracts** (SKILL/agent/dispatch wording guards —
  not behavioral evidence), and **package system** (a real `npm pack` tarball is unpacked outside the
  repo and the packaged CLI runs five representative scenarios). `npm run test:package` runs just the
  package-system layer for focused debugging; CI only ever runs `npm test` so no suite runs twice.
  The coverage matrix (what is proven where, and what is explicitly *not* proven) lives in
  [`docs/agents/regression-coverage.md`](./docs/agents/regression-coverage.md).
- Test layout: every test lives under `test/` (fixtures in `test/fixtures/`), named after what it
  covers — `<module>.test.js` for a module in `scripts/` or `audit-report/`, `<sub-command>-cli.test.js`
  for a CLI black-box suite. `test/repro-*.js` are manual acceptance probes (`npm run repro`, real model
  calls) and are never part of `npm test`. None of `test/` ships in the npm package.
- Orientation for agents and humans alike: [`AGENTS.md`](./AGENTS.md) points at the issue-tracker
  setup, the triage label vocabulary, and the domain docs; [`CONTEXT.md`](./CONTEXT.md) holds the
  glossary and the flow's vocabulary.

## Reporting bugs

Use the **Bug Report** issue form. The fields that matter most:

- **Steps to reproduce** — numbered, starting from the command you ran. Most bugs here are
  orchestration bugs, so the run state matters: which round it was in, what the ledger said.
- **Relevant log output** — the error text plus, when available, the tail of
  `.pi/matt-implement/<slug>/events.jsonl`. Redact anything sensitive.

Security vulnerabilities are reported privately — see [`SECURITY.md`](./SECURITY.md).

## Suggesting features

Use the **Feature Request** issue form. Frame the problem first, then the proposal. Keep in mind
the package's scope boundary: it replaces only the implementation step of the upstream flow —
grilling, spec-writing, and ticket-splitting stay upstream.

## Issue lifecycle

Every triaged issue carries exactly one **category** label and one **state** label:

| Category | Meaning |
| -------- | ------- |
| `bug` | Something is broken |
| `enhancement` | A new feature or improvement |

| State | Meaning |
| ----- | ------- |
| `needs-triage` | Filed, waiting for a maintainer to evaluate |
| `needs-info` | Waiting on the reporter for more information |
| `ready-for-agent` | Fully specified and reproducible — ready to be picked up |
| `ready-for-human` | Needs a human to implement (design decisions, maintainer-only access, …) |
| `wontfix` | Will not be actioned (an explanation is always posted) |

A normal report travels `needs-triage` → (`needs-info` →) `ready-*` → closed by a linked PR.
Issues labeled `ready-for-agent` may be picked up by an agent run of the orchestrator.

If we ask for more information and don't hear back, we may close the issue after a couple of
weeks — reopening it later is always fine when the information shows up.

## Pull requests

PRs are welcome. Before investing in a large change, open an issue first so the design can be
discussed. Please:

- keep the test suite green (`npm test`), and add tests for behavior changes;
- keep `README.md` and `README.zh-CN.md` sections in sync (a change to one means the matching
  change to the other);
- update `CHANGELOG.md` for user-visible changes.
