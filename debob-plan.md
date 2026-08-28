# DeBob — Bootstrap & Architecture Plan

## Overview

DeBob is a persistent repository-understanding and context system for AI coding agents.

> Git remembers what changed. DeBob remembers what the codebase means.

This plan covers the complete bootstrap from an empty repository to a working `debob init` foundation.

### Confirmed Architecture Principle

```
Repository
  → deterministic analysis
  → persistent graph
  → targeted context retrieval
  → LLM semantic reasoning (optional)
```

The LLM never receives the whole repository. The graph and query layer decide what targeted context the LLM needs, then pass only that slice.

### What `debob init` delivers

- Scans any Git repository
- Extracts deterministic structure: files, imports, exports, functions, classes, interfaces, extends, implements
- Extracts Git metadata: commits, per-file churn, authors (SHA-256 hashed), last modified
- Builds a typed, persistent graph of nodes and edges
- Persists everything to `.debob/context.db` (SQLite) with file content hashes and schema versions for future incremental updates
- Writes `.debob/manifest.json` with run metadata
- Prints a human-readable discovery summary
- With `--semantic`: after structural extraction, queries the graph for targeted context slices and passes those to the LLM for semantic enrichment (module responsibilities, architectural roles, workflow descriptions)

### Confirmed decisions

| Decision | Choice |
|---|---|
| Persistence | SQLite (`context.db`) + `manifest.json`. No per-module JSON files. Persistence layer behind an abstract interface so storage can be swapped later. |
| Static analysis scope | TS/JS only (V1). Extracts: imports, exports, functions, classes, interfaces, extends, implements. No call-graph or type-resolution. `LanguageAnalyzer` interface designed for Python/other grammars later. |
| LLM mode | `debob init` is deterministic by default. `debob init --semantic` runs LLM enrichment after structural extraction using targeted graph queries — never the full repo. DeBob is fully functional without LLM. |
| Author privacy | Git author emails SHA-256 hashed before storage. Raw emails never written to `.debob/`. |
| Incremental updates | File content hashes, analyzer version, schema version, and last-analyzed commit stored per file. Future `debob update` reruns only files whose hash or Git history changed. |

**Out of scope for this plan:** `debob review`, `debob explain`, `debob impact`, `debob why`, `debob onboard`, `debob update`.

---

## Technology Stack

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript (Node.js) | Strong CLI, tree-sitter, LLM SDK ecosystem |
| Package manager | npm | Universal, no extra tooling |
| CLI framework | `commander` | Minimal, widely used |
| Git integration | `simple-git` | Async, well-typed Node.js wrapper |
| AST parsing | `tree-sitter` + `tree-sitter-typescript` | Grammar plugin model — add Python/Rust/etc later |
| Persistence | `better-sqlite3` | Synchronous, embedded, single-file, queryable |
| LLM adapter | Custom `LLMAdapter` interface, IBM watsonx first | Provider-agnostic; called only in `--semantic` mode |
| Build | `tsup` | Fast ESM/CJS dual build |
| Runtime binary | `tsx` for dev, compiled `dist/` for npx | `npx debob` without global install |

---

## Repository Layout

```
debob/
├── bin/
│   └── debob.ts                    ← CLI entry point (commander)
├── src/
│   ├── engine/
│   │   └── index.ts                ← Core orchestrator: runInit
│   ├── scanner/
│   │   └── index.ts                ← File system scanner
│   ├── analyzers/
│   │   ├── interface.ts            ← LanguageAnalyzer plugin interface
│   │   └── typescript/
│   │       └── index.ts            ← TS/JS tree-sitter analyzer
│   ├── git/
│   │   └── index.ts                ← Git metadata extractor
│   ├── graph/
│   │   ├── types.ts                ← Node, Edge, Graph types
│   │   └── builder.ts              ← Graph construction + deduplication
│   ├── persistence/
│   │   ├── interface.ts            ← Abstract PersistenceAdapter interface
│   │   ├── schema.ts               ← SQLite schema + migrations
│   │   └── sqlite.ts               ← SQLite implementation of PersistenceAdapter
│   ├── query/
│   │   └── index.ts                ← Graph query helpers (used by LLM context builder)
│   ├── llm/
│   │   ├── adapter.ts              ← LLMAdapter interface
│   │   ├── context.ts              ← Context builder: graph queries → targeted LLM prompts
│   │   ├── index.ts                ← createLLMAdapter factory
│   │   └── providers/
│   │       └── watsonx.ts          ← IBM watsonx implementation
│   └── types/
│       └── index.ts                ← Re-exports all shared types
├── docs/
│   └── architecture.md
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── README.md
```

Key addition vs initial draft: `src/persistence/interface.ts` (abstract adapter) and `src/llm/context.ts` (the layer that converts graph queries into targeted LLM prompts — enforcing "never send the full repo").

