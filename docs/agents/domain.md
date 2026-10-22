# Domain Docs

This repo uses one root [GLOSSARY.md](../../GLOSSARY.md) and [docs/adr/](../adr/).

## Before exploring

- Read `GLOSSARY.md` for domain vocabulary. If a repo has `GLOSSARY-MAP.md` instead,
  follow it to the glossaries relevant to the topic.
- Read ADRs that touch the area you are changing. Follow any later-decision pointers
  to determine which rules still apply.
- For this orchestrator's operating steps, configuration, and evidence cleanup,
  read the relevant sections of [SKILL.md](../../SKILL.md).

If a glossary or ADR directory is absent, proceed silently. `/domain-modeling` creates
these files when a term or decision needs recording, not as empty setup artifacts.

## Use the glossary's vocabulary

Use defined terms in issues, proposals, tests, and explanations. If a needed term is
missing or conflicts with the implementation, resolve it with `/domain-modeling`.
Keep the glossary for short domain definitions, not commands or implementation rules.

## Flag ADR conflicts

If a proposal contradicts an effective ADR, name the decision and explain why it
should be reconsidered instead of silently overriding it.
