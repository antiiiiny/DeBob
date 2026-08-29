# AGENTS.md — Ask Mode

This file provides guidance to agents when working with code in this repository.

## Key Documentation Files

- `PROGRESS.md` — primary handoff doc; current sub-task status + complete file inventory + implementation notes
- `debob-plan.md` — original architecture plan (sub-tasks 1–11, all complete)
- `debob-next-plan.md` — next-phase spec (sub-tasks A–E)
- `debob-impl-plan.md` — implementation plan tracking A–E progress
- `src/persistence/schema.ts` — SQLite schema (6 tables) with comments explaining each
- `src/graph/types.ts` — all graph type definitions with explanatory comments

## DeBob Graph Query Skill

**Use `.bob/skills/debob-query/SKILL.md`** to query the knowledge graph from chat.
Activate this skill when answering architecture, dependency, or file-responsibility questions.

## Non-Obvious Architecture Facts

**Two separate WASM stacks**: `sql.js` (WASM SQLite) for persistence, `web-tree-sitter` (WASM AST parser) for code analysis. Both chosen to avoid native compilation on Windows.

**`semantic_enrichments` table is separate from `nodes` by design** — LLM-inferred data is never mixed into the static `nodes` table. Every piece of LLM output is tagged with `llmProvider` + `modelId` for full provenance tracing.

**`file_cache` table drives incremental updates** — `debob update` re-analyzes only files whose `contentHash`, `analyzerVersion`, or `schemaVersion` has changed. Unchanged files are skipped.

**All sub-tasks 1–11 are complete.** Sub-tasks A–E from `debob-next-plan.md` extend the system.

**The CLI `bin/debob.ts`** implements: `init`, `update`, `visualise`, and `review` (all complete — no stubs remaining).

## LLM Design Constraint

The LLM never receives raw source files. `buildModuleContext()` in `src/query/index.ts` assembles `ModuleContext` slices from graph queries. This is an architectural invariant, not a preference.

## IBM watsonx Provider

LLM provider is IBM watsonx.ai SDK (`@ibm-cloud/watsonx-ai`). Class: `WatsonxProvider`.
Credentials: `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL` (not `WATSONX_ENDPOINT`), `WATSONX_MODEL_ID`.
