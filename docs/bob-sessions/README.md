# IBM Bob Task Session Summaries

This directory holds the exported IBM Bob task session summary screenshots for the DeBob project,
as required by the IBM TechXchange 2026 hackathon submission guidelines.

Bob was the primary implementation agent for this project. The durable artefacts of that work are
committed alongside these screenshots:

- [`.bob/rules-agent/AGENTS.md`](../../.bob/rules-agent/AGENTS.md) — coding-mode rules Bob
  accumulated across sessions (the `sql.js` in-memory persistence rule, the `web-tree-sitter`
  exact-pin ABI constraint, the `import_statement` tree-sitter node-name gotcha).
- [`.bob/rules-ask/AGENTS.md`](../../.bob/rules-ask/AGENTS.md) and
  [`.bob/rules-plan/AGENTS.md`](../../.bob/rules-plan/AGENTS.md) — ask- and plan-mode guidance.
- [`.bob/skills/debob-query/SKILL.md`](../../.bob/skills/debob-query/SKILL.md) — a skill that lets
  Bob answer architecture questions by querying the DeBob knowledge graph instead of reading
  source files.
- [`.bob/skills/debob-enrich/SKILL.md`](../../.bob/skills/debob-enrich/SKILL.md) — a skill that
  lets Bob perform semantic enrichment of the graph with no API key required.

## Screenshots

| File | Team member | Sessions covered |
|---|---|---|
| _(add rows as screenshots land)_ | | |

Naming convention: `bob-session-<member>-<n>.png`

> **Note:** Only screenshots are committed here. Raw Bob session logs live in `bob_sessions/`,
> which is deliberately gitignored — `.bobignore` exists precisely to keep credential-shaped
> strings out of session history, and raw logs are not re-published here.
