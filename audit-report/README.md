# audit-report — flow audit report (side-channel forensics)

English | [简体中文](./README.zh-CN.md)

Purely local, side-channel forensics over one finished pi-matt-implement-flow run, producing a
browsable static report site for human auditors to check how the whole flow executed and to
surface latent problems.

- **Zero LLM calls**: everything is collected mechanically from the event stream, the platform's
  retained subagent evidence, the main session, and git facts.
- **Bilingual output**: `--lang zh|en` picks the language of the report site and every output —
  page chrome, deterministic risk texts, forensics warnings, timeline narration, glossary
  definitions, analysis brief, CLI (default `zh`). Facts and evidence are language-independent.
- **Zero main-flow intrusion**: SKILL.md / the ledger scripts / the agents are untouched, and
  main-flow files and the target repo's source are read-only. The report is written to `report/`
  under the run directory by default (the run directory as a whole is gitignored, so git status
  stays clean); to leave the target repo completely untouched, point `--out` outside it. This
  directory is not in the npm publish surface (not in the `package.json` `files` allowlist).
- **Facts and opinions are layered**: the report body is deterministic fact (every item traces
  back to its source); AI analysis is an explicit two-step backfill flow (below), rendered and
  labelled as non-fact.
- **By-products**: the report directory also gets `model.json` (intermediate forensics model, for
  debugging and secondary analysis) and `analysis-brief.md` (only with `--ai-brief`). Both are
  products of this tool, not files of the target repo.

## Usage

```bash
# Minimal: report on one run (output to <run dir>/report/, open index.html in a browser)
node audit-report/report.js --runtime-dir <repo>/.pi/matt-implement/<slug>

# Output elsewhere (e.g. outside the repo, leaving the target repo completely untouched)
node audit-report/report.js --runtime-dir <...> --out /path/to/report-out

# Generate the report in English (default is Chinese)
node audit-report/report.js --runtime-dir <...> --lang en

# Export an AI analysis brief (optional, see below)
node audit-report/report.js --runtime-dir <...> --ai-brief

# Re-render with an already backfilled AI analysis
# (optional; not needed when the file sits in the report directory)
node audit-report/report.js --runtime-dir <...> --ai-analysis <analysis>.json
```

## What the report contains

| Page | Contents |
|---|---|
| `index.html` | Run overview (branch / spec / flow shape / test gate / PR / seal), run stats, the **anomalies & risks** section (deterministic findings), the ticket table, a narrated event timeline, usage & cost, glossary |
| `ticket-NN.html` | The full evidence chain per ticket: ticket text → dispatch brief text → the implementer's structured report and acceptance details (including gate output) → review verdict with the full findings list → review diff → fix rounds → merge |
| `final.html` | Final review (whole-branch) verdict and full text (with a `final` event the verdict is taken from the event), anomalies and escalations, sealing record (a note when unsealed), full orchestration notes |

## Anomalies & risks (deterministic findings)

Every item is found mechanically by script and traces back to its source; nothing is model
inference. The rules:

- a subagent run that failed (non-zero exit code)
- an acceptance that was rejected
- an anomaly record
- an escalation
- the fix-round budget used up
- the run not sealed
- sealed with a wound: the latest final-review verdict at seal time was `not_ready`
- platform-side evidence missing
- a dispatch brief that could not be restored
- 2+ rounds of `changes_requested` verdicts on the same ticket

Items are sorted by severity (high / medium / low). Three presentation tags adjust how an item is
shown, but **no risk item is ever deleted**:

- **"Recovered" downgrade (a factual exemption)**: a failed run or a rejected acceptance that has
  a later successful settle (`settled`) on the same ticket is downgraded to medium and tagged
  "recovered by a later run", with a link to the recovering run; never-recovered ones stay high.
  The downgrade stops at medium — the work really was interrupted — and several incidents in a row
  are never erased by one success: each stretch is judged on its own.
- **"Corrected" tag**: an anomaly can carry a `refSeq` pointing at the record it corrects; when
  the pointed-to record has been superseded by a later record of the same type on the same ticket,
  the anomaly is downgraded to medium and tagged "corrected", and its derived evidence-missing
  risk carries the "corrected" tag too. The correction basis is shown alongside, for human
  re-check.
- **Dead runRef detection**: a run reference whose runId is clearly not in the platform's run-id
  shape is dead data from bookkeeping pollution — no platform evidence is probed for it, and it
  takes no part in evidence-missing risk derivation; one `run-ref-dead` entry is left in the
  forensics warnings for humans to check. The polluted dispatch event itself stays on the timeline
  as recorded.

## AI analysis layer (optional, two-step backfill)

Deterministic checks can only find modelled anomalies; semantic contradictions across evidence are
worth one LLM analysis pass. To keep fact and opinion layered, an offline two-step flow is used
instead of online calls:

1. `--ai-brief` exports `analysis-brief.md` (a self-contained evidence brief, with the backfill
   format instructions appended);
2. hand the brief to a language model (or analyse it in a pi session), write `ai-analysis.json`
   per the instructions and rerun this tool — an `ai-analysis.json` in the report directory is
   picked up automatically; if the file lives elsewhere, pass it via `--ai-analysis <file>`.

Opinions render into a separate "AI analysis" section explicitly marked as non-fact: they are for
hinting at cross-evidence contradictions and unmodelled risks — verify them against the evidence,
do not take them as fact.

## Tests

```bash
node --test audit-report/collect.test.js
```

Tests use synthetic fixtures (temp directories + fake session data, auto-cleaned) and depend on no
real run data.

## Data sources & correlation

| Evidence | Location | Used for |
|---|---|---|
| Event stream | `<run dir>/events.jsonl` | timeline, ticket state machine, run ids |
| `final` event | the `final` events in `<run dir>/events.jsonl` | the final-review run's runId and verdict: on the event-driven path the final-review list, cost bucket and findings text are all located from here (ledgers without a `final` event fall back to the directory scan below) |
| Platform evidence (the four) | `~/.pi/agent/sessions/--<repo path>--/subagent-artifacts/<runId>_*` | structured output, acceptance record, gate output, process transcript |
| Main session | `~/.pi/agent/sessions/--<repo path>--/*.jsonl` | restores each dispatch brief's original text (the input task in platform artifacts is placeholder text; the original only exists in the main session) |
| Tickets & spec | `<repo>/.scratch/<slug>/` | ticket text and titles |
| Review material | `<run dir>/reviews|findings/` | review input diffs and findings lists |
| git | read-only queries | commit existence and subjects |

Any missing layer degrades to a page annotation and a forensics warning; the rest of the evidence
is unaffected.