---

## `.debob/` Directory Structure

```
.debob/
├── context.db       ← SQLite: all graph data, git metadata, semantic enrichment, file hashes
└── manifest.json    ← Run metadata: debob version, schema version, init timestamp, nodeCount, edgeCount
```

### `context.db` Tables

| Table | Contents |
|---|---|
| `nodes` | Graph nodes: files, functions, classes, interfaces, packages |
| `edges` | Typed relationships between nodes |
| `git_commits` | hash, author name, author_email_hash (SHA-256), date, subject |
| `git_file_stats` | filePath, commitCount, churnScore, authorCount, lastModifiedAt |
| `file_cache` | filePath, contentHash (SHA-256), analyzerVersion, lastAnalyzedAt, lastGitCommit — drives incremental updates |
| `semantic_enrichments` | nodeId, field (responsibility/layer/etc), value, llmProvider, modelId, createdAt — LLM output stored separately and clearly tagged |

The `file_cache` table is the foundation of incremental updates: on a future `debob update`, any file whose `contentHash` or latest `lastGitCommit` has changed since `lastAnalyzedAt` is re-analyzed; unchanged files are skipped.

---

## Graph Model

### Node

```ts
interface Node {
  id: string            // stable: relative file path OR "relativePath::SymbolName"
  type: NodeType        // see NodeType below
  name: string
  filePath: string
  startLine?: number
  endLine?: number
  layer?: string        // "presentation" | "business" | "data" | "config" | "test" | "infra" — heuristic or LLM
  responsibility?: string  // LLM-populated (stored in semantic_enrichments, joined on read)
  confidence: number    // 1.0 = deterministic static analysis; < 1.0 = LLM inference
  dataSource: "static" | "git" | "llm"
  metadata?: Record<string, unknown>  // churnScore, hot, authorCount, etc.
}
```

### NodeType

```
"file" | "function" | "class" | "interface" | "variable" | "route" | "package"
```

`interface` is added as a first-class V1 node type (TypeScript `interface` declarations).

### Edge

```ts
interface Edge {
  id: string            // "${source}::${type}::${target}" — deterministic, deduplication-safe
  source: string        // node id
  target: string        // node id
  type: EdgeType
  confidence: number
  dataSource: "static" | "git" | "llm"
  metadata?: Record<string, unknown>
}
```

### EdgeType (string union — extensible without breaking changes)

```
"imports" | "exports" | "calls" | "depends_on" | "extends" | "implements" |
"instantiates" | "exposes" | "handles" | "tests" | "reads_from" | "writes_to" |
"communicates_with" | "configured_by" | "related_to"
```

---

## Persistence Abstraction

The persistence layer is behind an interface so the storage backend can be replaced (e.g. a future graph database, in-memory store for testing):

```ts
interface PersistenceAdapter {
  saveNodes(nodes: Node[]): void
  saveEdges(edges: Edge[]): void
  saveGitCommits(commits: GitCommit[]): void
  saveGitFileStats(stats: GitFileStats[]): void
  saveFileCache(entries: FileCacheEntry[]): void
  saveSemanticEnrichments(enrichments: SemanticEnrichment[]): void
  readGraph(): Graph
  readFileCacheEntries(): FileCacheEntry[]
  close(): void
}
```

`SqlitePersistenceAdapter` in `src/persistence/sqlite.ts` is the V1 implementation. The engine depends only on `PersistenceAdapter`.

---

## LLM Architecture

The LLM is never given the full repository. The flow for `--semantic` mode:

```
Graph (persisted in context.db)
  ↓
Query Engine (src/query/index.ts)
  ↓  targeted queries: "give me all nodes + edges for this file"
Context Builder (src/llm/context.ts)
  ↓  assembles a focused prompt from query results (imports, exports, callers, structure)
LLM Adapter (src/llm/adapter.ts)
  ↓  sends only that slice
Semantic Enrichment
  ↓  stored back in semantic_enrichments table with llmProvider + modelId tags
```

### LLMAdapter interface

```ts
interface LLMAdapter {
  /** Summarize a module's responsibility from its graph context slice */
  summarizeModule(context: ModuleContext): Promise<string>
  /** Infer the architectural layer of a file from its imports/exports */
  classifyLayer(context: ModuleContext): Promise<string>
  /** [future] Explain a diff in the context of the graph — used by debob review */
  explainDiff(diff: string, context: DiffContext): Promise<string>
  /** [future] Answer a free-form question using graph context — used by debob explain */
  answerQuestion(question: string, context: QueryContext): Promise<string>
}
```

