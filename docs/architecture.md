# DeBob — Architecture Reference

> This document is the canonical reference for DeBob's design.  
> It is accurate as of **Sub-Task 11** (all 11 sub-tasks complete).  
> Sections marked **[future]** describe planned work that is not yet implemented.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Core Principle](#2-core-principle)
3. [Component Responsibilities](#3-component-responsibilities)
4. [Graph Model](#4-graph-model)
5. [`.debob/` Schema](#5-debob-schema)
6. [Incremental Update Design](#6-incremental-update-design)
7. [LLM Architecture](#7-llm-architecture)
8. [How to Add a Language Analyzer](#8-how-to-add-a-language-analyzer)
9. [How to Add an LLM Provider](#9-how-to-add-an-llm-provider)
10. [How `debob review` Will Be Built](#10-how-debob-review-will-be-built)

---

## 1. System Overview

DeBob is a **persistent repository-understanding and context system** for AI coding agents.

It runs inside any Git repository and produces `.debob/context.db` — a SQLite database containing a typed, queryable **knowledge graph** of the codebase. The graph is built from three deterministic sources:

| Source | What it contributes |
|---|---|
| **Static AST analysis** | File nodes, symbol nodes (functions, classes, interfaces), import/export/extends/implements edges |
| **Git history** | Commit records, per-file churn scores, author counts, hot-file markers |
| **LLM enrichment** *(optional)* | Module responsibility summaries, architectural layer classifications |

The LLM **never receives raw source files**. It receives only structured `ModuleContext` slices assembled from graph data.

---

## 2. Core Principle

```
Repository source files
  → deterministic static analysis (tree-sitter AST)     confidence: 1.0, dataSource: "static"
  → git history extraction (simple-git)                 confidence: 1.0, dataSource: "git"
  → graph builder (merge + deduplicate)
  → SQLite persistence (.debob/context.db)
  → targeted context retrieval (query layer)
  → optional LLM semantic enrichment                    confidence: <1.0, dataSource: "llm"
      ↳ input: ModuleContext slice (never full source)
      ↳ output: responsibility string, layer label
      ↳ stored: semantic_enrichments table
```

**Static facts and LLM-inferred facts are kept completely separate.** Static facts (`dataSource: "static"` / `"git"`) live in the `nodes` and `edges` tables. LLM outputs live exclusively in `semantic_enrichments`. This separation means:

- Re-running `debob init` without `--semantic` never overwrites LLM enrichments.
- Consumers can always query the provenance of every piece of information.
- The graph is useful without any LLM credentials.

---

## 3. Component Responsibilities

### `bin/debob.ts` → `dist/bin/debob.js`

The CLI entry point. Uses `commander` for command parsing, `ora` for spinners, and `chalk` for colored output.

- Parses `--repo`, `--max-commits`, `--semantic`, `--verbose` options
- Resolves `WATSONX_*` env vars when `--semantic` is set; warns and skips LLM if any are missing
- Calls `runInit()` from the engine and renders a human-readable summary
- Exit code 0 on success, non-zero on error

### `src/engine/index.ts` — Core Engine Orchestrator

`runInit(repoRoot, options): Promise<InitResult>`

Runs the full analysis pipeline in sequence:

1. Validate repo root (must exist and contain `.git/`)
2. `scanRepository()` — discover source files
3. `TypeScriptAnalyzer.create()` + `analyzer.analyze()` — static AST extraction
4. `extractGitMetadata()` — commit history and file stats
5. `buildGraph()` — merge all sources into a deduplicated graph
6. `openDb()` + `SqlitePersistenceAdapter` — persist to `.debob/context.db`
7. *(optional)* LLM enrichment via `buildModuleContext()` + `llm.summarizeModule()` / `llm.classifyLayer()`
8. `adapter.close()` — **required**: sql.js does not save to disk without this call
9. `writeManifest()` — write `.debob/manifest.json`
10. Return `InitResult` with counts, hot files, layer distribution, package deps, db path

The engine never imports `sql.js` directly — it always goes through `PersistenceAdapter`.

### `src/scanner/index.ts` — Repository Scanner

`scanRepository(repoRoot, options): Promise<ScannedFile[]>`

Discovers files using four layered exclusion guards (cheapest-first):

| Guard | Mechanism |
|---|---|
| 1. Default ignore globs | `node_modules`, `.git`, `dist`, `build`, `*.min.js`, `*.d.ts`, etc. |
| 2. `.gitignore` / `.debobignore` | Parsed by the `ignore` package (gitignore syntax) |
| 3. `TEXT_EXTENSIONS` allowlist | Skip files with unrecognized extensions (binary/font/WASM/zip) |
| 4. `MAX_FILE_BYTES` cap | Files > 1 MB are skipped before `readFileSync` |

Each `ScannedFile` includes `path` (absolute), `relativePath`, `extension`, `language`, and `contentHash` (SHA-256).

### `src/analyzers/typescript/index.ts` — TypeScript/JS Analyzer

`TypeScriptAnalyzer.create(repoRoot): Promise<TypeScriptAnalyzer>`  
`analyzer.analyze(filePath, source): AnalysisResult`

Uses `web-tree-sitter@0.22.6` (WASM, no native build) with `tree-sitter-wasms@0.1.13` grammar files.

Extracts from each file:
- **File node** — one per file
- **Symbol nodes** — `class_declaration`, `function_declaration`, `interface_declaration`
- **Import edges** — from `import_statement` nodes (note: **not** `import_declaration`)
- **Export edges** — from `export_statement` nodes
- **Extends/implements edges** — from `class_heritage`, `extends_clause`, `implements_clause`, `extends_type_clause`

> **Critical**: `web-tree-sitter` is pinned to exact `"0.22.6"`. `tree-sitter-wasms@0.1.13` uses tree-sitter ABI 14. `web-tree-sitter@0.26.x` uses ABI 15 — they are incompatible. Do not upgrade.

### `src/git/index.ts` — Git Metadata Extractor

`extractGitMetadata(repoRoot, options): Promise<GitMetadata>`

Uses `simple-git` to walk up to `maxCommits` (default: 500) commits. Returns:
- `commits[]` — hash, author name, **SHA-256-hashed email** (never plaintext), date, subject, files changed
- `fileStats[]` — per-file commit count, churn score (= commit count), unique author count, last modified date
- `headCommit` — current HEAD hash, stored in `file_cache` for incremental diff

Author emails are hashed with SHA-256 before storage. Raw emails are never written to `.debob/`.

### `src/graph/builder.ts` — Graph Builder

`buildGraph(files, analysisResults, gitMetadata): Graph`

Pure function (no I/O). Merges all sources into a single `Graph`:

1. Seed one file node per `ScannedFile`
2. Merge analyzer nodes — symbol nodes win over bare file nodes on id collision
3. Merge analyzer edges — deduped by deterministic edge id
4. Attach git metadata (`churnScore`, `lastModifiedAt`, `authorCount`) and `contentHash` to file nodes
5. Mark top-10% churn file nodes as `metadata.hot = true`
6. Stub any edge endpoint that has no corresponding node (creates a minimal placeholder)

### `src/persistence/` — Persistence Layer

Three layers:

| File | Role |
|---|---|
| `interface.ts` | `PersistenceAdapter` interface — the only thing the engine knows about |
| `schema.ts` | `SCHEMA_DDL` (all `CREATE TABLE IF NOT EXISTS` statements) + `SCHEMA_VERSION = 1` |
| `sqlite.ts` | `SqlitePersistenceAdapter`, `openDb()`, `writeManifest()`, `readManifest()` |

`sql.js` is in-memory only. **Always call `adapter.close()`** after mutations — without it, nothing is written to disk.

### `src/query/index.ts` — Graph Query Helpers

Helper functions used by the context builder and future query layer:

| Function | Description |
|---|---|
| `getNodeEdges(graph, nodeId)` | All edges touching this node (in or out) |
| `getFileImports(graph, filePath)` | Targets of outgoing `imports` edges |
| `getFileExports(graph, filePath)` | Targets of outgoing `exports` edges |
| `getNodeNeighbours(graph, nodeId, depth)` | BFS traversal both directions up to `depth` hops |
| `buildModuleContext(node, graph)` | Assemble a `ModuleContext` slice (also in `src/llm/context.ts`) |

### `src/llm/` — LLM Layer

| File | Role |
|---|---|
| `adapter.ts` | `LLMAdapter` interface + `LLMConfig`, `ModuleContext`, `DiffContext`, `QueryContext` types |
| `context.ts` | `buildModuleContext(node, graph, gitStats?)` — assembles the LLM input slice |
| `index.ts` | `createLLMAdapter(provider, config)` factory — routes to concrete implementation |
| `providers/watsonx.ts` | `WatsonxAdapter` — IBM watsonx REST API implementation |

---

## 4. Graph Model

### Node

```ts
interface Node {
  id: string           // File: relativePath. Symbol: "relativePath::SymbolName". Package: "pkg::name"
  type: NodeType       // "file" | "function" | "class" | "interface" | "variable" | "route" | "package"
  name: string
  filePath: string     // Relative path from repo root
  startLine?: number
  endLine?: number
  layer?: ArchitecturalLayer  // Heuristic or LLM-inferred
  responsibility?: string     // LLM-generated summary
  confidence: number   // 1.0 = deterministic; <1.0 = LLM inference
  dataSource: DataSource  // "static" | "git" | "llm"
  metadata?: Record<string, unknown>
    // File nodes: { churnScore, lastModifiedAt, authorCount, contentHash, hot }
    // Stub nodes: { stub: true }
}
```

### Edge

```ts
interface Edge {
  id: string     // "${source}::${type}::${target}" — deterministic, dedup-safe
  source: string
  target: string
  type: EdgeType
  confidence: number
  dataSource: DataSource
  metadata?: Record<string, unknown>
}
```

### NodeType (string union)

```
"file" | "function" | "class" | "interface" | "variable" | "route" | "package"
```

### EdgeType (string union)

```
"imports" | "exports" | "calls" | "depends_on" | "extends" | "implements"
"instantiates" | "exposes" | "handles" | "tests" | "reads_from" | "writes_to"
"communicates_with" | "configured_by" | "related_to"
```

### ArchitecturalLayer

```
"presentation" | "business" | "data" | "config" | "test" | "infra"
```

### ID Conventions

| Node kind | ID format | Example |
|---|---|---|
| File | `relativePath` | `src/services/auth.ts` |
| Symbol | `"relativePath::SymbolName"` | `src/services/auth.ts::AuthService` |
| Package | `"pkg::packageName"` | `pkg::express` |

Edge ID: `"${sourceId}::${edgeType}::${targetId}"` — fully deterministic, safe to use as upsert key.

---

## 5. `.debob/` Schema

`.debob/context.db` is a SQLite database created by `sql.js` (WASM — no native build required).

### `nodes` table

```sql
CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  start_line      INTEGER,
  end_line        INTEGER,
  layer           TEXT,
  responsibility  TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  data_source     TEXT NOT NULL DEFAULT 'static',
  metadata_json   TEXT
);
```

### `edges` table

```sql
CREATE TABLE IF NOT EXISTS edges (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  target          TEXT NOT NULL,
  type            TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  data_source     TEXT NOT NULL DEFAULT 'static',
  metadata_json   TEXT
);
```

### `git_commits` table

```sql
CREATE TABLE IF NOT EXISTS git_commits (
  hash              TEXT PRIMARY KEY,
  author_name       TEXT NOT NULL,
  author_email_hash TEXT NOT NULL,  -- SHA-256 hex; raw email never stored
  date              TEXT NOT NULL,
  subject           TEXT NOT NULL,
  files_changed_json TEXT NOT NULL
);
```

### `git_file_stats` table

```sql
CREATE TABLE IF NOT EXISTS git_file_stats (
  file_path        TEXT PRIMARY KEY,
  commit_count     INTEGER NOT NULL DEFAULT 0,
  churn_score      REAL NOT NULL DEFAULT 0,
  author_count     INTEGER NOT NULL DEFAULT 0,
  last_modified_at TEXT NOT NULL
);
```

### `file_cache` table

```sql
CREATE TABLE IF NOT EXISTS file_cache (
  file_path        TEXT PRIMARY KEY,
  content_hash     TEXT NOT NULL,    -- SHA-256 of file content at analysis time
  analyzer_version TEXT NOT NULL,    -- e.g. "ts-1.0"
  schema_version   INTEGER NOT NULL,
  last_analyzed_at TEXT NOT NULL,
  last_git_commit  TEXT NOT NULL     -- HEAD hash at analysis time
);
```

### `semantic_enrichments` table

```sql
CREATE TABLE IF NOT EXISTS semantic_enrichments (
  node_id      TEXT NOT NULL,
  field        TEXT NOT NULL,     -- "responsibility" | "layer"
  value        TEXT NOT NULL,
  llm_provider TEXT NOT NULL,     -- e.g. "watsonx"
  model_id     TEXT NOT NULL,     -- e.g. "ibm/granite-13b-instruct-v2"
  created_at   TEXT NOT NULL,
  PRIMARY KEY (node_id, field)
);
```

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes (file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes (type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges (type);
CREATE INDEX IF NOT EXISTS idx_semantic_node ON semantic_enrichments (node_id);
```

### `manifest.json`

Written alongside `context.db` after each `debob init` run:

```json
{
  "version": "0.1.0",
  "schemaVersion": 1,
  "initAt": "2024-01-01T00:00:00.000Z",
  "repoPath": "/absolute/path/to/repo",
  "nodeCount": 142,
  "edgeCount": 310,
  "fileCount": 38,
  "commitCount": 214,
  "semantic": false
}
```

---

## 6. Incremental Update Design

> **[future]** `debob update` is not yet implemented. This section describes the design that `file_cache` was built to support.

The `file_cache` table makes incremental re-analysis possible without rescanning unchanged files.

**On `debob update` (future command):**

1. Read all `file_cache` entries from `.debob/context.db`
2. Scan the repository (same guards as `debob init`)
3. For each file, check three conditions:
   - `contentHash` has changed (file was edited)
   - `analyzerVersion` differs (analyzer was upgraded)
   - `schemaVersion` differs (schema was migrated)
4. Re-analyze only files that fail any check; copy existing nodes/edges for unchanged files
5. Run git extraction only for commits newer than `lastGitCommit`
6. Rebuild graph from merged old + new analysis results
7. Persist and close

**Schema migration:** When `SCHEMA_VERSION` in `src/persistence/schema.ts` is incremented, all `file_cache` entries have a stale `schema_version` and will be re-analyzed on the next `debob update`.

**Analyzer upgrade:** Changing `TypeScriptAnalyzer.version` (e.g. `"ts-1.0"` → `"ts-1.1"`) causes all cached TypeScript files to be re-analyzed.

---

## 7. LLM Architecture

### The Core Constraint

> **The LLM never receives raw source code.**

The context builder (`src/llm/context.ts`) assembles a `ModuleContext` slice for each file node using only graph-derived data:

```ts
interface ModuleContext {
  filePath: string                    // relative path
  imports: string[]                   // targets of outgoing "imports" edges
  exports: string[]                   // targets of outgoing "exports" edges
  declarations: Array<{               // symbol nodes belonging to this file
    name: string
    type: 'function' | 'class' | 'interface' | 'variable'
    startLine?: number
  }>
  gitStats?: {                        // from node.metadata / GitFileStats
    churnScore: number
    authorCount: number
    lastModifiedAt: string
  }
}
```

This slice is what `WatsonxAdapter.summarizeModule()` and `WatsonxAdapter.classifyLayer()` receive. No source content, no file paths embedded in strings, no raw AST.

### LLM Adapter Interface

```ts
interface LLMAdapter {
  summarizeModule(context: ModuleContext): Promise<string>
  classifyLayer(context: ModuleContext): Promise<string>
  explainDiff(context: DiffContext): Promise<string>      // [future] debob review
  answerQuestion(context: QueryContext): Promise<string>  // [future] debob explain
}
```

### WatsonxAdapter

`src/llm/providers/watsonx.ts`

- REST endpoint: `POST {endpoint}/ml/v1/text/generation?version=2023-05-29`
- Request body: `{ "model_id": "...", "project_id": "...", "input": "...", "parameters": { "max_new_tokens": 256 } }`
- Auth: `Authorization: Bearer {apiKey}`
- Default model: `ibm/granite-13b-instruct-v2`
- Prompt format: structured plain text listing file path, imports, exports, declarations, and optional git stats — never source code

### Semantic Enrichment Storage

LLM outputs are upserted into `semantic_enrichments` with full provenance:

```
(node_id, field) → (value, llm_provider, model_id, created_at)
```

Re-running `debob init --semantic` overwrites existing enrichments in place (upsert on primary key `(node_id, field)`).

### Provider Configuration (env vars only)

```bash
WATSONX_API_KEY=...
WATSONX_PROJECT_ID=...
WATSONX_ENDPOINT=https://us-south.ml.cloud.ibm.com
```

Credentials are **never** stored in `.debob/`, prompted for interactively, or read from any config file.

---

## 8. How to Add a Language Analyzer

Adding support for a new language (e.g. Python) requires only two steps:

### Step 1 — Implement `LanguageAnalyzer`

Create `src/analyzers/python/index.ts`:

```ts
import type { LanguageAnalyzer, AnalysisResult } from '../interface.js'

export class PythonAnalyzer implements LanguageAnalyzer {
  readonly language = 'python'
  readonly extensions = ['.py', '.pyw']
  readonly version = 'py-1.0'

  analyze(filePath: string, source: string): AnalysisResult {
    // Parse source, extract nodes and edges.
    // All returned nodes/edges MUST have confidence: 1.0 and dataSource: "static".
    return { nodes: [], edges: [] }
  }
}
```

**Constraints for all analyzers:**
- `analyze()` must be **synchronous**
- Every returned node/edge must carry `confidence: 1.0` and `dataSource: "static"`
- Node ids follow the conventions: file = `relativePath`, symbol = `"relativePath::SymbolName"`
- Edge ids follow: `"${sourceId}::${edgeType}::${targetId}"`

If using `web-tree-sitter`: load the WASM grammar in a separate async `create()` factory (see `TypeScriptAnalyzer` for the pattern).

### Step 2 — Register the extensions in `buildAnalyzerRegistry`

In `src/engine/index.ts`, inside `buildAnalyzerRegistry()`:

```ts
import { PythonAnalyzer } from '../analyzers/python/index.js'

async function buildAnalyzerRegistry(repoRoot: string): Promise<Map<string, LanguageAnalyzer>> {
  const registry = new Map<string, LanguageAnalyzer>()

  const tsAnalyzer = await TypeScriptAnalyzer.create(repoRoot)
  for (const ext of tsAnalyzer.extensions) registry.set(ext, tsAnalyzer)

  // Add Python
  const pyAnalyzer = new PythonAnalyzer()
  for (const ext of pyAnalyzer.extensions) registry.set(ext, pyAnalyzer)

  return registry
}
```

That is the only change needed. The engine routes each file to its analyzer by extension.

---

## 9. How to Add an LLM Provider

### Step 1 — Implement `LLMAdapter`

Create `src/llm/providers/openai.ts` (example):

```ts
import type { LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext } from '../adapter.js'

export class OpenAIAdapter implements LLMAdapter {
  readonly provider = 'openai'
  readonly modelId: string

  constructor(config: LLMConfig) {
    // validate required fields
    this.modelId = config.modelId ?? 'gpt-4o'
  }

  async summarizeModule(context: ModuleContext): Promise<string> {
    // Build a structured prompt from context (never raw source).
    // Call the OpenAI completions API.
  }

  async classifyLayer(context: ModuleContext): Promise<string> { ... }

  async explainDiff(context: DiffContext): Promise<string> {
    throw new Error('OpenAIAdapter.explainDiff: not yet implemented')
  }

  async answerQuestion(context: QueryContext): Promise<string> {
    throw new Error('OpenAIAdapter.answerQuestion: not yet implemented')
  }
}
```

**Rule:** Prompts must be built from `ModuleContext` fields only — never embed raw source.

### Step 2 — Register in `createLLMAdapter`

In `src/llm/index.ts`:

```ts
import { OpenAIAdapter } from './providers/openai.js'

export function createLLMAdapter(provider: string, config: LLMConfig): LLMAdapter {
  switch (provider) {
    case 'watsonx': return new WatsonxAdapter(config)
    case 'openai':  return new OpenAIAdapter(config)
    default: throw new Error(`createLLMAdapter: unknown provider "${provider}"`)
  }
}
```

No other changes needed.

---

## 10. How `debob review` Will Be Built

> **[future]** `debob review` is not yet implemented. This section describes the intended design.

`debob review` will diff the working tree (or a specified commit range) against the stored graph to produce an LLM-generated impact analysis.

**Planned pipeline:**

1. Capture the unified diff (`git diff HEAD` or a supplied range)
2. Parse affected file paths from the diff header lines
3. Look up those file nodes in `context.db` via `readGraph()`
4. Use `getNodeNeighbours(graph, nodeId, depth=2)` to find the neighbourhood (direct callers, direct dependencies)
5. Assemble a `DiffContext`:
   ```ts
   { diff, affectedNodes, neighbourhood, layersSummary }
   ```
6. Call `llm.explainDiff(context)` — which `WatsonxAdapter` will implement at that point
7. Render the output with `chalk`

The `DiffContext` type is already defined in `src/llm/adapter.ts`. The `getNodeNeighbours` traversal helper is already implemented in `src/query/index.ts`. The foundation is in place; only the CLI command and `explainDiff` implementation remain.

---

*This document was generated as part of Sub-Task 11 and reflects the state of the codebase after all 11 sub-tasks are complete.*
