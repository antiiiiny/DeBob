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
| AST parsing | `web-tree-sitter` + `tree-sitter-wasms` (WASM grammars) |
| Git | `simple-git` |
| CLI | `commander` |
| LLM (V1) | IBM watsonx REST API (provider-agnostic adapter) |

> **Why WASM?** `better-sqlite3` and native `tree-sitter` both require Visual Studio / node-gyp
> to build on Windows. The WASM alternatives work without any native compilation.

---

## Current Sub-Task Status

| # | Sub-task | Status |
|---|---|---|
| 1 | Project Scaffold | ✅ done |
| 2 | Shared Types | ✅ done |
| 3 | SQLite Persistence Layer | ✅ done |
| 4 | Repository Scanner | 🔄 in progress (file written, typecheck ran but was cancelled) |
| 5 | TypeScript/JS Static Analyzer | ⬜ pending |
| 6 | Git Metadata Extractor | ⬜ pending |
| 7 | Graph Builder | ⬜ pending |
| 8 | Core Engine Orchestrator | ⬜ pending |
| 9 | CLI Entry Point | ⬜ pending |
| 10 | LLM Adapter + watsonx + Context Builder | ⬜ pending |
| 11 | Architecture Documentation | ⬜ pending |

---

## Files Created So Far

```
.gitignore                          ← excludes dist/, node_modules/, .debob/, .env, etc.
.bobignore                          ← Bob AI ignore file (pre-existing)
package.json                        ← debob 0.1.0, ESM, bin: dist/bin/debob.js
tsconfig.json                       ← ES2022, moduleResolution: bundler, strict
tsup.config.ts                      ← builds bin/debob.ts + src/**
README.md                           ← quick-start docs
debob-plan.md                       ← full architecture plan with sub-task specs
PROGRESS.md                         ← this file

bin/
  debob.ts                          ← CLI scaffold (placeholder — full impl in Sub-Task 9)

src/
  types/
    index.ts                        ← central re-export of all shared types

  graph/
    types.ts                        ← NodeType, EdgeType, DataSource, Node, Edge, Graph

  analyzers/
    interface.ts                    ← LanguageAnalyzer, AnalysisResult plugin interface
    typescript/                     ← (empty — implementation in Sub-Task 5)

  persistence/
    interface.ts                    ← PersistenceAdapter, FileCacheEntry, SemanticEnrichment,
                                       GitCommit, GitFileStats, GitMetadata
    schema.ts                       ← SCHEMA_VERSION=1, all CREATE TABLE DDL + indexes
    sqlite.ts                       ← SqlitePersistenceAdapter, openDb, saveDb,
                                       writeManifest, readManifest
    index.ts                        ← re-exports

  scanner/
    types.ts                        ← ScannedFile type
    index.ts                        ← scanRepository(), summarizeByLanguage()
                                       (WRITTEN — needs typecheck verification)

  llm/
    adapter.ts                      ← LLMAdapter, LLMConfig, ModuleContext, DiffContext,
                                       QueryContext interfaces (Sub-Task 10 implements)
    providers/                      ← (empty — watsonx impl in Sub-Task 10)

  git/                              ← (empty — Sub-Task 6)
  engine/                           ← (empty — Sub-Task 8)
  query/                            ← (empty — Sub-Task 10)

docs/                               ← (empty — Sub-Task 11)
```

---

## Key Design Decisions (locked)

1. **Persistence**: `sql.js` WASM SQLite. `SqlitePersistenceAdapter` implements `PersistenceAdapter`
   interface. Engine never imports sql.js directly — always goes through the interface.

2. **Incremental updates**: `file_cache` table stores `contentHash + analyzerVersion + schemaVersion +
   lastGitCommit` per file. Future `debob update` skips files where none of these changed.

3. **LLM architecture**: `debob init` is deterministic by default. `debob init --semantic` runs LLM
   enrichment AFTER the graph is built, using targeted `ModuleContext` slices from the query layer.
   LLM outputs go into the `semantic_enrichments` table, tagged with `llmProvider` + `modelId`.

