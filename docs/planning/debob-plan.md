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

**Status:** `[x] done`

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

**Status:** `[x] done`

**Intent:**
Implement the full LLM layer: the `LLMAdapter` interface, the `context.ts` context builder (graph → targeted prompt), and the IBM watsonx provider. This is what `--semantic` mode calls. The LLM never receives raw source files — only structured context slices assembled by the query layer.

**Expected Outcomes:** ✅ All delivered.
- `src/llm/adapter.ts`: `LLMAdapter` interface + context types + full JSDoc. `LLMConfig.url` (not `endpoint`).
- `src/llm/context.ts`: `buildModuleContext(node, graph, gitStats?): ModuleContext`
- `src/llm/providers/watsonx.ts`: `WatsonxProvider` using `@ibm-cloud/watsonx-ai` SDK + `IamAuthenticator`, `textChat()` chat API
- `src/llm/index.ts`: `createLLMAdapter` factory wiring `"watsonx"` → `WatsonxProvider`; exports `WatsonxAdapter` alias
- 100 enrichments written to `semantic_enrichments` on a live run against this repo

**Relevant Context (as implemented):**
- SDK: `@ibm-cloud/watsonx-ai@^1.7.16` — class `WatsonXAI`, method `textChat({ modelId, projectId, messages })`
- Auth: `IamAuthenticator({ apikey })` from `@ibm-cloud/watsonx-ai/authentication`
- Chat API response: `response.result.choices[0].message.content`
- Credentials from env: `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL`, `WATSONX_MODEL_ID`
  - Note: `WATSONX_URL` (not `WATSONX_ENDPOINT`), `WATSONX_MODEL_ID` must include namespace prefix (e.g. `openai/gpt-oss-120b`)
- `.env` auto-loaded by CLI at startup — users do not need to `export` vars manually
- The deprecated `POST /ml/v1/text/generation` REST endpoint is NOT used

---

### Sub-Task 11 — Architecture Documentation

**Status:** `[x] done`

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

## Sub-Tasks F–J — Hackathon Demo Hardening (2026-08-29)

> Follow-on work after Sub-Tasks A–E (see `debob-impl-plan.md`), scoped for demo readiness:
> harden the existing `debob review` command, add `debob explain` (free-text Q&A), wire the
> mechanism that makes any AI coding agent discover the graph automatically, add a second
> language analyzer, and document team-sharing/automation options. Executed in order F → J.

---

### Sub-Task F — Harden `debob review`

**Status:** `[x] done`

**Intent:**
`debob review` was functionally complete (Sub-Task D) but untested against real failure modes
that would be visible on stage: LLM timeouts, response truncation, renamed files, and a
misleading two-dot diff base. Harden it against all of these using real rehearsal, not just
code review.

**Expected Outcomes:**
- `WatsonxProvider._chat()` has an explicit `maxTokens` and a bounded timeout
- `runReview` closes its DB adapter via `try/finally` even if `explainDiff` throws
- `extractChangedPaths` captures both sides of a rename
- `--base` uses three-dot (`base...HEAD`) diff semantics
- "No diff found" renders as a calm message, not a red failure banner
- Changed files missing from the graph produce a `notes` message pointing at `debob update`
- Rehearsed against: real diff (this repo), no-diff clean tree, non-git directory, diverged
  `--base` branches — all produce clean, non-hanging output

**Todo List:**
1. `src/llm/providers/watsonx.ts` `_chat()`: add `maxTokens: 4096` to the `textChat()` call —
   discovered via rehearsal that watsonx's own default (1024) is too low for reasoning-capable
   models (e.g. `openai/gpt-oss-120b`), which spend tokens on hidden `reasoning_content` before
   any visible answer and hit `finish_reason: "length"` with empty `content`
2. Wrap the `textChat()` call in `Promise.race` against a `CHAT_TIMEOUT_MS` (60s, calibrated
   against real reasoning-model latency during rehearsal — 25s was too tight) timeout rejection
3. On truncated response (`finish_reason === 'length'`), throw a specific, actionable error
   instead of the generic "unexpected response shape" message