`ModuleContext`, `DiffContext`, `QueryContext` are structured types, not raw strings — the context builder populates them from graph queries. IBM watsonx is the V1 provider. Provider credentials come from environment variables only (`WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT`) — never stored in `.debob/`.

---

## Analyzer Plugin Interface

```ts
interface LanguageAnalyzer {
  readonly language: string          // e.g. "typescript"
  readonly extensions: string[]      // e.g. [".ts", ".tsx", ".js", ".jsx"]
  analyze(filePath: string, source: string): AnalysisResult
}

interface AnalysisResult {
  nodes: Node[]
  edges: Edge[]
}
```

V1 extracts from TS/JS: `import_declaration` → `imports` edges, `export` → `exports` edges, `function_declaration` → function nodes, `class_declaration` → class nodes, `interface_declaration` → interface nodes, `extends_clause` → `extends` edges, `implements_clause` → `implements` edges.

New languages (Python, Rust, etc.) are added by writing a new class that implements `LanguageAnalyzer` and registering its extensions with the engine. No other code changes required.

---

## Sub-Tasks

---

### Sub-Task 1 — Project Scaffold

**Status:** `[x] done`

**Intent:**
Establish the TypeScript project with all dependencies, build configuration, and directory structure. Every other sub-task depends on this.

**Expected Outcomes:**
- `package.json` with all dependencies and `bin` entry
- `tsconfig.json` in strict ESM mode
- `tsup.config.ts` building to `dist/`
- All source directories created
- `npm install` succeeds
- `npm run build` produces a runnable `dist/bin/debob.js`

**Todo List:**
1. Create `package.json`: name `debob`, version `0.1.0`, `"type": "module"`, bin entry `"debob": "dist/bin/debob.js"`
2. Runtime dependencies: `commander`, `simple-git`, `better-sqlite3`, `tree-sitter`, `tree-sitter-typescript`, `chalk`, `ora`, `glob`
3. Dev dependencies: `typescript`, `tsup`, `tsx`, `@types/node`, `@types/better-sqlite3`
4. `tsconfig.json`: target ES2022, `moduleResolution: "bundler"`, `strict: true`, `outDir: "dist"`
5. `tsup.config.ts`: entry `["bin/debob.ts", "src/**/*.ts"]`, format `["esm"]`, `dts: true`, `sourcemap: true`
6. Scripts: `build`, `dev` (tsx), `typecheck` (tsc --noEmit), `start` (node dist/bin/debob.js)
7. Create directory skeleton for all `src/` subdirectories and `docs/`
8. Create a minimal `README.md` placeholder

**Relevant Context:**
- `npx debob init` will invoke `dist/bin/debob.js`
- tree-sitter native bindings require Node.js ≥18

---

### Sub-Task 2 — Shared Types

**Status:** `[x] done`

**Intent:**
Define all shared TypeScript types. Types are established before implementation so all sub-tasks compile against a consistent contract.

**Expected Outcomes:**
- `src/graph/types.ts` — NodeType, EdgeType, Node, Edge, Graph
- `src/analyzers/interface.ts` — LanguageAnalyzer, AnalysisResult
- `src/persistence/interface.ts` — PersistenceAdapter, FileCacheEntry, SemanticEnrichment
- `src/git/index.ts` (type section) — GitCommit, GitFileStats, GitMetadata
- `src/scanner/index.ts` (type section) — ScannedFile
- `src/llm/adapter.ts` — LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext
- `src/types/index.ts` re-exports everything
- All types compile cleanly with `tsc --noEmit`

**Todo List:**
1. `src/graph/types.ts`: NodeType union, EdgeType union, Node interface, Edge interface, Graph interface `{ nodes: Map<string, Node>, edges: Edge[] }`
2. `src/analyzers/interface.ts`: LanguageAnalyzer interface, AnalysisResult interface
3. `src/persistence/interface.ts`: PersistenceAdapter interface, FileCacheEntry `{ filePath, contentHash, analyzerVersion, schemaVersion, lastAnalyzedAt, lastGitCommit }`, SemanticEnrichment `{ nodeId, field, value, llmProvider, modelId, createdAt }`
4. `src/git/index.ts` (types only): GitCommit `{ hash, authorName, authorEmailHash, date, subject, filesChanged }`, GitFileStats `{ filePath, commitCount, churnScore, authorCount, lastModifiedAt }`, GitMetadata `{ commits, fileStats }`
5. `src/scanner/index.ts` (types only): ScannedFile `{ path, relativePath, extension, language, sizeBytes, contentHash }`
6. `src/llm/adapter.ts` (types + interface): LLMConfig, ModuleContext `{ filePath, imports, exports, declarations, gitStats? }`, DiffContext, QueryContext, LLMAdapter interface
7. `src/types/index.ts`: re-export from all of the above

