# DeBob — Bootstrap & Architecture Plan

## Overview

DeBob is a persistent repository-understanding and context system for AI coding agents.

> Git remembers what changed. DeBob remembers what the codebase means.

This plan covers the complete bootstrap from an empty repository to a working `debob init` foundation that:
- Scans any Git repository
- Extracts deterministic structure (files, imports, exports, function/class definitions, dependencies)
- Extracts Git metadata (commits, authors, change frequency, blame)
- Builds a typed graph of nodes and edges
- Persists everything to `.debob/context.db` (SQLite)
- Prints a human-readable discovery summary
- Exposes clear interfaces for future LLM semantic analysis and the `debob review` command

**Out of scope for this plan:** LLM semantic analysis implementation, `debob review`, `debob explain`, `debob impact`, `debob why`, `debob onboard`, incremental `debob update`.

---

## Technology Stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (Node.js) | Strong CLI, tree-sitter, LLM SDK ecosystem |
| Package manager | npm | Universal, no extra tooling |
| CLI framework | `commander` | Minimal, widely used |
| Git integration | `simple-git` | Async, well-typed Node.js wrapper |
| AST parsing | `tree-sitter` + `tree-sitter-typescript` | Extensible to any language grammar |
| Persistence | `better-sqlite3` | Synchronous, embedded, queryable, single-file |
| LLM adapter | Custom interface + IBM watsonx first | Provider-agnostic design |
| Build | `tsup` | Fast ESM/CJS dual build |
| Runtime binary | `tsx` for dev, compiled dist for npx | Allows `npx debob` without global install |

---

## Repository Layout

```
debob/                          ← this repo
├── bin/
│   └── debob.ts                ← CLI entry point (shebang, commander setup)
├── src/
│   ├── engine/
│   │   └── index.ts            ← Core Engine orchestrator
│   ├── scanner/
│   │   └── index.ts            ← Repository file scanner
│   ├── analyzers/
│   │   ├── interface.ts        ← Analyzer plugin interface
│   │   └── typescript/
│   │       └── index.ts        ← TS/JS static analyzer (tree-sitter)
│   ├── git/
│   │   └── index.ts            ← Git metadata extractor
│   ├── graph/
│   │   ├── types.ts            ← Node, Edge, Graph type definitions
│   │   └── builder.ts          ← Graph construction from analysis results
│   ├── persistence/
│   │   ├── schema.ts           ← SQLite schema definition and migrations
│   │   └── index.ts            ← Read/write operations on context.db
│   ├── query/
│   │   └── index.ts            ← Query helpers over the persisted graph
│   ├── llm/
│   │   ├── adapter.ts          ← LLMAdapter interface (not yet called)
│   │   └── providers/
│   │       └── watsonx.ts      ← IBM watsonx stub (wired but not invoked in init)
│   └── types/
│       └── index.ts            ← Shared types used across packages
├── docs/
│   └── architecture.md         ← Human-readable architecture documentation
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

---

## `.debob/` Directory Structure

```
.debob/
├── context.db          ← SQLite database (all graph data, git metadata, semantics)
└── manifest.json       ← Lightweight metadata: debob version, init timestamp, repo root, language
```

`context.db` contains the following tables:

| Table | Contents |
|---|---|
| `nodes` | Every graph node (file, module, function, class, variable, route) |
| `edges` | Typed relationships between nodes |
| `git_commits` | Commit hash, author, date, message, files changed |
| `git_file_stats` | Per-file: commit count, last modified, authors, churn score |
| `manifest` | Single-row: version, init time, repo path |

---

## Graph Model

### Node

```ts
interface Node {
  id: string            // canonical: relative file path, or "file::symbol"
  type: NodeType        // "file" | "module" | "function" | "class" | "variable" | "route" | "package"
  name: string
  filePath: string
  startLine?: number
  endLine?: number
  layer?: string        // "presentation" | "business" | "data" | "config" | "test" | "infra"
  responsibility?: string  // LLM-populated later
  confidence: number    // 1.0 = deterministic; < 1.0 = LLM inference
  source: "static" | "git" | "llm"
  metadata?: Record<string, unknown>
}
```

### Edge

```ts
interface Edge {
  id: string            // auto-generated
  source: string        // node id
  target: string        // node id
  type: EdgeType
  confidence: number
  source_type: "static" | "git" | "llm"
  metadata?: Record<string, unknown>
}
```

### EdgeType

Supported from the start, extensible by adding new values:

```
imports | exports | calls | depends_on | extends | implements |
instantiates | exposes | handles | tests | reads_from | writes_to |
communicates_with | configured_by | related_to
```

---

## Analyzer Plugin Interface

Each language analyzer implements:

```ts
interface LanguageAnalyzer {
  language: string                          // e.g. "typescript"
  extensions: string[]                      // e.g. [".ts", ".tsx", ".js", ".jsx"]
  analyze(filePath: string, source: string): AnalysisResult
}

