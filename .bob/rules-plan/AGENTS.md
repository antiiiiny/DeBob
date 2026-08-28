# AGENTS.md — Plan Mode

This file provides guidance to agents when working with code in this repository.

## Implementation Sequence (Non-Obvious)

Sub-tasks 7–11 must follow this order — dependencies are real, not advisory:
```
7 Graph Builder      → depends on scanner (4), analyzer (5), git (6)
8 Engine             → depends on persistence (3), scanner (4), analyzer (5), git (6), builder (7)
9 CLI               → depends on engine (8)
10 LLM Layer        → depends on persistence (3), graph types (2), query (sub-part of 10)
11 Docs             → depends on all
```

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
