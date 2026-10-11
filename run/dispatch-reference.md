# Dispatch reference — briefs and the path rule

pi-matt-implement-flow operation doc, split verbatim out of the trunk `SKILL.md` (the always-loaded entry point — read it first). **Continue:** when the dispatch script file is written to a new `.pi/matt-implement/<slug>/wf/` file and every angle bracket in the template is filled.

## Briefs

Fill the angle brackets; send nothing else.

**Path rule for all briefs**: any path that does not physically exist inside the recipient's worktree (everything gitignored — `.scratch/`, `.pi/`, `data/`, …) is given as an absolute main-repo path and marked read-only. The rule covers all five brief templates below; there are no special cases for isolation shape. When the run reads a tracker snapshot, the ticket and spec paths in every brief are the snapshot's copies under `.pi/matt-implement/<slug>/tracker/` — same rule, same read-only marking.

### Coder brief

```
Ticket 07: add a farewell module. (ticket number and title first — your commit messages must reference it)

Ticket file: <absolute main-repo path>. Spec: <absolute main-repo path>.
Base commit: <sha>. Test command: `npm test`.

## Worktree reality
Your worktree contains ONLY committed files — everything gitignored (data/, .scratch/,
.pi/, …) does not exist inside it. The ticket, spec, findings, and data paths in this
brief are absolute main-repo paths (read-only). Everything you edit and commit stays
inside your own worktree. Other tickets under .scratch/ and anything else in the main
repo are context, not scope — never implement them.

You are in your own pi-managed worktree on your own branch based at that commit; every command and edit stays inside it. Run the project's install step (e.g. `npm ci`) before the first test if node_modules is not linked. Build this ticket: work test-first at the pre-agreed seams, full suite once at the end, then commit everything and report the headSha and branch by context pointer. Keep the tree fully committed: a dirty tree or an empty diff fails the gate.
```

### Reviewer brief

```
Ticket 07 (ticket file: <absolute main-repo path>). Spec: <absolute main-repo path>.
Review bundle: <absolute main-repo path>/.pi/matt-implement/<slug>/reviews/07-r1.diff (three-dot diff + commit list against base <sha>).
Implementer's report: the typed-gate report (`headSha` <sha>, `testResult` <one-line summary>) — mechanical gate evidence.
Axis script: <absolute path to this package>/scripts/axis-axes.js (read-only) — you spawn both axes through it.
Run timeout settings: user: <absolute user settings path>; project: <absolute main-repo project settings path or null> (read-only; from run-timeout --settings-paths). Read these again immediately before spawning the axes.
Your worktree is checked out at refs/heads/ticket-07 — the post-change tree. Read the changed files there; review-bundle and findings paths are main-repo paths (read-only).

Run your two-axis process and return the structured verdict.
```

### Fix follow-up (to the same coder, via resume)

```
Review round <k> found issues: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/<NN>-r<k>.md.
Fix them in your worktree, rerun the full suite, commit everything, and report the new headSha by context pointer. The orchestrator hand-runs the gate for this round (see Fix loop).
```

### Integration fixer (no isolation)

```
The full suite is red after merging ticket <NN>: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/integration-<NN>.md.
You are on the feature branch in the main checkout, without isolation and as its sole writer for this repair; stay in this cwd and branch. This is an integration problem ticket-level reviews could not see. Fix it within the approved scope, run the full suite, commit on the feature branch, and report the new headSha and evidence pointers by context pointer. A pure-verdict gate re-runs the suite after you finish.
```

### Final fixer (no isolation)

```
The final review found issues: read <absolute main-repo path>/.pi/matt-implement/<slug>/findings/final-r<k>.md.
You are on the feature branch in the main checkout, without isolation and as its sole writer for this repair; stay in this cwd and branch. Fix every finding within the approved scope, run the full suite, commit on the feature branch, and report the new headSha and per-finding evidence pointers by context pointer. A pure-verdict gate re-runs the suite after you finish.
```

