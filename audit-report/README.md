# audit-report — post-run audit report

English | [简体中文](./README.zh-CN.md)

A purely local audit tool for one finished pi-matt-implement-flow run: it turns the run into a
browsable static report site, so you can check how the whole run went and surface latent problems.

**When to use it**: double-check a run's quality before you merge; find where things went wrong
after the fact; keep an auditable record of what happened.

- **No LLM calls** — everything is collected automatically from the run's local records and git
  history.
- **Bilingual output** — `--lang zh|en` picks the language of the whole report site and every
  output: page text, risk descriptions, warnings, timeline narration, glossary, analysis brief,
  CLI (default `zh`). Facts and evidence are the same in either language.
- **Your repo stays untouched** — the tool only reads; your run data and source code are never
  modified. The report is written to `report/` inside the run directory by default (already
  gitignored, so `git status` stays clean); use `--out` to write it elsewhere and leave the target
  repo completely untouched.
- **Facts and opinions are kept apart** — the report body is fact: every item traces back to its
  source. AI analysis is optional (see below) and rendered in a separate section marked as
  non-fact.
- **Extra files you can ignore** — the report directory also gets a `model.json`, and with
  `--ai-brief` an `analysis-brief.md`. Both are by-products of this tool, not files of your repo.

## Usage

```bash
# Minimal: report on one run (output to <run dir>/report/)
node audit-report/report.js --runtime-dir <repo>/.pi/matt-implement/<slug>

# Output elsewhere (e.g. outside the repo, leaving the target repo completely untouched)
node audit-report/report.js --runtime-dir <...> --out /path/to/report-out

# Generate the report in English (default is Chinese)
node audit-report/report.js --runtime-dir <...> --lang en

# Export an AI analysis brief (optional, see below)
node audit-report/report.js --runtime-dir <...> --ai-brief

# Re-render with an already filled-in AI analysis
# (optional; not needed when the file sits in the report directory)
node audit-report/report.js --runtime-dir <...> --ai-analysis <analysis>.json
```

When it finishes, open `report/index.html` in a browser.

## What the report contains

| Page | Contents |
|---|---|
| `index.html` | Run overview (branch / spec / flow shape / test gate / PR / closing result), run stats, the **anomalies & risks** section (found by rules), the ticket table, a narrated event timeline, usage & cost, glossary |
| `ticket-NN.html` | The full story of each ticket: the ticket text → what the implementer was asked to do → their report and acceptance details (including the test-gate output) → the review verdict with the full findings list → the review diff → fix rounds → merge |
| `final.html` | The whole-branch final review: verdict and full text, anomalies and escalations, the closing result (normal completion, explicit abandonment, or an older record without a stated result), and the orchestration notes |

If any source of evidence is missing, the affected pages say so; everything else still works.
Historical repair limits remain visible as historical records, not as current attempt quotas or
reasons a run cannot continue. Actual repairs and full review evidence remain available; a
clarified or withdrawn finding is not a full approval.

The closing result tells you how the run ended, not whether every saved change is ready to use.
Explicit abandonment preserves the work and evidence but is not complete delivery or approval;
unfinished tickets remain open. A pause leaves the run open, while a closed run cannot be reopened.
For older closing records without a stated result, the report does not guess completion or
abandonment. A new normal completion cannot proceed with a “not ready” final review; abandoned
runs and historical records may still contain that verdict, which remains visible.
See [ADR-0009](../docs/adr/0009-prompt-driven-repair-and-run-continuation.md) for the design.

A ticket merged after an earlier hand-off shows as complete, with the escalation, its reason,
and the later work still visible. A hand-off without a merge is not completion or proof that its
dependents can start. An escalation or anomaly in the history does not by itself prove a current
blocker or unresolved fault. Read the orchestration notes and supporting evidence for the decision,
handling, and continuation details. When those cannot be verified, the report asks you to check;
it does not claim recovery or approval from notes alone. Failure history and evidence-backed
recovery or correction labels remain visible.

## Anomalies & risks (found by rules, not by a model)

Every item is found mechanically by rule and traces back to its source — nothing is model
inference. What gets flagged:

- a worker run that failed
- a rejected acceptance
- an anomaly record in the history
- an escalation in the history
- a run that never finished cleanly
- a run closed with the final review still saying `not_ready`
- missing evidence for a recorded run
- a ticket's task text that could not be recovered
- the same ticket marked `changes_requested` two or more rounds

Items are sorted by severity (high / medium / low). Three tags adjust how an item is shown, but
**no risk item is ever deleted**:

- **"Recovered" downgrade** — a failure or rejection that a later success on the same ticket made
  good is downgraded to medium and tagged "recovered by a later run", with a link to the run that
  recovered it; ones that never recovered stay high. The downgrade stops at medium — the work
  really was interrupted — and a streak of incidents is never erased by a single later success.
- **"Corrected" tag** — when an anomaly record supersedes an earlier record it corrects, the
  anomaly is downgraded to medium and tagged "corrected", and related missing-evidence risks carry
  the tag too. The correction basis is shown alongside, for you to re-check.
- **Invalid run references are ignored** — a run reference that is obviously not a real run id is
  bookkeeping noise: it is skipped instead of surfacing as missing evidence, and listed in the
  warnings for you to check.

## AI analysis layer (optional)

Rule-based checks only find known kinds of problems; semantic contradictions hiding across
evidence are worth one LLM pass. The tool never calls a model itself — a two-step flow keeps facts
and opinions apart:

1. `--ai-brief` exports `analysis-brief.md` — a self-contained evidence brief with the format
   instructions for the analysis appended;
2. hand the brief to a language model (or analyse it in a pi session), write `ai-analysis.json`
   following the instructions, and rerun this tool — a file in the report directory is picked up
   automatically, or pass `--ai-analysis <file>` if it lives elsewhere.

The opinions render into a separate "AI analysis" section explicitly marked as non-fact: they hint
at cross-evidence contradictions and unmodelled risks — verify them against the evidence before
believing them.

## Troubleshooting

- **Some items say evidence is missing?** — a layer of evidence was not found (e.g. the pi session
  records were cleaned up); the affected pages name what is missing, everything else is unaffected.
- **An anomaly or escalation is still listed after work continued?** — history is kept even
  after a successful retry or later merge. Check the current ticket status, orchestration notes,
  and evidence; a historical item alone does not mean the problem is still present. Missing
  evidence means the outcome needs checking, not that recovery has been established.
- **The report says the run was abandoned?** — the saved work is not being presented as ready.
  Check the unfinished-work summary, review findings, and evidence before using it.
- **Wrong language?** — rerun with `--lang zh|en`.
- **Where is the report?** — in `report/` under the run directory by default, or wherever `--out`
  points.