**Relevant Context:**
- `dataSource` field (not `source`) on Node and Edge to avoid collision with built-in `source` property names
- `confidence: 1.0` for all deterministic outputs; LLM outputs use `confidence < 1.0`
- EdgeType is a string union (not enum) so new values can be added without breaking existing consumers
- `FileCacheEntry` is the key data structure enabling incremental updates — get this right

---

### Sub-Task 3 — SQLite Persistence Layer

**Status:** `[x] done`

**Intent:**
Implement `SqlitePersistenceAdapter` behind the `PersistenceAdapter` interface. This is the canonical V1 storage backend. The interface abstraction means tests and future backends never touch SQLite directly.

**Expected Outcomes:**
- `src/persistence/schema.ts`: all `CREATE TABLE IF NOT EXISTS` statements + schema version constant
- `src/persistence/sqlite.ts`: `SqlitePersistenceAdapter` implementing `PersistenceAdapter`
- `openDb(repoPath)` creates `.debob/` dir and runs schema migrations
- All save operations are upserts (INSERT OR REPLACE) keyed on stable IDs
- `readGraph()` reconstructs Node/Edge structures from rows
- `writeManifest` / `readManifest` in `src/persistence/sqlite.ts` for `manifest.json`
- Unit-testable: adapter can be constructed with any db path, not just `.debob/`

**Todo List:**
1. `src/persistence/schema.ts`: define `SCHEMA_VERSION = 1` constant and all `CREATE TABLE IF NOT EXISTS` DDL for: `nodes`, `edges`, `git_commits`, `git_file_stats`, `file_cache`, `semantic_enrichments`
2. `src/persistence/sqlite.ts`: implement `openDb(repoPath): Database` — mkdirSync `.debob/`, open `context.db`, run schema statements, return db handle
3. Implement `SqlitePersistenceAdapter` class taking a `Database` in constructor
4. `saveNodes`: INSERT OR REPLACE, serialize `metadata` as JSON column
5. `saveEdges`: INSERT OR REPLACE, serialize `metadata` as JSON column
6. `saveGitCommits`: INSERT OR REPLACE by `hash`
7. `saveGitFileStats`: INSERT OR REPLACE by `filePath`
8. `saveFileCache`: INSERT OR REPLACE by `filePath` — this is what makes incremental updates possible
9. `saveSemanticEnrichments`: INSERT OR REPLACE by `(nodeId, field)` — LLM outputs clearly separated
10. `readGraph()`: SELECT all nodes + edges, deserialize JSON columns, reconstruct `Graph`
11. `readFileCacheEntries()`: SELECT all from `file_cache`
12. `writeManifest(repoPath, data)`: JSON.stringify to `.debob/manifest.json`
13. `readManifest(repoPath)`: read and parse `.debob/manifest.json`, return null if absent

**Relevant Context:**
- `better-sqlite3` is synchronous — no async/await; wrap in try/catch for error boundaries
- `metadata` and `filesChanged` columns stored as JSON text — parse on read
- Schema version stored in `manifest.json` so future migrations can detect the gap
- `file_cache.contentHash` is SHA-256 of the file's UTF-8 content — computed in the scanner, stored here

---

### Sub-Task 4 — Repository Scanner

**Status:** `[x] done` (including post-completion hardening — see `scanner-hardening-plan.md`)

**Intent:**
Implement the file system scanner that discovers all relevant source files and computes their content hashes. The hash is stored in `file_cache` and is the primary mechanism for detecting what changed on future runs.

**Expected Outcomes:**
- `src/scanner/index.ts` exports `scanRepository(repoRoot: string, options?: ScanOptions): Promise<ScannedFile[]>`
- Returns all source files with path, extension, language, size, and SHA-256 content hash
- Respects standard exclusion patterns (node_modules, .git, .debob, dist, build, coverage)
- Respects `.gitignore` and `.debobignore` rules at scan time (via `ignore` npm package)
- Skips files over 1 MB before calling `readFileSync`
- Skips files whose extension is not in the `TEXT_EXTENSIONS` allowlist (binary/non-source files)
- Correctly classifies TS/JS extensions for the analyzer

