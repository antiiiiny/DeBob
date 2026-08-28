# DeBob — Implementation Progress

> This file is the handoff document for a new chat session.
> Read this + `debob-plan.md` before touching any code.

---

## What DeBob Is

A persistent repository-understanding and context system for AI coding agents.

```
Repository
  → deterministic analysis
  → persistent graph (.debob/context.db)
  → targeted context retrieval
  → LLM semantic reasoning (optional, --semantic flag)
```

The LLM **never receives the full repository**. The graph + query layer assembles a targeted
`ModuleContext` slice (imports, exports, declarations, git stats) and sends only that.

---

## Technology Stack

| Concern | Choice |
|---|---|
| Language | TypeScript + Node.js (ESM) |
| Build | `tsup` → `dist/` |
| Dev runner | `tsx` |
| SQLite | `sql.js` (WASM — no native build needed) |
| AST parsing | `web-tree-sitter@0.22.6` + `tree-sitter-wasms@0.1.13` (WASM) |
| Git | `simple-git` |
| CLI | `commander` |
| Ignore rules | `ignore@^5.3.2` (gitignore-spec parser — used by scanner) |
| LLM (V1) | IBM watsonx REST API (provider-agnostic adapter) |

> **Why WASM?** `better-sqlite3` and native `tree-sitter` both require Visual Studio / node-gyp
> to build on Windows. The WASM alternatives work without any native compilation.
>
> **Version pin**: `web-tree-sitter` is pinned to `0.22.6` (NOT `^0.26.x`).
> `tree-sitter-wasms@0.1.13` was built with tree-sitter-cli@0.20.x (ABI 14).
> `web-tree-sitter@0.26.x` uses ABI 15 — incompatible. Always keep `"web-tree-sitter": "0.22.6"` exact in package.json.

---

## Current Sub-Task Status

| # | Sub-task | Status |
|---|---|---|
| 1 | Project Scaffold | ✅ done |
| 2 | Shared Types | ✅ done |
| 3 | SQLite Persistence Layer | ✅ done |
| 4 | Repository Scanner | ✅ done (+ hardening: gitignore, size cap, extension allowlist) |
| 5 | TypeScript/JS Static Analyzer | ✅ done |
| 6 | Git Metadata Extractor | ✅ done |
| 7 | Graph Builder | ✅ done |
| 8 | Core Engine Orchestrator | ✅ done |
| 9 | CLI Entry Point | ✅ done |
| 10 | LLM Adapter + watsonx + Context Builder | ✅ done |
| 11 | Architecture Documentation | ⬜ pending — **NEXT** |

---

## Complete File Inventory

```
.gitignore                          ← dist/, node_modules/, .debob/, .env, bob_sessions/,
                                       _test_*.mjs, _test_*.ts, _scratch_*.mjs
.debobignore                        ← user-facing debob-specific ignore file (gitignore syntax)
package.json                        ← debob 0.1.0, ESM, bin: dist/bin/debob.js
                                       web-tree-sitter pinned to EXACT "0.22.6"
                                       ignore@^5.3.2 added for scanner gitignore support
tsconfig.json                       ← ES2022, moduleResolution: bundler, strict
tsup.config.ts                      ← entry: bin/debob.ts + src/**, format: esm
README.md                           ← quick-start, commands, watsonx env vars
debob-plan.md                       ← full architecture plan + all sub-task specs
scanner-hardening-plan.md           ← completed plan: gitignore respect + binary/huge-file guards
PROGRESS.md                         ← this file

bin/
  debob.ts                          ← Full CLI: commander + chalk + ora, init/review commands,
                                       --repo/--max-commits/--semantic/--verbose options,
                                       rich summary output, error handling, exit codes

src/
  types/
    index.ts                        ← central re-export barrel for all shared types

  graph/
    types.ts                        ← NodeType, EdgeType, DataSource, ArchitecturalLayer,
                                       Node, Edge, Graph
    builder.ts                      ← buildGraph(files, analysisResults, gitMetadata): Graph
                                       merges scanner + analyzer + git → unified deduplicated Graph
                                       attaches churnScore/authorCount/contentHash to file nodes
                                       marks top-10% churn file nodes hot, stubs missing edge endpoints

  analyzers/
    interface.ts                    ← LanguageAnalyzer, AnalysisResult plugin interface
    typescript/
      index.ts                      ← TypeScriptAnalyzer (web-tree-sitter WASM)
                                       IMPORTANT: uses 'import_statement' node type
                                       (NOT 'import_declaration' — tree-sitter grammar quirk)

  git/
    index.ts                        ← extractGitMetadata(), GitCommit, GitFileStats, GitMetadata
                                       SHA-256 hashes author emails; returns gracefully if not a repo

  persistence/
    interface.ts                    ← PersistenceAdapter interface, FileCacheEntry,
                                       SemanticEnrichment, GitCommit, GitFileStats, GitMetadata
    schema.ts                       ← SCHEMA_VERSION=1, CREATE TABLE DDL for 6 tables + indexes
    sqlite.ts                       ← SqlitePersistenceAdapter, openDb, saveDb,
                                       writeManifest, readManifest
    index.ts                        ← re-exports SCHEMA_VERSION, PersistenceAdapter,
                                       SqlitePersistenceAdapter, openDb, writeManifest, readManifest

  scanner/
    types.ts                        ← ScannedFile interface
    index.ts                        ← scanRepository(), summarizeByLanguage(), ScanOptions
                                       DEFAULT_IGNORE globs, TEXT_EXTENSIONS allowlist,
                                       MAX_FILE_BYTES (1 MB) cap, .gitignore/.debobignore filter

  llm/
    adapter.ts                      ← LLMAdapter interface + full JSDoc (ModuleContext, DiffContext,
                                       QueryContext, LLMConfig)
    index.ts                        ← createLLMAdapter(provider, config): LLMAdapter factory
                                       wires "watsonx" → WatsonxAdapter; exports WatsonxAdapter
    context.ts                      ← buildModuleContext(node, graph, gitStats?): ModuleContext
                                       assembles graph-derived context slice for the LLM
    providers/
      watsonx.ts                    ← WatsonxAdapter: summarizeModule, classifyLayer (REST),
                                       explainDiff/answerQuestion stubs; prompt builders (no raw source)

  engine/
    index.ts                        ← runInit(repoRoot, options): Promise<InitResult>
                                       InitOptions, InitResult types; analyzer registry (ext→analyzer Map)
                                       pipeline: scan → analyze → git → buildGraph → persist → semantic? → manifest

  query/
    index.ts                        ← getNodeEdges, getFileImports, getFileExports, getNodeNeighbours
                                       buildModuleContext re-exported here for engine compatibility

docs/                               ← (empty — Sub-Task 11)
```

