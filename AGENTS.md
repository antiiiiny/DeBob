# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## What This Is

DeBob is a persistent repository-understanding and context system for AI coding agents. It scans a repo, builds a typed graph (nodes + edges) in SQLite, and exposes targeted context slices for LLM semantic enrichment.

## Commands

```bash
npm run typecheck      # tsc --noEmit — must always pass before committing
npm run build          # tsup → dist/
npm run dev            # tsx bin/debob.ts (dev CLI run)
npx tsx <file.mjs>     # run ad-hoc TypeScript/JS test scripts
```

No test framework is configured yet. Verification is done by writing `_test_<n>.mjs` files, running with `npx tsx`, then deleting. These files are gitignored (`_test_*.mjs`, `_test_*.ts`).

## Critical Dependency Constraints

- **`web-tree-sitter` is pinned to exact `"0.22.6"` — never change it to a caret range or upgrade.**
  `tree-sitter-wasms@0.1.13` uses ABI 14; `web-tree-sitter@0.26.x` uses ABI 15 — incompatible.
- Do NOT add `better-sqlite3` or native `tree-sitter` — they require Visual Studio / node-gyp on Windows. The project uses WASM alternatives (`sql.js`, `web-tree-sitter`) intentionally.

## tree-sitter Grammar Node Names

The TypeScript grammar uses **`import_statement`** (NOT `import_declaration`). Other key names: `export_statement`, `class_declaration`, `class_heritage`, `extends_clause`, `implements_clause`, `interface_declaration`, `extends_type_clause`, `function_declaration`.

## sql.js Persistence Pattern

`sql.js` is in-memory only. **Always call `adapter.close()` after mutations** — without it, nothing is written to disk. Pattern:
```ts
const { db, dbPath } = await openDb(repoRoot)
const adapter = new SqlitePersistenceAdapter(db, dbPath)
// mutations...
adapter.close() // saves to disk
```

## ID Conventions

- File node: `relativePath` (e.g. `src/graph/types.ts`)
- Symbol node: `"relativePath::SymbolName"` (e.g. `src/graph/types.ts::Node`)
- Package node: `"pkg::packageName"` (e.g. `pkg::express`)
- Edge id: `"${sourceId}::${edgeType}::${targetId}"` — deterministic, dedup-safe

## LLM Architecture Constraint

The LLM **never receives raw source files**. The context builder assembles `ModuleContext` slices (imports, exports, declarations, git stats) from graph queries — only those slices go to the LLM. Enforce this in all engine code.

## Privacy Rule

Author emails are SHA-256 hashed before storage. Raw emails, API keys, tokens, and `.env` values are **never** written to `.debob/`.

## What Is NOT Implemented Yet (Sub-Tasks 7–11)

- `src/graph/builder.ts` — Graph Builder (next up)
- `src/engine/index.ts` — Core Engine Orchestrator
- `src/query/index.ts` — Graph Query Helpers
- `src/llm/context.ts`, `src/llm/index.ts`, `src/llm/providers/watsonx.ts`
- Full `bin/debob.ts` CLI (current file is a placeholder)
- `docs/architecture.md`

See `PROGRESS.md` for status and `debob-plan.md` for full specs of each sub-task.

## Code Style

- Strict TypeScript ESM (`"type": "module"`); all imports use `.js` extensions
- `NodeType`/`EdgeType` are string unions, not enums — extensible without breaking changes
- `dataSource` (not `source`) on Node/Edge to avoid collision with built-in property names
- Static analysis outputs always carry `confidence: 1.0`, `dataSource: "static"`; LLM outputs use `confidence < 1.0`, `dataSource: "llm"`, stored separately in `semantic_enrichments` table
- Section dividers use `// ─── Section Name ───...` comment style
