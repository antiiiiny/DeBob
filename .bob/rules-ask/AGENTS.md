# AGENTS.md — Ask Mode

This file provides guidance to agents when working with code in this repository.

## Key Documentation Files

- `PROGRESS.md` — primary handoff doc; current sub-task status + complete file inventory + implementation notes
- `debob-plan.md` — full architecture plan + detailed spec for every sub-task (11 total, 6 done)
- `src/persistence/schema.ts` — SQLite schema (6 tables) with comments explaining each
- `src/graph/types.ts` — all graph type definitions with explanatory comments

## Non-Obvious Architecture Facts

**Two separate WASM stacks**: `sql.js` (WASM SQLite) for persistence, `web-tree-sitter` (WASM AST parser) for code analysis. Both chosen to avoid native compilation on Windows.

**`semantic_enrichments` table is separate from `nodes` by design** — LLM-inferred data is never mixed into the static `nodes` table. Every piece of LLM output is tagged with `llmProvider` + `modelId` for full provenance tracing.

**`file_cache` table drives incremental updates** — on a future `debob update`, any file whose `contentHash` or `lastGitCommit` differs is re-analyzed. Unchanged files are skipped.

**`src/engine/`, `src/query/`, `src/llm/providers/`, `docs/`** are intentionally empty — pending sub-tasks 7–11. Not missing, just not yet implemented.

**The CLI `bin/debob.ts` is a placeholder** — `debob init` prints a stub message. Full implementation is Sub-Task 9.

## LLM Design Constraint

The LLM never receives raw source files. The context builder (not yet implemented: `src/llm/context.ts`) assembles `ModuleContext` slices from graph queries. This is an architectural invariant, not a preference.

## IBM watsonx Provider

V1 LLM provider is IBM watsonx REST API. Credentials come from env vars only: `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT`. Implementation is pending (Sub-Task 10).