---

## Key Implementation Notes

### Scanner Exclusion Behaviour
- Files are excluded by **four layered guards** in cheapest-first order:
  1. `DEFAULT_IGNORE` + `extraIgnore` glob patterns — applied by `glob` before any file I/O
  2. `.gitignore` / `.debobignore` post-filter — via `ignore` package (`respectGitignore: true` by default)
  3. `TEXT_EXTENSIONS` allowlist — extension not in set → skip (no `statSync` call)
  4. `MAX_FILE_BYTES` (1 MB) size cap — checked after `statSync`, before `readFileSync`
- To disable gitignore filtering in tests: `scanRepository(root, { respectGitignore: false })`
- `.debobignore` uses standard gitignore syntax; ship it empty, users add project-specific rules

### WASM ABI Compatibility (CRITICAL)
- `web-tree-sitter` MUST stay at `"0.22.6"` (exact, no caret)
- `tree-sitter-wasms@0.1.13` was built with ABI 14; `web-tree-sitter@0.26.x` uses ABI 15
- WASM file names in 0.22.x: `tree-sitter.wasm` (NOT `web-tree-sitter.wasm`)
- Grammar WASM files: `node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm`
- `Parser.Language.load(path)` — Language is a nested namespace under Parser (not a separate export)

### tree-sitter Grammar Node Names (CRITICAL)
- Import statements: **`import_statement`** (NOT `import_declaration`)
- Export statements: `export_statement` (correct)
- Class: `class_declaration`, `class_heritage`, `extends_clause`, `implements_clause`
- Interface: `interface_declaration`, `extends_type_clause`
- Function: `function_declaration`

### sql.js Persistence Pattern
- `sql.js` is in-memory; changes are NOT auto-saved to disk
- Always call `adapter.close()` (or `saveDb(db, dbPath)`) after mutations
- `openDb(repoRoot)` loads existing db from file if present, creates new if not
- `SqlitePersistenceAdapter` saves to disk on `close()`

### Graph Node/Edge ID Conventions
- File node id: `relativePath` (e.g. `src/services/auth.ts`)
- Symbol node id: `"relativePath::SymbolName"` (e.g. `src/services/auth.ts::AuthService`)
- Package node id: `"pkg::packageName"` (e.g. `pkg::express`)
- Edge id: `"${sourceId}::${edgeType}::${targetId}"` — deterministic, dedup-safe

### PersistenceAdapter API
The engine NEVER imports `sql.js` directly. Always use `PersistenceAdapter`:
```ts
const { db, dbPath } = await openDb(repoRoot)
const adapter = new SqlitePersistenceAdapter(db, dbPath)
// ... mutations ...
adapter.close() // saves to disk
```

---

## Sub-Task 11 Preview — Architecture Documentation (NEXT)

Files: `docs/architecture.md` (new), `README.md` (update)

Write the canonical reference document covering all components, the graph model, DB schema,
incremental update design, LLM architecture, and extension guides.

---

## Verification Protocol

After each sub-task:
1. `npm run typecheck` — must exit 0 with zero errors
2. Write `_test_<n>.mjs`, run with `npx tsx _test_<n>.mjs`, delete after passing
3. Update status table in this file and corresponding status in `debob-plan.md`

---

## Commands Reference

```bash
npm run typecheck      # tsc --noEmit — must always pass
npm run build          # tsup → dist/
npm run dev            # tsx bin/debob.ts (dev run)
npx tsx <file.mjs>     # run a TypeScript/JS file directly
node dist/debob.js     # run compiled output
```

---

## Important: What NOT to do

- Do NOT change `web-tree-sitter` version away from `"0.22.6"` (exact pin, no caret)
- Do NOT add `better-sqlite3` or native `tree-sitter` — require Visual Studio on Windows
- Do NOT store raw author emails, API keys, tokens, or `.env` values in `.debob/`
- Do NOT send full source files to the LLM — only `ModuleContext` slices from query layer
- Do NOT add per-module JSON files to `.debob/` — SQLite only in V1
- Do NOT implement `debob review`, `debob update`, `debob explain` yet — out of scope
- Do NOT call `adapter.close()` forget — sql.js won't persist without it