interface AnalysisResult {
  nodes: Node[]
  edges: Edge[]
}
```

The engine discovers which analyzer to use based on file extension. New languages are added by implementing `LanguageAnalyzer` and registering it.

---

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold

**Status:** `[ ] pending`

**Intent:**
Establish the TypeScript project with all dependencies, build configuration, and directory structure. This is the foundation every other sub-task builds on.

**Expected Outcomes:**
- `package.json` with all required dependencies and `bin` entry
- `tsconfig.json` configured for Node.js ESM output
- `tsup.config.ts` for building
- Directory skeleton created
- `npm install` succeeds

**Todo List:**
1. Create `package.json` with name `debob`, version `0.1.0`, type `module`, bin entry pointing to `dist/bin/debob.js`
2. Add runtime dependencies: `commander`, `simple-git`, `better-sqlite3`, `tree-sitter`, `tree-sitter-typescript`, `chalk`, `ora`, `glob`
3. Add dev dependencies: `typescript`, `tsup`, `tsx`, `@types/node`, `@types/better-sqlite3`
4. Create `tsconfig.json` targeting ES2022, module resolution `bundler`, strict mode on
5. Create `tsup.config.ts` building `bin/debob.ts` and `src/**` to `dist/`
6. Create all empty directory placeholders (`src/engine`, `src/scanner`, `src/analyzers/typescript`, `src/git`, `src/graph`, `src/persistence`, `src/query`, `src/llm/providers`, `src/types`, `docs`)
7. Add `npm run build`, `npm run dev`, `npm run typecheck` scripts
8. Create a minimal `README.md`

**Relevant Context:**
- Entry point: `bin/debob.ts`
- Build output: `dist/`
- npx invocation: `npx debob init`

---

### Sub-Task 2 — Shared Types

**Status:** `[ ] pending`

**Intent:**
Define all shared TypeScript types used across the system. Establishing types first ensures all subsequent sub-tasks have a consistent, compile-checked contract.

**Expected Outcomes:**
- `src/types/index.ts` — all graph types exported
- `src/graph/types.ts` — NodeType, EdgeType enums/unions
- All types compile cleanly

**Todo List:**
1. Define `NodeType` union in `src/graph/types.ts`
2. Define `EdgeType` union in `src/graph/types.ts`
3. Define `Node` interface in `src/graph/types.ts`
4. Define `Edge` interface in `src/graph/types.ts`
5. Define `Graph` interface (nodes map + edges array) in `src/graph/types.ts`
6. Define `AnalysisResult` interface in `src/analyzers/interface.ts`
7. Define `LanguageAnalyzer` interface in `src/analyzers/interface.ts`
8. Define `GitFileStats`, `GitCommit` interfaces in `src/git/index.ts`
9. Re-export everything from `src/types/index.ts`

**Relevant Context:**
- Graph model described above
- `confidence` and `source` fields are critical — they distinguish deterministic from LLM-inferred data
- EdgeType must be extensible (use a string union, not an enum, to allow future values without breaking)

---

### Sub-Task 3 — SQLite Persistence Layer

**Status:** `[ ] pending`

**Intent:**
Implement the `.debob/` directory management and SQLite schema. This layer is the single source of truth for all extracted knowledge.

**Expected Outcomes:**
- `src/persistence/schema.ts` contains table definitions
- `src/persistence/index.ts` exposes `openDb`, `saveGraph`, `saveGitStats`, `saveGitCommits`, `readGraph`, `readManifest`, `writeManifest`
- Running `openDb(repoPath)` creates `.debob/` and initializes the schema if it does not exist
- `manifest.json` written alongside `context.db`

**Todo List:**
1. Implement `openDb(repoPath: string): Database` in `src/persistence/index.ts` — creates `.debob/` dir, opens `context.db`, runs migrations
2. Define `CREATE TABLE IF NOT EXISTS` statements for `nodes`, `edges`, `git_commits`, `git_file_stats`, `manifest` in `src/persistence/schema.ts`
3. Implement `saveNodes(db, nodes[])` — upsert by node id
4. Implement `saveEdges(db, edges[])` — upsert by edge id
5. Implement `saveGitCommits(db, commits[])` — upsert by hash
6. Implement `saveGitFileStats(db, stats[])` — upsert by filePath
7. Implement `readGraph(db): Graph` — reconstruct Node/Edge arrays from db
8. Implement `writeManifest(repoPath, data)` — writes `.debob/manifest.json`
9. Implement `readManifest(repoPath)` — reads `.debob/manifest.json`

**Relevant Context:**
- Use `better-sqlite3` (synchronous API — no async/await needed)
- `.debob/` must be created inside the target repo root, not inside the debob project itself
- Schema version field in `manifest` table allows future migrations
- Node `id` must be stable across runs (use relative file path, or `relativePath::symbolName`)

---

### Sub-Task 4 — Repository Scanner

**Status:** `[ ] pending`

**Intent:**
Implement the file system scanner that discovers all relevant source files in a repository. This is the first step of `debob init`.

**Expected Outcomes:**
- `src/scanner/index.ts` exports `scanRepository(repoRoot: string): ScannedFile[]`
- Returns a list of files with path, extension, size, and language hint
- Respects `.gitignore` (skip ignored files)
- Skips `node_modules`, `.git`, `.debob`, `dist`, `build`, `coverage`, and other non-source directories by default
- Correctly identifies TypeScript/JavaScript files for the analyzer

**Todo List:**
1. Implement `scanRepository(repoRoot)` using `glob` to find all files recursively
2. Apply exclusion patterns: `node_modules`, `.git`, `.debob`, `dist`, `build`, `coverage`, `*.min.js`, `*.map`
3. Detect language from extension: `.ts`/`.tsx` → `typescript`, `.js`/`.jsx`/`.mjs`/`.cjs` → `javascript`
4. Return `ScannedFile[]` with `{ path, relativePath, extension, language, sizeBytes }`
5. Log count of files found per language
6. Add `ScannedFile` type to shared types

**Relevant Context:**
- The scanner should work against any target repository, not just the debob repo itself
- `repoRoot` is passed in from the CLI (defaults to `process.cwd()`)
- Use `glob` package's `ignore` option to skip excluded paths

---

### Sub-Task 5 — TypeScript/JavaScript Static Analyzer

**Status:** `[ ] pending`

**Intent:**
Implement the first `LanguageAnalyzer` plugin for TypeScript and JavaScript using tree-sitter. Extracts nodes (files, functions, classes) and edges (imports, exports, calls) deterministically from source code.

**Expected Outcomes:**
- `src/analyzers/typescript/index.ts` exports a `TypeScriptAnalyzer` implementing `LanguageAnalyzer`
- For each file, produces: one `file` node, N `function`/`class` nodes, import edges, export edges
- All produced nodes/edges have `confidence: 1.0` and `source: "static"`
- `src/analyzers/interface.ts` defines the `LanguageAnalyzer` interface

**Todo List:**
1. Implement `LanguageAnalyzer` interface in `src/analyzers/interface.ts`
2. Initialize tree-sitter parser with TypeScript grammar in `TypeScriptAnalyzer`
3. Parse each file and walk the AST to extract:
   - `import_declaration` nodes → `imports` edges (source: current file, target: resolved module specifier)
   - `export_declaration` nodes → `exports` edges
   - `function_declaration` / `method_definition` / `arrow_function` assigned to variable → `function` nodes
   - `class_declaration` → `class` nodes
   - `extends_clause` → `extends` edges
   - `implements_clause` → `implements` edges
4. Resolve relative import paths to canonical relative paths within the repo
5. Mark external package imports (e.g. `"react"`, `"express"`) as `package` nodes with `source: "static"`
6. Assign a `layer` hint based on path patterns: `test`/`spec` → "test", `routes`/`controllers` → "presentation", `services` → "business", `models`/`schema` → "data", `config` → "config"
7. Return `AnalysisResult` with all nodes and edges

**Relevant Context:**
- tree-sitter operates synchronously on a string of source text
- `tree-sitter-typescript` exports both a TypeScript and TSX grammar
- Keep the AST walker focused — don't try to resolve all call expressions in v1 (too complex without type info); focus on imports and declarations
- Edge `id` should be `${source}::${type}::${target}` for deduplication

---

### Sub-Task 6 — Git Metadata Extractor

**Status:** `[ ] pending`

**Intent:**
Extract useful Git metadata from the repository: recent commits, per-file change frequency (churn), authors, and last-modified timestamps. This makes Git a first-class data source in the graph.

**Expected Outcomes:**
- `src/git/index.ts` exports `extractGitMetadata(repoRoot): GitMetadata`
- Returns recent commits (last 500 by default) and per-file stats
- Per-file stats include: commit count, unique authors, last modified date, churn score
- All git data stored in `git_commits` and `git_file_stats` tables

**Todo List:**
1. Initialize `simple-git` with the repo root in `extractGitMetadata`
2. Check that the directory is actually a Git repo; return empty result if not
3. Fetch last 500 commits: hash, author name, author email, date, subject
4. For each commit, fetch the list of changed files (using `--name-only`)
5. Aggregate per-file stats: total commits touching file, unique authors set, last commit date
6. Compute a `churnScore` = total commits touching the file (higher = more volatile)
7. Return `GitMetadata { commits: GitCommit[], fileStats: GitFileStats[] }`
8. Add `GitCommit` and `GitFileStats` type definitions

**Relevant Context:**
- Use `simple-git`'s `log` and `diff` APIs
- Limit to 500 commits to keep init fast; make this configurable via options later
- Do NOT read `.env` files, credential files, or any secrets — git log only
- Store author email hashed (SHA-256) in the db to avoid storing PII directly

---

### Sub-Task 7 — Graph Builder

**Status:** `[ ] pending`

**Intent:**
Combine the outputs of the scanner, static analyzer, and git extractor into a unified, consistent graph. The graph builder is responsible for deduplication, node ID normalization, and merging git signals into graph nodes.

**Expected Outcomes:**
- `src/graph/builder.ts` exports `buildGraph(scanResult, analysisResults, gitMetadata): Graph`
- Deduplicates nodes by id
- Merges git churn score and last-modified onto corresponding file nodes
- Produces a `Graph` that can be directly persisted

**Todo List:**
1. Implement `buildGraph(files, analysisResults, gitMetadata)` in `src/graph/builder.ts`
2. Start with one `file` node per scanned file (id = relative path)
3. Merge all nodes from `AnalysisResult[]` — deduplicate by id
4. Merge all edges — deduplicate by edge id
5. For each file node, look up `GitFileStats` and attach `churnScore`, `lastModified`, `authorCount` to `node.metadata`
6. Identify and mark "hot files" (churnScore in top 10%) with `metadata.hot = true`
7. Return the complete `Graph`

**Relevant Context:**
- Node ids must be stable (always relative path from repo root)
- Edges pointing to external packages (e.g. `node_modules/express`) should still be included but the target node gets `type: "package"`
- The graph intentionally does NOT include LLM-derived data at this stage — that is a future enrichment pass

---

### Sub-Task 8 — Core Engine Orchestrator

**Status:** `[ ] pending`

**Intent:**
Implement the engine that wires together scanner → analyzer → git → graph builder → persistence and drives the `debob init` workflow.

**Expected Outcomes:**
- `src/engine/index.ts` exports `runInit(repoRoot: string, options: InitOptions): Promise<InitResult>`
- Calls each subsystem in the correct order
- Reports progress at each stage
- Returns a structured `InitResult` summary

**Todo List:**
1. Implement `runInit` in `src/engine/index.ts`
2. Step 1: Validate `repoRoot` is a directory and contains `.git`
3. Step 2: Call `scanRepository` — report file count
4. Step 3: For each scanned file, run the appropriate `LanguageAnalyzer` — report analyzed file count
5. Step 4: Call `extractGitMetadata` — report commit count
6. Step 5: Call `buildGraph` — report node/edge count
7. Step 6: Call `openDb` and persist nodes, edges, git commits, git file stats
8. Step 7: Write `manifest.json` with version, timestamp, repoRoot, nodeCount, edgeCount
9. Step 8: Return `InitResult` with counts and a list of top-level discoveries (hot files, package dependencies, layer distribution)
10. Wrap each step with error handling — if a step fails, log a warning and continue where possible

**Relevant Context:**
- `InitOptions` should include: `{ maxCommits?: number, verbose?: boolean }`
- The engine owns the progress reporter — pass an `ora` spinner or a simple logger
- Keep the engine pure (no direct `console.log`) — let the CLI layer handle output

---

### Sub-Task 9 — CLI Entry Point

**Status:** `[ ] pending`

**Intent:**
Implement the `bin/debob.ts` CLI entry point using `commander`. This is the user-facing surface of DeBob.

**Expected Outcomes:**
- `npx debob init` runs successfully in any Git repository
- `npx debob init --help` shows correct help text
- Prints a rich summary after init: file counts, node/edge counts, hot files, detected layers, git stats
- Exit code 0 on success, non-zero on failure

**Todo List:**
1. Create `bin/debob.ts` with `#!/usr/bin/env node` shebang
2. Set up `commander` program with name `debob`, version from `package.json`, description
3. Add `init` command with options: `--repo <path>` (default: cwd), `--max-commits <n>` (default: 500), `--verbose`
4. In the `init` action: call `runInit`, render the summary using `chalk` (colored output)
5. Summary output should include:
   - Files scanned (by language)
   - Nodes in graph (by type)
   - Edges in graph (by type)
   - Git: total commits analyzed, top 5 hottest files
   - Detected architectural layers
   - Location of `.debob/context.db`
6. Add placeholder `review` command that prints "coming soon" (wires the command name into the CLI now)
7. Handle errors: catch engine errors, print with `chalk.red`, exit with code 1

**Relevant Context:**
- `bin/debob.ts` must be compiled to `dist/bin/debob.js` and marked executable
- The `package.json` `bin` field must point to `dist/bin/debob.js`
- Use `process.cwd()` as default repo root

---

### Sub-Task 10 — LLM Adapter Interface + watsonx Stub

**Status:** `[ ] pending`

**Intent:**
Define the LLM adapter interface and implement a stub for IBM watsonx. The interface must be clean enough that `debob review` and semantic enrichment can be built on top of it later without refactoring. The watsonx stub wires the interface but does not need to make real API calls in this sub-task.

**Expected Outcomes:**
- `src/llm/adapter.ts` defines `LLMAdapter` interface
- `src/llm/providers/watsonx.ts` implements the interface (stub, logs "not yet implemented" or makes real call if API key is present)
- `src/llm/index.ts` exports `createLLMAdapter(provider, config)` factory
- Interface is documented with JSDoc comments explaining future use

**Todo List:**
1. Define `LLMAdapter` interface in `src/llm/adapter.ts` with methods:
   - `summarizeModule(filePath, sourceCode): Promise<string>` — generate responsibility summary
   - `classifyLayer(filePath, imports, exports): Promise<string>` — infer architectural layer
   - `explainDiff(diff, context): Promise<string>` — used later by `debob review`
   - `answerQuestion(question, context): Promise<string>` — used later by `debob explain`
2. Define `LLMConfig` type: `{ provider: string, apiKey?: string, modelId?: string, endpoint?: string }`
3. Implement `WatsonxAdapter` in `src/llm/providers/watsonx.ts` — use `@ibm-cloud/watsonx-ai` SDK or `fetch` against the REST API; stub the methods if SDK not yet wired
4. Implement `createLLMAdapter(provider, config): LLMAdapter` factory in `src/llm/index.ts`
5. Document which methods are used by which future commands in JSDoc

**Relevant Context:**
- IBM watsonx AI REST API: `POST /ml/v1/text/generation` with `model_id`, `input`, `parameters`
- The watsonx adapter will need: `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT` from environment variables (never stored in `.debob/`)
- Do NOT call the LLM during `debob init` in v1 — the engine should accept an optional `llm?: LLMAdapter` and skip semantic enrichment if absent

---

### Sub-Task 11 — Architecture Documentation

**Status:** `[ ] pending`

**Intent:**
Write the `docs/architecture.md` that explains DeBob's design to future contributors and AI agents. This document should be the authoritative reference for how the system works and how to extend it.

**Expected Outcomes:**
- `docs/architecture.md` explains: system overview, component responsibilities, graph model, `.debob/` format, how to add a new language analyzer, how to add a new LLM provider, how `debob review` will be built

**Todo List:**
1. Write system overview section
2. Document each component (scanner, analyzer, git, graph, persistence, query, llm, cli)
3. Document the graph model (Node, Edge, NodeType, EdgeType)
4. Document the `.debob/` directory and `context.db` schema
5. Write a "How to add a language analyzer" extension guide
6. Write a "How to add an LLM provider" extension guide
7. Write a "How debob review will work" forward-looking section
8. Update `README.md` with quick-start instructions

**Relevant Context:**
- This document is also useful context for an AI agent working on this codebase
- Keep it factual — describe what exists, not what is planned (except in the "future" sections)

---

## Implementation Order

```
1 → Project Scaffold
2 → Shared Types
3 → SQLite Persistence Layer
4 → Repository Scanner
5 → TypeScript/JS Static Analyzer
6 → Git Metadata Extractor
7 → Graph Builder
8 → Core Engine Orchestrator
9 → CLI Entry Point
10 → LLM Adapter Interface + watsonx Stub
11 → Architecture Documentation
```

Each sub-task depends only on earlier ones. Sub-tasks 4, 5, 6 can proceed in parallel after sub-tasks 1 and 2 are complete.

---

## Design Principles Summary

| Principle | How it is enforced |
|---|---|
| Explainability | Every node/edge carries `confidence` + `source` fields |
| Incremental updates | SQLite upserts by stable id — future `debob update` reruns only changed files |
| Language extensibility | `LanguageAnalyzer` interface — new grammars are plugins |
| LLM independence | Graph is fully populated from static analysis; LLM is an optional enrichment layer |
| Persistent context | `.debob/context.db` is the knowledge artifact; designed to be committed or shared |
| Privacy | Git metadata stored with hashed author emails; no secrets, no `.env` values stored |
| Git as first-class data | Git churn, authorship, commit history attached to graph nodes |