4. `src/engine/review.ts` `extractChangedPaths`: match both `a/` and `b/` paths from each
   `diff --git` header (rename support)
5. `src/engine/review.ts`: switch `--base` diff to `git diff base...HEAD` (three-dot / merge-base)
6. Wrap `runReview`'s DB-adapter usage in `try/finally` so `adapter.close()` always runs
7. Add `ReviewResult.notes: string[]` — populated when changed paths aren't found in the graph
8. `bin/debob.ts`: print `notes` in yellow; render "No diff found" via `chalk.dim` instead of
   `chalk.red`, and `spinner.stop()` instead of `spinner.fail()` for that specific case

**Relevant Context:**
- `src/llm/providers/watsonx.ts` — `_chat()`, `CHAT_TIMEOUT_MS`
- `src/engine/review.ts` — `extractChangedPaths`, `runReview`
- `bin/debob.ts` — `review` command's catch blocks
- Discovered live during rehearsal against this repo's own working-tree diff — not a
  hypothetical: the untimed/untokened version genuinely failed on a 5-file, 35-neighbour diff

---

### Sub-Task G — `debob explain` (Free-Text Q&A)

**Status:** `[x] done`

**Intent:**
Implement the `debob explain <question>` command, wiring the previously-stubbed
`LLMAdapter.answerQuestion` through a new keyword-overlap retrieval layer. This is the
highest-leverage new capability: it turns DeBob from "dashboards + commands a human runs" into
something an agent (or a person) can ask questions of directly.

**Expected Outcomes:**
- `src/query/index.ts` exports `findRelevantNodes(graph, question, enrichments?, limit?)`
- `src/engine/explain.ts` exports `runExplain(repoRoot, options): Promise<ExplainResult>`
- `WatsonxProvider.answerQuestion()` is implemented (was a stub)
- `debob explain "<question>"` works end-to-end, grounded in real graph data
- `ExplainResult`/`ExplainOptions` exported from `src/types/index.ts`
- Rehearsed against this repo with real questions (e.g. "what does the scanner do?")

**Todo List:**
1. `src/query/index.ts`: add `findRelevantNodes` — tokenizes the question (lowercase,
   stopword-stripped), scores each node against `id`/`name`/`type`/`layer` (weight 1) and cached
   `semantic_enrichments` `responsibility` text (weight 2), returns the top-N non-zero scores.
   Deliberately keyword-based, not embeddings — deterministic and explainable, matching the
   project's "every inference traceable" philosophy
2. `src/engine/explain.ts`: `runExplain` — open DB (throw if missing, same as `review.ts`),
   read graph + all `semantic_enrichments`, call `findRelevantNodes`, join cached
   `responsibility` text onto the matched nodes (`Node.responsibility` itself is never populated
   in the persisted graph — only `semantic_enrichments` is), collect edges via `getNodeEdges`,
   build `QueryContext`, call `llm.answerQuestion()`. `try/finally` around `adapter.close()`
3. `src/llm/providers/watsonx.ts`: implement `answerQuestion()` — prompt lists relevant nodes
   (id, type, layer, responsibility) and edges ("A --imports--> B"), system message enforces
   "graph metadata only, no raw source, say so if the data is insufficient"
4. `bin/debob.ts`: add `explain <question>` command (positional arg); extract the
   previously-triplicated LLM credential-resolution block (`init`/`update`/`review`) into a
   single `resolveLLMAdapter(mode: 'warn' | 'error')` helper and reuse it in all four commands
5. Add `ExplainResult`/`ExplainOptions` to `src/types/index.ts`
6. Fix stale JSDoc on `LLMAdapter.explainDiff`/`answerQuestion` in `src/llm/adapter.ts` — both
   said "future command — not yet implemented"; also document that `DiffContext.diff` (raw
   unified diff) is the one deliberate exception to "never send raw source"

**Relevant Context:**
- `src/llm/adapter.ts` — `QueryContext` type (already defined, unused until now)
- `src/persistence/interface.ts` — `SemanticEnrichment`
- Answering "what does the scanner do?" during rehearsal surfaced a real, separate bug in the
  TS analyzer's import resolution — see Sub-Task H

---

