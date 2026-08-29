# AGENTS.md — Agent (Coding) Mode

This file provides guidance to agents when working with code in this repository.

## Before Writing Any Code

- Run `npm run typecheck` and confirm it passes. All sub-tasks must leave typecheck green.
- Read `PROGRESS.md` to see which sub-tasks are done and what's next.
- `debob-impl-plan.md` tracks the active A–E sub-tasks. `debob-next-plan.md` has the full specs.
- Use `.bob/skills/debob-query/SKILL.md` to query the knowledge graph from chat when needed.

## Non-Obvious Coding Rules

**sql.js is in-memory only** — always call `adapter.close()` after mutations or the db is not saved.

**web-tree-sitter@0.22.6 is an exact pin** — do not change the version or add `^`. ABI mismatch will silently break the analyzer at runtime.

**tree-sitter import node name is `import_statement`**, not `import_declaration`. Using the wrong name produces no errors but extracts nothing.

**Engine must never import `sql.js` directly** — always go through `PersistenceAdapter` interface. The engine in `src/engine/index.ts` constructs `SqlitePersistenceAdapter` via `openDb()` and calls `adapter.close()` at the end.

**`TypeScriptAnalyzer` requires async factory** — use `await TypeScriptAnalyzer.create(repoRoot)`, not `new TypeScriptAnalyzer(...)`. Constructor is private.

**WASM path resolution on Windows**: `getSql()` in `src/persistence/sqlite.ts` strips the leading `/` from Windows drive paths via `.replace(/^\/([A-Z]:)/, '$1')`. Apply the same pattern for any new WASM path resolution.

**Analyzer version string format**: `"{language}-{major}.{minor}"` (e.g. `"ts-1.0"`). Stored in `file_cache`; changing it triggers re-analysis of all cached files.

## Ad-hoc Testing Pattern

Write `_test_<n>.mjs` at repo root, run with `npx tsx _test_<n>.mjs`, delete after passing. These files are gitignored. Do not introduce a test framework without discussion.

## Forbidden

- Do NOT add `better-sqlite3` or native `tree-sitter` (Windows incompatibility)
- Do NOT store raw emails, API keys, or secrets in `.debob/`
- Do NOT send full source file contents to the LLM — only `ModuleContext` slices
- Do NOT implement `debob review`, `debob update`, or `debob explain` yet
