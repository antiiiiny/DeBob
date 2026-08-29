# AGENTS.md — Plan Mode

This file provides guidance to agents when working with code in this repository.

## Implementation Sequence

All original sub-tasks 1–11 are **complete**. Sub-tasks A–E from `debob-next-plan.md` are also **all complete**:
```
A  runUpdate + debob update CLI     → complete
B  Layer propagation                → complete
C  Bob skill (debob-query)          → complete
D  debob review                     → complete
E  Rules/AGENTS.md cleanup          → complete
```

See `debob-impl-plan.md` for status and specs.

## DeBob Graph Query Skill

**`.bob/skills/debob-query/SKILL.md`** teaches Bob how to query `.debob/context.db` to answer
architecture questions without reading source files. Activate it when planning graph-related work.

## Architectural Constraints That Affect Design Decisions

**Persistence abstraction is a hard boundary** — the engine depends only on `PersistenceAdapter` interface, never on `sql.js` directly. Any new storage layer must implement that interface.

**`LanguageAnalyzer` is a plugin interface** — new language support (Python, Rust, Go) is added by implementing `LanguageAnalyzer` and registering extensions. No changes to the engine are required.

**`semantic_enrichments` is architecturally isolated** — LLM outputs live in this table, not in `nodes`. `confidence < 1.0` + `dataSource: "llm"` on all LLM-derived Node/Edge values. Never mix static and LLM facts in the same row.

**`Graph.nodes` is `Map<string, Node>`, not `Node[]`** — O(1) node lookup by id. Edges remain a flat `Edge[]` (deduped by edge id string).

**Hot file threshold** — top 10% by `churnScore` (= raw commit count in V1) are marked `metadata.hot = true` by the Graph Builder. Used by the context builder to prioritize which modules get LLM enrichment.

## sql.js In-Memory Model

sql.js holds the entire database in memory and exports to a `Uint8Array` on `close()`. For large repos, memory usage scales with graph size. This is a known V1 trade-off; the `PersistenceAdapter` abstraction allows swapping to a different backend later.

## Schema Version Migration Strategy

`SCHEMA_VERSION` in `src/persistence/schema.ts` is compared against the value stored in `manifest.json`. If they differ, a full re-analysis is triggered. No rollback — forward-only migrations only.