### Sub-Task H — Fix `.js`-suffixed Relative Import Resolution (TS Analyzer)

**Status:** `[x] done`

**Intent:**
Discovered via `debob explain` rehearsal, not code review: this codebase (and any ESM-TS
project) imports relative modules with the compiled extension (`import { X } from
'../scanner/index.js'`) even though the file on disk is `.ts`. `resolveImportTarget` in the TS
analyzer only extension-probed when the specifier had **no** extension at all — a specifier
ending in `.js` skipped the probe entirely and resolved to a literal, non-existent `.js` path,
creating a disconnected phantom stub `file` node for every relative import in the entire
codebase. This fragmented the graph badly enough that `debob explain "what does the scanner
do?"` answered partly from a fake "index.js — placeholder, no implementation" stub instead of
the real, fully-analyzed `index.ts` node.

**Expected Outcomes:**
- Relative imports ending in `.js`/`.jsx`/`.mjs`/`.cjs` resolve to the real `.ts`/`.tsx`/`.mts`/
  `.cts` source file when a literal file of that name doesn't exist on disk
- A literal `.js` file (plain-JS projects) still resolves to itself, unchanged
- Re-running `debob update` on this repo no longer produces `index.js`-style phantom nodes for
  files that are actually `.ts`

**Todo List:**
1. `src/analyzers/typescript/index.ts`: add `COMPILED_TO_SOURCE_EXT` map (`.js` → `.ts`/`.tsx`,
   `.jsx` → `.tsx`, `.mjs` → `.mts`, `.cjs` → `.cts`)
2. In `resolveImportTarget`, before the existing no-extension probe: if the specifier's
   extension is a compiled extension, check the literal path first (real `.js` file wins if it
   exists), otherwise probe the mapped source extensions and return the first that exists on disk
3. Verified via `debob update` on this repo — re-analyzed files no longer generate `.js` stub
   nodes for internal modules

**Relevant Context:**
- `src/analyzers/typescript/index.ts` — `resolveImportTarget`
- This is the most severe correctness bug found this session — it affected essentially every
  relative import in DeBob's own self-analysis, since the whole codebase uses this import style

---

### Sub-Task I — Agent-Discoverable Instructions (`AGENTS.md` Auto-Block)

**Status:** `[x] done`

**Intent:**
The actual mechanism behind DeBob's core pitch — "`debob init`, then any agent knows what to
do" — didn't exist before this. `.bob/skills/debob-query/SKILL.md` only fires for the "Bob"
product specifically, and the root `AGENTS.md` (the cross-agent convention Claude Code, Cursor,
Codex, etc. auto-load) never mentioned the graph at all. Make `debob init`/`debob update` write
a delimited, idempotent block into the repo's root `AGENTS.md` that tells any agent to prefer
`debob explain`/`debob review` over reading raw source.

**Expected Outcomes:**
- `src/engine/agentInstructions.ts` exports `writeAgentInstructions(repoRoot, manifest)`
- Called at the end of both `runInit` and `runUpdate`, wrapped in try/catch (non-fatal — a
  write failure here must never abort the structural pipeline)
- Creates `AGENTS.md` if absent; regenerates only the `<!-- DEBOB:START -->...<!-- DEBOB:END -->`
  marked region if present, leaving the rest of a hand-written file untouched
- Block content leads with the CLI (`debob explain`/`debob review`), not internal APIs — any
  agent with shell access can use it without understanding DeBob's TypeScript internals
- Verified on this repo: `debob update` appended the block to the existing root `AGENTS.md`
  without disturbing its existing content

**Todo List:**
1. `src/engine/agentInstructions.ts`: `buildBlock(manifest)` — states the graph exists, gives
   `debob explain`/`debob review` usage examples, a staleness-check one-liner
   (`manifest.headCommit` vs `git rev-parse HEAD`), and a pointer to
   `.bob/skills/debob-query/SKILL.md` for advanced/raw queries
2. `writeAgentInstructions(repoRoot, manifest)`: create-or-splice logic using `BLOCK_START`/
   `BLOCK_END` markers