**Todo List:**
1. Implement `scanRepository(repoRoot)` using `glob` to find all files recursively ✓
2. Exclusion list: `node_modules/**`, `.git/**`, `.debob/**`, `dist/**`, `build/**`, `coverage/**`, `**/*.min.js`, `**/*.map`, `**/*.d.ts` ✓
3. For each file: read content, compute SHA-256 hash (Node.js `crypto.createHash('sha256')`), stat for size ✓
4. Language detection from extension: `.ts`/`.tsx` → `"typescript"`, `.js`/`.jsx`/`.mjs`/`.cjs` → `"javascript"`, others → `"unknown"` ✓
5. Return `ScannedFile[]` including `contentHash` ✓
6. Filter out files with `language: "unknown"` from analysis (still record in file list but don't pass to analyzers) ✓
7. Post-glob filter via `ignore` package reading `.gitignore` + `.debobignore` from repoRoot ✓
8. Size cap: skip files where `stats.size > MAX_FILE_BYTES` (1 MB) before `readFileSync` ✓
9. Extension allowlist: skip files whose `ext` is not in `TEXT_EXTENSIONS` set ✓

**Relevant Context:**
- `ScannedFile.contentHash` is the SHA-256 of the file's raw UTF-8 content — must be identical on re-scan if file unchanged
- The scanner does not check `file_cache` — the engine decides whether to re-analyze based on hash comparison
- `repoRoot` is passed from the CLI, defaults to `process.cwd()`
- `ScanOptions.respectGitignore` defaults to `true`; set to `false` in tests scanning temp dirs without a `.gitignore`
- `ScanOptions.extraIgnore` accepts additional glob patterns on top of `DEFAULT_IGNORE`
- Guard order in the loop: gitignore filter → extension allowlist → `statSync` → size cap → `readFileSync`
- `ignore` package is pinned at `^5.3.2` in `dependencies`

---

### Sub-Task 5 — TypeScript/JavaScript Static Analyzer

**Status:** `[x] done`

**Intent:**
Implement `TypeScriptAnalyzer`, the V1 `LanguageAnalyzer` plugin, using tree-sitter. Extracts nodes and edges deterministically from TS/JS source. Covers the confirmed V1 scope: imports, exports, functions, classes, interfaces, extends, implements.

**Expected Outcomes:**
- `src/analyzers/typescript/index.ts` exports `TypeScriptAnalyzer` implementing `LanguageAnalyzer`
- For each file: one `file` node + N symbol nodes (function, class, interface)
- Edges: `imports` (to resolved module paths or package nodes), `exports`, `extends`, `implements`
- All outputs: `confidence: 1.0`, `dataSource: "static"`
- External package imports produce `package` type target nodes
- Layer hints assigned from path patterns

**Todo List:**
1. Initialize tree-sitter parser with TypeScript grammar (use TSX grammar for `.tsx` files)
2. Implement `analyze(filePath, source): AnalysisResult`
3. Always emit one `file` node with `id = relativePath`, `type: "file"`
4. Walk AST for `import_declaration`: extract module specifier string → `imports` edge; if relative path, resolve to canonical repo-relative path; if bare specifier, create/reference a `package` node
5. Walk AST for `export_statement` / `export_declaration`: emit `exports` edge from file node to exported symbol node (if named export) or mark file node as exporting
6. Walk AST for `function_declaration`, `method_definition`, exported arrow functions assigned via `const x = () =>`: emit `function` nodes with `startLine`/`endLine`
7. Walk AST for `class_declaration`: emit `class` node; check `extends_clause` → `extends` edge; check `implements_clause` → `implements` edge (one edge per implemented type)
8. Walk AST for `interface_declaration`: emit `interface` node; check `extends_clause` → `extends` edge
9. Assign `layer` hint: path contains `test`/`spec` → `"test"`, `route`/`controller` → `"presentation"`, `service` → `"business"`, `model`/`schema`/`entity` → `"data"`, `config` → `"config"`, `middleware` → `"infra"`
10. Edge id: `"${sourceId}::${edgeType}::${targetId}"` — deterministic, deduplication-safe

**Relevant Context:**
- tree-sitter is synchronous; the `analyze` method is not async
- `tree-sitter-typescript` package exports `.typescript` and `.tsx` grammars
- Do NOT attempt to resolve `import type` through type system — treat as a regular import edge
- Do NOT attempt call-graph extraction in V1 — too expensive without type info, deferred to future analyzer version

---

### Sub-Task 6 — Git Metadata Extractor

**Status:** `[x] done`

**Intent:**
Extract Git metadata: recent commits (up to configurable limit), per-file change frequency (churn), author counts, and last-modified timestamps. Author emails are SHA-256 hashed before storage.

**Expected Outcomes:**
- `src/git/index.ts` exports `extractGitMetadata(repoRoot, options): Promise<GitMetadata>`
- Returns up to `maxCommits` commits and per-file stats
- Author emails stored as SHA-256 hex digests, never in plaintext
- Returns gracefully if directory is not a Git repo

**Todo List:**
1. `extractGitMetadata(repoRoot, { maxCommits = 500 })`: initialize `simple-git(repoRoot)`
2. Check `git.checkIsRepo()` — return `{ commits: [], fileStats: [] }` if not a repo
3. Fetch log: last `maxCommits` commits using `git.log({ maxCount: maxCommits, '--name-only': null })` to get changed files per commit
4. For each commit: hash author email with `crypto.createHash('sha256').update(email).digest('hex')`
5. Build `GitCommit[]`: `{ hash, authorName, authorEmailHash, date, subject, filesChanged: string[] }`
6. Aggregate `GitFileStats`: for each file path seen across commits, count total commits, collect unique `authorEmailHash` set (count = authorCount), track latest commit date
7. `churnScore = commitCount` (raw commit count — higher = more volatile)
8. Return `GitMetadata { commits, fileStats }`
9. Surface the last-analyzed commit hash in the return so the engine can store it in `file_cache` for incremental comparison

**Relevant Context:**
- `simple-git` log with `--name-only` gives filenames changed per commit — parse from the log format
- `authorCount` = size of the unique hashed-email set per file (hashing is consistent so set membership is valid)
- Limit 500 commits is configurable via `InitOptions.maxCommits` — do not hardcode
- Do NOT read any file content — only git log metadata

---

### Sub-Task 7 — Graph Builder

**Status:** `[x] done`

**Intent:**
Combine scanner output, all analyzer results, and Git metadata into a single deduplicated, consistent `Graph`. Merge Git signals into file nodes as metadata. Identify hot files.

**Expected Outcomes:**
- `src/graph/builder.ts` exports `buildGraph(files, analysisResults, gitMetadata): Graph`
- One canonical `file` node per scanned file
- All symbol nodes from analysis merged and deduplicated by id
- All edges merged and deduplicated by edge id
- Each file node carries `metadata.churnScore`, `metadata.lastModifiedAt`, `metadata.authorCount`, `metadata.contentHash`
- Hot files (churnScore in top 10%) marked `metadata.hot = true`

**Todo List:**
1. Initialize graph: `nodes = new Map<string, Node>()`, `edges: Edge[] = []`
2. For each `ScannedFile`, create/upsert a `file` node (`id = relativePath`)
3. Merge all `AnalysisResult` nodes — if a node id already exists, keep the more detailed version (symbol nodes from analysis win over bare file nodes from scanner)
4. Merge all `AnalysisResult` edges — deduplicate by edge id
5. For each file node, look up its `GitFileStats` entry — attach `churnScore`, `lastModifiedAt`, `authorCount` to `metadata`; also attach `contentHash` from `ScannedFile`
6. Compute churn top-10% threshold; mark qualifying file nodes with `metadata.hot = true`
7. Ensure all edge `source`/`target` ids that refer to non-existent nodes create stub nodes (type `"package"` for external, `"file"` for internal missing files) rather than leaving dangling references
8. Return `Graph { nodes, edges }`

**Relevant Context:**
- Node deduplication key is the `id` string — always the stable relative path or `"relativePath::SymbolName"`
- External package stub nodes: id = `"pkg::express"`, type = `"package"`, `dataSource: "static"`, `confidence: 1.0`
- The graph at this stage contains zero LLM-derived data — clearly all `dataSource: "static"` or `"git"`

---

### Sub-Task 8 — Core Engine Orchestrator

**Status:** `[x] done`

**Intent:**
Wire all subsystems together for `debob init`. Manages the pipeline: scan → analyze → git → build graph → persist → (optional) semantic enrichment. Returns a structured `InitResult` for the CLI to render.

**Expected Outcomes:**
- `src/engine/index.ts` exports `runInit(repoRoot, options): Promise<InitResult>`
- Deterministic by default; calls LLM enrichment only when `options.semantic === true` and an `LLMAdapter` is provided
- Progress reported via a passed-in `logger` callback (not direct console.log — CLI owns output)
- Returns `InitResult` with full counts and summary data

**Todo List:**
1. `runInit(repoRoot: string, options: InitOptions): Promise<InitResult>` where `InitOptions = { maxCommits?: number, verbose?: boolean, semantic?: boolean, llm?: LLMAdapter }`
2. Step 1 — Validate: confirm `repoRoot` exists and contains `.git/`; throw descriptive error if not
3. Step 2 — Scan: call `scanRepository(repoRoot)` → report file count by language
4. Step 3 — Analyze: for each scanned file with a known language, find the registered `LanguageAnalyzer` and call `.analyze()` → collect `AnalysisResult[]`; skip files with no registered analyzer
5. Step 4 — Git: call `extractGitMetadata(repoRoot, { maxCommits })` → report commit count
6. Step 5 — Build graph: call `buildGraph(files, analysisResults, gitMetadata)` → report node/edge count
7. Step 6 — Persist: `openDb(repoRoot)` → `new SqlitePersistenceAdapter(db)` → save nodes, edges, git commits, git file stats; save `file_cache` entries (one per scanned file: contentHash, analyzerVersion, schemaVersion, lastGitCommit)
8. Step 7 — Semantic enrichment (only if `options.semantic && options.llm`): for each file node, call `buildModuleContext(node, graph)` from query layer → call `llm.summarizeModule(context)` and `llm.classifyLayer(context)` → save results to `semantic_enrichments` table via adapter
9. Step 8 — Write manifest: call `writeManifest(repoRoot, { version, schemaVersion, initAt, nodeCount, edgeCount, fileCount, commitCount, semantic: options.semantic ?? false })`
10. Step 9 — Return `InitResult { nodeCount, edgeCount, fileCount, commitCount, hotFiles, layerDistribution, packageDependencies, dbPath }`

**Relevant Context:**
- `analyzerVersion` = a constant string in each `LanguageAnalyzer` (e.g. `"ts-1.0"`) — stored in `file_cache` so future schema/analyzer changes trigger re-analysis
- Register analyzers in a `Map<string, LanguageAnalyzer>` keyed by extension — engine selects by `ScannedFile.extension`
- LLM context is built by the query layer per module — never concatenating all source files

---

### Sub-Task 9 — CLI Entry Point

**Status:** `[ ] pending`

**Intent:**
Implement `bin/debob.ts` using `commander`. This is the user-facing surface. Drives `runInit`, renders the summary, and wires `--semantic` to pass an `LLMAdapter` to the engine.

**Expected Outcomes:**
- `npx debob init` runs in any Git repo, produces `.debob/context.db`, prints summary
- `npx debob init --semantic` additionally runs LLM enrichment if `WATSONX_*` env vars are set
- `npx debob --help` and `npx debob init --help` show correct help text
- Exit code 0 on success, non-zero on error
- Rich colored summary output using `chalk` and `ora`

**Todo List:**
1. `bin/debob.ts`: `#!/usr/bin/env node` shebang, import `commander`, import `runInit`, import `createLLMAdapter`
2. Program: name `debob`, version read from `package.json`, description
3. `init` command options: `--repo <path>` (default `process.cwd()`), `--max-commits <n>` (default `500`), `--semantic` (flag), `--verbose`
4. In `init` action:
   a. If `--semantic`: read `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT` from env; create `WatsonxAdapter` via `createLLMAdapter`; warn if vars missing and skip semantic
   b. Run `ora` spinner, call `runInit(repo, { maxCommits, semantic, llm, verbose })`
   c. Render summary with `chalk`: files scanned by language, nodes by type, edges by type, git commit count, top 5 hot files, layer distribution, external package dependencies, db path
5. Stub `review` command: `program.command('review').description('Review a diff against the repository graph (coming soon)').action(() => { console.log(chalk.yellow('debob review — coming soon')) })`
6. Error handling: wrap action in try/catch → `chalk.red(err.message)` → `process.exit(1)`

**Relevant Context:**
- `bin/debob.ts` compiles to `dist/bin/debob.js` — `tsup` must mark it executable (add `banner: { js: '#!/usr/bin/env node' }` in tsup config)
- `package.json` `"bin"` field: `{ "debob": "./dist/bin/debob.js" }`
- Credentials read from environment only — never prompt, never read from file, never store

---

### Sub-Task 10 — LLM Adapter Interface + watsonx Implementation

**Status:** `[ ] pending`

**Intent:**
Implement the full LLM layer: the `LLMAdapter` interface, the `context.ts` context builder (graph → targeted prompt), and the IBM watsonx provider. This is what `--semantic` mode calls. The LLM never receives raw source files — only structured context slices assembled by the query layer.

**Expected Outcomes:**
- `src/llm/adapter.ts`: `LLMAdapter` interface + context types (already typed in Sub-Task 2; add JSDoc here)
- `src/llm/context.ts`: `buildModuleContext(node, graph): ModuleContext` — uses query helpers to assemble what the LLM needs for a given node
- `src/llm/providers/watsonx.ts`: `WatsonxAdapter` implementing `LLMAdapter` using IBM watsonx REST API
- `src/llm/index.ts`: `createLLMAdapter(provider, config): LLMAdapter` factory
- All LLM outputs stored via `saveSemanticEnrichments` with `llmProvider` and `modelId` metadata

**Todo List:**
1. `src/query/index.ts`: implement `getNodeNeighbours(graph, nodeId, depth): Node[]`, `getNodeEdges(graph, nodeId): Edge[]`, `getFileImports(graph, filePath): string[]`, `getFileExports(graph, filePath): string[]` — these are the primitives the context builder uses
2. `src/llm/context.ts`: `buildModuleContext(node, graph, gitStats?): ModuleContext` — assembles `{ filePath, imports: string[], exports: string[], declarations: { name, type }[], gitStats? }` from graph query results
3. `src/llm/adapter.ts`: add JSDoc to each method documenting which debob command uses it and what context it expects
4. `src/llm/providers/watsonx.ts`: implement `WatsonxAdapter`:
   - Constructor takes `LLMConfig` (`apiKey`, `projectId`, `endpoint`, `modelId`)
   - `summarizeModule(ctx)`: build a structured prompt from `ModuleContext` fields (not raw source); call `POST {endpoint}/ml/v1/text/generation` with `model_id`, project_id, input, parameters
   - `classifyLayer(ctx)`: similar — prompt from imports/exports/declarations only
   - `explainDiff` and `answerQuestion`: stub with `throw new Error('not yet implemented')` — interfaces defined, implementations deferred to review/explain sub-tasks
5. `src/llm/index.ts`: `createLLMAdapter(provider: string, config: LLMConfig): LLMAdapter` — switch on `provider`, return `new WatsonxAdapter(config)` for `"watsonx"`, throw for unknown providers
6. Watsonx prompt format: structured JSON/text including file path, import list, export list, declaration names — not source code

**Relevant Context:**
- IBM watsonx text generation endpoint: `POST /ml/v1/text/generation?version=2023-05-29`
- Request body: `{ "model_id": "...", "project_id": "...", "input": "...", "parameters": { "max_new_tokens": 256 } }`
- Auth: `Authorization: Bearer {apiKey}` header
- Credentials from env only: `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT`
- The prompt must describe the module context in structured terms — not dump source code

---

### Sub-Task 11 — Architecture Documentation

**Status:** `[ ] pending`

**Intent:**
Write `docs/architecture.md` and finalize `README.md`. This document is the primary reference for future contributors and AI agents working on DeBob.

**Expected Outcomes:**
- `docs/architecture.md`: comprehensive, accurate, covers every component, the graph model, the db schema, incremental update design, LLM architecture, and extension guides
- `README.md`: quick-start, install, usage, `--semantic` usage, contribution pointer

**Todo List:**
1. Architecture doc sections: System Overview, Core Principle (deterministic → graph → targeted retrieval → LLM), Component Responsibilities, Graph Model, `.debob/` Schema, Incremental Update Design, LLM Architecture (emphasize "never full repo"), How to Add a Language Analyzer, How to Add an LLM Provider, How `debob review` will be built on this foundation
2. Include the `file_cache` table design and its role in incremental updates
3. Include the `semantic_enrichments` table design and why LLM outputs are stored separately from static facts
4. Extension guide: "Adding Python support" — implement `LanguageAnalyzer`, register extensions, done
5. `README.md`: `npx debob init`, `npx debob init --semantic`, `npx debob init --repo /path/to/repo`, env vars for watsonx, what `.debob/` contains

**Relevant Context:**
- Keep factual — describe what exists; label "future" sections clearly
- This doc is also useful as LLM context for agents working on the debob codebase itself

---

## Implementation Order

```
1 → Project Scaffold                          (foundation)
2 → Shared Types                              (depends on 1)
3 → SQLite Persistence Layer                  (depends on 1, 2)
4 → Repository Scanner                        (depends on 1, 2)       ┐
5 → TypeScript/JS Static Analyzer             (depends on 1, 2)       ├─ parallel
6 → Git Metadata Extractor                    (depends on 1, 2)       ┘
7 → Graph Builder                             (depends on 2, 4, 5, 6)
8 → Core Engine Orchestrator                  (depends on 3, 4, 5, 6, 7)
9 → CLI Entry Point                           (depends on 8)
10 → LLM Adapter + watsonx + Context Builder  (depends on 1, 2, 3, 7)
11 → Architecture Documentation               (depends on all)
```

---

## Design Principles Summary

| Principle | Enforcement |
|---|---|
| Deterministic first | All static analysis outputs carry `confidence: 1.0`, `dataSource: "static"`. LLM outputs: `confidence < 1.0`, `dataSource: "llm"`, stored in separate `semantic_enrichments` table |
| Never send full repo to LLM | Context builder assembles targeted slices from graph queries. LLM never receives raw source files |
| Incremental update ready | `file_cache` stores content hash + analyzer version + schema version per file. Future `debob update` skips unchanged files |
| Language extensibility | `LanguageAnalyzer` interface — new grammars are plugins registered by extension |
| Persistence abstraction | Engine depends on `PersistenceAdapter` interface, not `better-sqlite3` directly |
| LLM independence | Full graph built from static analysis alone. `--semantic` is additive enrichment |
| Privacy | Author emails SHA-256 hashed. No secrets, tokens, or `.env` values ever written to `.debob/` |
| Git as first-class data | Churn, authorship, commit history attached to graph nodes via `file_cache` and `git_file_stats` |
| Explainability | Every node/edge carries `confidence` + `dataSource` — every inference is traceable to its origin |
