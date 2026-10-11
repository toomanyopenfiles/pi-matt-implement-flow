# Recovery — cold resume and escalation history

pi-matt-implement-flow operation doc, split verbatim out of the trunk `SKILL.md` (the always-loaded entry point — read it first). **Continue:** once the reconciliation differences are explained and the interrupted stage is recovered, back into the remaining frontier, fix loop, merges, or final gate.

### Human handoff and history

Use ticket-level `escalate` to preserve a handoff history when **Repair decisions** requires user input. Escalation is not ticket completion, dependency satisfaction, permission for normal sealing, or permanent run termination. Write pending decisions, user decisions, the pause stage, and recovery explanations with evidence pointers in orchestration notes. Ordinary requirements decisions are not `anomaly`; add no pause, resume, or authorization events.

After a merged ticket is verified, it displays completed while retaining its escalation history and follows normal tracker closing by merge facts. For an unmerged escalated ticket, use subsequent facts and notes to explain the current action; keep unmerged tickets open and downstream dependencies blocked. Notes alone do not establish recovery or completion.

Keep `anomaly` and any optional `refSeq` as immutable history; write the disposition and evidence pointers in orchestration notes. A historical anomaly does not itself forbid closing or prove a current issue unresolved. Notes cannot revoke facts, reset attempt/review numbering, substitute for formal approval, or bypass effective validation. When reliable evidence is missing, verify it or request the user rather than declare recovery. Scripts do not parse notes to infer authorization, resumed state, or resolved anomalies; add no `anomaly-resolved` event.

### Cold resume (续跑) — the same command, an unfinished run

Before Round 0, check whether this run already exists: if `.pi/matt-implement/<slug>/events.jsonl` exists and the ledger header reads `state: running` (not sealed), the same command is a **continuation (续跑)**, not a new run — follow these recovery steps. `running` means unsealed, not that a child is executing:

1. **Skip init and the pull — both.** Never re-record `init` (the script rejects a second one), and never re-run `snapshot-init`: an existing snapshot is refused, never overwritten or re-pulled — a re-pull would let the tracker's lagging state overwrite the local truth (ADR-0003). The refusal is the continuation guard, not an error to work around. **One recovery wedge inside the guard**: if the snapshot already exists but the event stream carries **no `init` event** (a crash between `snapshot-init` and the `init` recording — the pull landed, the ledger did not), record `init` with `--spec .pi/matt-implement/<slug>/tracker/spec.md`, the snapshot's own spec copy — the truth layer enumerates ticket files by the same `dirname(spec)/issues/` convention — and continue with the rest of Round 0; the pull is still never re-run.
2. **Rebuild, then reconcile**: `node <this-package>/scripts/ledger.js build --runtime-dir .pi/matt-implement/<slug>` (台账再生) followed by `check` (对账); read their output — the regenerated ledger carries the full state and any ledger-truth drift item by item — then read the orchestration notes.
3. **Verify the user's new conditions against evidence**: compare the decision or claimed permission with the pending questions in notes, current ticket and git facts, and necessary validation and formal approval for the current candidate. A request to continue does not prove all findings or blockers resolved. If evidence is insufficient, check or request the missing input. Record the decision, verified conditions, and next stage in notes; continue remaining work, not reimplement, redispatch, or remerge completed tickets.
4. **Recover the interrupted stage before ordinary progress**: read the notes and referenced evidence alongside git and workflow artifacts. If an unrecorded merge is awaiting integration validation, explain that check difference and dispatch only the integration fixer needed for it (Merge and close in `run/ticket-loop.md`); leave unrelated tickets and new merges paused. Validation must pass before recording `merge` and completing the ticket. For other differences, follow the reconciliation discipline in the trunk's Ledger section. Once reconciled, continue the remaining frontier, fix loop, merges, or final gate from the verified state, not just the last recorded event.

For every unfinished old run, historical repair budgets no longer limit attempts: explain the new repair rules to the user on resume. Leave old settings, init fields, and event lines unchanged; they are readable history, not active quotas. Sealed runs are historical only — never reopen them.

(续跑 is a run-level action. A subagent's retained-context resume inside the loop is a platform mechanism — the glossary keeps the two apart.)