3. Wire into `src/engine/index.ts`: extract the manifest object literal to a `manifestData`
   variable in both `runInit` and `runUpdate` (was inline before), call `writeManifest` then
   `writeAgentInstructions` inside try/catch, log the outcome either way

**Relevant Context:**
- `src/persistence/sqlite.ts` — `Manifest` type (reused, not duplicated)
- `.bob/skills/debob-query/SKILL.md` — kept as the power-user fallback, referenced from the block
- This repo's own root `AGENTS.md` still has a stale "What Is NOT Implemented Yet (Sub-Tasks
  7–11)" section from before Sub-Tasks 7-11 shipped — worth a manual cleanup pass separate from
  the auto-generated block, which only manages its own marked region

---

### Sub-Task J — Python Analyzer, Auto-Update Hook, Team-Sharing Docs

**Status:** `[x] done`

**Intent:**
Three smaller, independent demo-value items: prove the `LanguageAnalyzer` interface is
genuinely language-agnostic (not TS-only), offer a zero-friction way to keep the graph current,
and document the tradeoffs of sharing `.debob/` across a team.

**Expected Outcomes:**
- `src/analyzers/python/index.ts` implements `LanguageAnalyzer` for `.py` files: imports
  (absolute → `pkg::` stub, relative `from .foo import x` → filesystem-resolved), `function`/
  `class` nodes (including nested methods). Deliberately no base-class edges — the TS analyzer's
  unqualified extends/implements targets create phantom stub nodes for colliding names; skipped
  here rather than inherited into a second language
- `.py` registered in the scanner (`TEXT_EXTENSIONS`, `detectLanguage`) and the engine's
  analyzer registry
- `githooks/post-commit`: opt-in (`git config core.hooksPath githooks`), runs `debob update` in
  the background after every commit, never blocks the commit
- README documents: the `explain` command, the `AGENTS.md` mechanism, language support scope,
  team-sharing tradeoffs for committing `.debob/`, and the post-commit hook

**Todo List:**
1. `src/analyzers/python/index.ts`: grammar node names verified empirically (not guessed) via a
   throwaway AST dump script against `tree-sitter-python.wasm` — `import_statement` /
   `import_from_statement` / `relative_import` (with `import_prefix` dot-count + optional
   `dotted_name` submodule) / `function_definition` / `class_definition`, `name` as a proper
   tree-sitter field on both definition types
2. Relative-import resolution mirrors the TS analyzer's probe-then-fallback-to-stub pattern:
   try `<path>.py` then `<path>/__init__.py`
3. `src/scanner/types.ts` + `src/scanner/index.ts`: add `'python'` to `ScannedFile['language']`,
   `PYTHON_EXTENSIONS`, `.py` in `TEXT_EXTENSIONS`
4. `src/engine/index.ts` `buildAnalyzerRegistry`: register `PythonAnalyzer` alongside
   `TypeScriptAnalyzer`
5. `githooks/post-commit`: guarded (`exit 0` if not a repo or `.debob/context.db` doesn't exist
   yet — never force-inits a repo that hasn't opted in), backgrounds `debob update` with output
   redirected to `.git/debob-update.log`, always exits 0 immediately
6. README: new "Sharing the graph with your team" and "Keeping it current automatically"
   subsections under "What Gets Built"; new "Language support" subsection; `explain` command
   documented in both the walkthrough and the Commands reference; "How AI Agents Use DeBob"
   rewritten to lead with the `AGENTS.md` auto-block mechanism instead of raw SQL-shaped examples

**Relevant Context:**
- `src/analyzers/interface.ts` — `LanguageAnalyzer` (no changes needed — validates the interface
  was designed correctly the first time)
- Rehearsed end-to-end against a scratch mixed-language repo (`.py` + `.md`) — `debob init`
  produced correct node/edge counts (verified by hand: 4 file nodes + 4 symbol nodes including a
  nested method + 2 package nodes = 10 nodes; import edges deduplicated correctly when two
  different import statements resolved to the same target file)
- Hook tested by direct invocation (not by setting `core.hooksPath` on this repo, per the "never
  change git config without being asked" rule) — confirmed it returns immediately and the
  backgrounded update completes and logs successfully

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
