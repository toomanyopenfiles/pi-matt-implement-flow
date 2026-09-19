# pi-matt-implement-flow

Turn a spec + ticket graph into a reviewed, tested branch with one command. Coders implement tickets in parallel — each in its own worktree — every ticket passes a two-axis review with fixes looped back to its coder, and the finished branch faces a full integration test plus a final whole-branch review.

It is the automated, orchestrated successor to Matt Pocock's [`/implement`](https://github.com/mattpocock/skills) for multi-ticket graphs.

English | [简体中文](./README.zh-CN.md)

## Why not just /implement?

If you use Matt Pocock's engineering skills, the upstream flow stays the same: `/grill-with-docs` → `/to-spec` → `/to-tickets`. This package takes over only the last step — implementation. `/implement` is a lightweight tool for one lump of work; when the work is a **multi-ticket graph**, its limits show:

|                  | `/implement`                                                                                     | pi-matt-implement-flow                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Progression      | one ticket at a time in a single session; you track which tickets have unlocked                     | the frontier is computed for you; one command runs the graph to completion                                                                                                                                          |
| Concurrency      | one ticket at a time                                                                             | up to N coders in parallel, each in its own isolated worktree                                                                                                                                                       |
| Review           | one `/code-review` at the end                                                                    | every ticket gets a two-axis review (standards + spec); findings go **back to the same coder** — the fixer already holds the ticket's full context; when the fix budget runs out, the ticket escalates to you instead of blocking the run |
| Integration risk | you find out whether everything works together only at the end                                   | the full test suite runs after every merge, so integration problems surface on their own ticket                                                                                                                         |
| Session breaks   | recovered from context memory; drifts                                                            | run state is journaled to disk; an interrupted or compacted session resumes from a known state                                                                                                                      |

Matt's repo also has an in-progress [`implement-spec`](https://github.com/mattpocock/skills/blob/main/skills/in-progress/implement-spec/SKILL.md) with the same idea (worktree parallelism + frontier progression). The difference: it is a prose recipe the model improvises — no per-ticket review-and-fix loop, no journaled run state, no configurable behavior. Those three are exactly what make it safe to hand off a long ticket graph.

### What it costs

Parallelism and per-ticket review are not free: N coders each running tests, two review axes per ticket, plus fix rounds — token usage is noticeably higher than a single serial session. You can turn per-ticket review off (`reviewer: false`; the integration test gate and the final whole-branch review still run) or lower `maxConcurrent` to spend less.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent with the [pi-subagents](https://github.com/nicobailon/pi-subagents) package (parallel dispatch, managed worktrees, resume)
- Matt Pocock's [engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering) — the upstream flow (`/grill-with-docs` → `/to-spec` → `/to-tickets`) and the ones the agents work with: `tdd`, `codebase-design`, `code-review`, `resolving-merge-conflicts`

## Install

```sh
pi install npm:pi-matt-implement-flow
```

Optionally, verify the installation with the self-check suite (test files are not part of the published tarball, so run it from a clone of this repo):

```sh
git clone https://github.com/toomanyopenfiles/pi-matt-implement-flow.git
cd pi-matt-implement-flow && npm test
```

## Quick start

1. **One-time setup** — install pi, pi-subagents, and Matt Pocock's engineering skills, then run `/setup-matt-pocock-skills` once in your repo.
2. **Prepare the work**:

   ```
   /grill-with-docs
   /to-spec
   /to-tickets
   ```

   Before starting, check: a clean worktree, at least one commit, and a full-suite test command that runs.

3. **Run**:

   ```
   /pi-matt-implement-flow [N]
   ```

   `N` is the number of parallel coders (default 3). When it finishes, you have a feature branch — or a ready-for-review PR, if the repo has a GitHub remote — where every ticket was implemented, reviewed, and integration-tested, without per-ticket babysitting.

## How it works

You hand the orchestrator a spec and its ticket graph. It creates a feature branch, dispatches coders to the ready tickets (each in its own worktree), reviews every ticket, sends fixes back to the coder that did the work, merges with a full test run, recomputes what is ready next, and finishes with a whole-branch final review.

```mermaid
flowchart LR
    S[Spec + tickets] --> O["/pi-matt-implement-flow"]
    O --> P[Parallel coders<br>one ticket per worktree]
    P --> R[Every ticket reviewed,<br>fixes looped back]
    R --> M[Merge + full test suite]
    M --> F[Whole-branch final review]
    F --> PR[Ready PR]
```

Tickets that exhaust their fix budget escalate to you at the end instead of blocking the rest of the run.

Run state lives in `.pi/matt-implement/` — auto-gitignored, safe to delete.

## Configuration

### `/matt-flow-config`

An interactive, no-LLM wizard built into the package:

```
/matt-flow-config        # pick a role → pick its model / thinking level, or edit flow options
/matt-flow-config show   # show the effective model / thinking resolution for all three roles
```

It edits pi's `subagents.agentOverrides` (user `~/.pi/agent/settings.json` or project `<repo>/.pi/settings.json`; project wins over user, field by field). Changes take effect on the next subagent dispatch — no pi restart needed.

### Flow options

```jsonc
{
  "mattImplementFlow": {
    "reviewer": true,      // per-ticket review + fix loop; false = merge straight after the test gate
    "maxFixRounds": 2,     // fix attempts per ticket before escalation
    "maxConcurrent": 3     // parallel coders; /pi-matt-implement-flow <N> wins
  }
}
```

Set via `/matt-flow-config` → "Configure flow options", or edit the `mattImplementFlow` section in your pi `settings.json` directly. Changes apply from the next run — a run in progress is never affected.

## License

[MIT](./LICENSE)