4. **Author privacy**: Git author emails are SHA-256 hashed before storage. Raw emails never written.

5. **Analyzer plugins**: `LanguageAnalyzer` interface with `language`, `extensions`, `version`,
   `analyze(filePath, source)`. V1 supports TypeScript/JavaScript only. Add Python etc. by
   implementing the interface and registering extensions — no other changes needed.

6. **Node IDs**: stable across runs. File nodes: `relativePath`. Symbol nodes: `"relativePath::SymbolName"`.
   External packages: `"pkg::packageName"`.

7. **Edge IDs**: `"${source}::${edgeType}::${target}"` — deterministic, deduplication-safe.

8. **`dataSource` field**: every Node and Edge carries `dataSource: "static" | "git" | "llm"` so
   the origin of every piece of data is always traceable. Never use `source` (collides with JS built-ins).

---

## Next Step: Complete Sub-Task 4 (Repository Scanner)

The file `src/scanner/index.ts` was written but typecheck was interrupted.

**Resume by:**
1. Running `npm run typecheck` — should pass cleanly
2. Running a quick smoke test against this repo itself:
   ```bash
   npx tsx -e "
     import { scanRepository, summarizeByLanguage } from './src/scanner/index.js'
     const files = await scanRepository('.')
     console.log(summarizeByLanguage(files))
   "
   ```
3. Marking Sub-Task 4 done in this file and in `debob-plan.md`
4. Proceeding to Sub-Task 5 (TypeScript/JS Static Analyzer)

---

## Sub-Task 5 Preview — TypeScript/JS Static Analyzer

File: `src/analyzers/typescript/index.ts`

Uses `web-tree-sitter` (already installed). Key steps:
- Initialize Parser with WASM from `node_modules/web-tree-sitter/web-tree-sitter.wasm`
- Load TypeScript grammar from `node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm`
- Load TSX grammar from `node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm`
- Walk AST for: `import_declaration`, `export_*`, `function_declaration`, `class_declaration`,
  `interface_declaration`, `extends_clause`, `implements_clause`
- Assign `layer` hints from path patterns
- The `analyze()` method is synchronous once the parser is initialized
- Initialization is async — use a static `TypeScriptAnalyzer.create()` factory

WASM file paths (confirmed present):
```
node_modules/web-tree-sitter/web-tree-sitter.wasm
node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm
node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm
```

---

## Sub-Task 6 Preview — Git Metadata Extractor

File: `src/git/index.ts`

Uses `simple-git` (already installed). Key steps:
- `simpleGit(repoRoot).checkIsRepo()` — return empty result if not a repo
- Fetch last N commits with `--name-only` to get changed files per commit
- Hash author email with `crypto.createHash('sha256').update(email).digest('hex')`
- Aggregate per-file: commitCount, unique hashed-email set (→ authorCount), latest date
- churnScore = commitCount
- Return `GitMetadata { commits, fileStats, headCommit }`

---

## Verification Protocol

After completing each sub-task:
1. Run `npm run typecheck` — must exit 0
2. Write and run a temporary smoke test (`_test_*.mjs`, ignored by git) via `npx tsx`
3. Delete the smoke test file
4. Update status in this file and in `debob-plan.md`

---

## Commands Reference

```bash
npm run typecheck      # tsc --noEmit — must always pass
npm run build          # tsup → dist/
npm run dev            # tsx bin/debob.ts (dev run)
npx tsx <file>         # run a TypeScript file directly (for smoke tests)
node dist/debob.js     # run compiled output
```

---

## Important: What NOT to do

- Do NOT add `better-sqlite3` or native `tree-sitter` — they require Visual Studio on Windows
- Do NOT store raw author emails, API keys, tokens, or `.env` values in `.debob/`
- Do NOT send full source files to the LLM — only `ModuleContext` slices from the query layer
- Do NOT add per-module JSON files to `.debob/` — SQLite only in V1
- Do NOT implement `debob review`, `debob update`, `debob explain` yet — out of scope for this plan
