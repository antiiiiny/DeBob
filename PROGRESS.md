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

## Visualiser Clutter/Grouping/Edge-Detail Fix — ✅ done & browser-verified

User feedback on `debob visualise`: the graph rendered as a dense unreadable hairball, edges
showed no information on hover or click, and there was no way to visually separate nodes into
groups/regions. Then, after the first grouping attempt: with "Group by folder"/"Group by layer"
on, a thin line of nodes strung across the top of the canvas while the real cluster was squeezed
into a corner of a mostly-empty void. All of it is in `src/visualiser/server.ts` (the only file
involved — a small Node HTTP server + one inline Cytoscape.js HTML/JS template string, no
separate frontend build).

**What landed:**
- Edge interactivity: hover shows a floating tooltip (`#edge-tooltip`), clicking an edge
  populates the Node Inspector panel via `showEdgeInspector()`. Verified working.
- Region grouping: a `#group-by` dropdown (None / Folder / Layer) computes a `region` per node
  (`folderRegionFor`/`layerRegionFor`) and assigns it as a Cytoscape compound-node `parent`, so
  nodes render inside labeled, dashed-border boxes. Only regions with >1 member get boxed
  (`regionCounts[region.id] > 1`) — a singleton's sole node stays an ordinary top-level node.
- **Root cause of the stray-line/void layout (fixed):** two independent problems compounding.
  1. **The compound-aware layout was never actually loading.** `cytoscape-fcose@2` and then
     `cytoscape-cose-bilkent@4` both threw `Cannot read properties of undefined (reading
     'layoutBase')` on load. A previous session diagnosed this as a bug in the packages'
     published UMD builds. **That diagnosis was wrong.** Both ship as webpack UMD bundles that
     *externalise* their dependencies rather than inlining them, so the dependency chain must be
     loaded first, in order: `layout-base` (global `layoutBase`) → `cose-base` (global
     `coseBase`) → `cytoscape-fcose` (global `cytoscapeFcose`). A lone `<script>` tag for the
     extension can never work. With all three tags present fcose loads and registers fine.
     Because the load silently failed, the `try/catch` fell through to plain `cose` — which is
     **not** compound-node-aware — and that is what produced the bad layout. Confirmed by
     `window.__debobLayoutName` reading `'cose'` in a live browser while the code "used"
     cose-bilkent.
  2. **Nearly every symbol node is a 0-degree orphan.** The V1 analyzers emit no `calls` edges,
     and `exports` edges only for *re-exports* (`export { x } from '...'`) — a plain
     `export function foo() {}` produces no edge at all. Measured on this repo: 95 of 162 nodes
     had zero edges. Free-floating, the layout's `tile: true` grid-packs those neatly; but once
     region grouping gives them a compound parent they stop being tileable and each region
     degenerates into a spread-out blob. Fix: `setupGraph` now synthesises an invisible
     **structural anchor edge** from each file node to every symbol declared in it (class
     `edge-structural`, no `type` data field, `opacity: 0`, `events: 'no'`). They are
     layout-only — never added to the `/api/graph` payload, never shown, and excluded from every
     edge handler and from the edge-type filters.
- Edge handlers select real edges via **`'edge[type]'`** (absence of a data field), *not*
  `'edge:not(.edge-structural)'` — cytoscape has no `:not()` pseudo-class and logs
  "The selector ... is invalid" for it while still firing the handler.
- Style selectors scoped to `node[diameter]` and `edge[edgeColor]` so region/structural elements
  don't each emit a pair of "no mapping for property" warnings (was 820 warnings, now 0).
- `cy.elements().stop(true)` before `cy.destroy()` on a grouping change — an async layout that
  ticks after its instance is destroyed throws `Cannot read properties of null (reading
  'isHeadless')` onto the page (was 33 page errors per session, now 0).
- Region labels: `font-size: 26`, `min-zoomed-font-size: 0`. Grouped mode fits at ~0.4–0.55
  zoom, where the base `min-zoomed-font-size: 8` hid the region labels entirely — i.e. the one
  thing grouping exists to show.
- `cy.fit()` on `layoutstop` so the graph is always framed to the viewport.

**Measured before → after** (this repo, 162 nodes/117 edges, 1040×882 canvas, via Playwright):

| Mode | Node bbox before | Zoom before | Node bbox after | Zoom after |
|---|---|---|---|---|
| Group by folder | 27985 × 6571 | 0.034 | 1629 × 1549 | 0.518 |
| Group by layer | 22286 × 16121 | 0.042 | 2288 × 1552 | 0.420 |
| No grouping | 1419 × 1383 | 0.565 | 1384 × 1145 | 0.694 |

Nodes stranded in the top 10% band of the canvas (the "stray line" symptom) went from 21% to 3%
in folder mode. Page errors 33 → 0, console warnings 820 → 1 (an intentional
`wheelSensitivity` notice). Edge hover-tooltip and click-to-inspect re-verified working.

**Verification tooling (kept, gitignored, NOT in package.json):**
- `playwright` is installed in `node_modules` via `npm install --no-save playwright` +
  `npx playwright install chromium`. Deliberately absent from `package.json` — a plain
  `npm install`/`npm ci` will drop it, and the two scripts below then fail until it's
  reinstalled. This is throwaway local tooling, not a project test dependency.
- `_test_visualiser_serve.mjs` — starts `startVisualiserServer` directly, skipping the CLI's
  `open()` browser auto-launch, so headless checks don't pop a window each run.
- `_test_visualiser_check.mjs` — drives headless Chromium against `http://localhost:7842`,
  screenshots all three grouping modes, and reports `window.__debobLayoutName`, node bounding
  box/zoom/top-band concentration, structural-edge count and opacity, and every console message
  and page error. Reaches the cytoscape instance via `document.getElementById('cy')._cyreg.cy`
  (it's otherwise closure-scoped).
- **Known gotcha, still true:** stopping a `debob visualise` background task via the agent
  harness's task-stop mechanism does **not** reliably kill the Node child process on Windows.
  Orphaned servers bound to 7842–7845 simultaneously, each serving a different stale build,
  produce deeply confusing false negatives. Always `netstat -ano | grep ':784[0-9]'` +
  `taskkill //F //PID <pid> //T`, and confirm the fresh process's own stdout
  (`Graph visualiser running at http://localhost:<port>`) before pointing a test at a port.

**Not done (deliberately deferred):** re-verification against the large repo the original
hairball report came from (nextjs-monorepo-example, ~483 nodes, at
`../Test-project-1/nextjs-monorepo-example`). Scoped to this repo's own graph by request.
Worth doing before relying on this at that scale.

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
| LLM (V1) | IBM watsonx.ai SDK `@ibm-cloud/watsonx-ai@^1.7` — chat API via `WatsonxProvider` |
| Browser open | `open@^10` — auto-opens browser for `debob visualise` |

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
| 5 | TypeScript/JS Static Analyzer | ✅ done (+ fix: `.js`-suffixed relative import resolution, Sub-Task H) |
| 6 | Git Metadata Extractor | ✅ done |
| 7 | Graph Builder | ✅ done |
| 8 | Core Engine Orchestrator | ✅ done |
| 9 | CLI Entry Point | ✅ done |
| 10 | LLM Adapter + watsonx + Context Builder | ✅ done |
| 11 | Architecture Documentation | ✅ done |
| A–E | `debob update`, layer propagation, Bob query skill, `debob review`, rules cleanup | ✅ done (see `debob-impl-plan.md`) |
| F | Harden `debob review` (timeout, maxTokens, rename/three-dot diff, try/finally) | ✅ done |
| G | `debob explain` (free-text Q&A over the graph) | ✅ done |
| H | Fix `.js`→`.ts` relative import resolution bug | ✅ done |
| I | `AGENTS.md` auto-instructions (any-agent discovery mechanism) | ✅ done |
| J | Python analyzer, opt-in post-commit hook, team-sharing docs | ✅ done |

---

## Complete File Inventory

```
.gitignore                          ← dist/, node_modules/, .debob/, .env, bob_sessions/,
                                       _test_*.mjs, _test_*.ts, _scratch_*.mjs
.debobignore                        ← user-facing debob-specific ignore file (gitignore syntax)
package.json                        ← debob 0.1.0, ESM, bin: dist/bin/debob.js
                                       web-tree-sitter pinned to EXACT "0.22.6" (no caret)
                                       ignore@^5.3.2 added for scanner gitignore support
                                       @ibm-cloud/watsonx-ai@^1.7.16, open@^10.1.0 added
tsconfig.json                       ← ES2022, moduleResolution: bundler, strict
tsup.config.ts                      ← entry: bin/debob.ts + src/**, format: esm
README.md                           ← quick-start, commands (incl. explain), watsonx env vars,
                                       language support, team-sharing + auto-update hook docs
AGENTS.md                           ← root, cross-agent contributor guide; its trailing
                                       <!-- DEBOB:START/END --> block is auto-regenerated by
                                       `debob init`/`debob update` (src/engine/agentInstructions.ts)
debob-plan.md                       ← full architecture plan + all sub-task specs (1–11, F–J)
debob-impl-plan.md                  ← sub-tasks A–E specs (runUpdate, layer propagation, Bob
                                       skill, debob review, rules cleanup)
scanner-hardening-plan.md           ← completed plan: gitignore respect + binary/huge-file guards
PROGRESS.md                         ← this file
githooks/
  post-commit                       ← opt-in (git config core.hooksPath githooks): backgrounds
                                       `debob update` after every commit, never blocks the commit,
                                       no-ops if debob init hasn't been run yet

bin/
  debob.ts                          ← Full CLI: commander + chalk + ora
                                       Auto-loads .env from cwd at startup (zero-dep parser)
                                       resolveLLMAdapter(mode: 'warn'|'error'): shared credential
                                         resolution, used by init/update/review/explain
                                       init: --repo/--max-commits/--semantic/--verbose,
                                         rich summary output, error handling, exit codes
                                       visualise (alias: viz): --repo/--port, spins up
                                         local HTTP server, auto-opens browser via open
                                       update: --repo/--semantic/--verbose, incremental re-analysis
                                       review: --repo/--base/--verbose, diff impact analysis via LLM
                                       explain <question>: --repo/--verbose, free-text Q&A over
                                         the graph

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
                                       resolveImportTarget: remaps compiled-extension relative
                                         specifiers (import './foo.js') to the real .ts/.tsx
                                         source file when no literal .js exists on disk — every
                                         relative import in an ESM-TS codebase needs this
    python/
      index.ts                      ← PythonAnalyzer (same web-tree-sitter runtime, python grammar)
                                       Shallow V1: imports (absolute → pkg:: stub, relative
                                         from .foo import x → filesystem-resolved), function/class
                                         nodes incl. nested methods. No base-class edges (avoids
                                         inheriting the TS analyzer's unqualified-target stub bug)

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
    types.ts                        ← ScannedFile interface (language: ts|js|python|unknown)
    index.ts                        ← scanRepository(), summarizeByLanguage(), ScanOptions
                                       DEFAULT_IGNORE globs, TEXT_EXTENSIONS allowlist (incl. .py),
                                       MAX_FILE_BYTES (1 MB) cap, .gitignore/.debobignore filter

  llm/
    adapter.ts                      ← LLMAdapter interface + full JSDoc (ModuleContext, DiffContext,
                                       QueryContext, LLMConfig — url/modelId fields)
                                       DiffContext.diff documented as the one deliberate exception
                                       to "never send raw source" (needed to explain a diff at all)
    index.ts                        ← createLLMAdapter(provider, config): LLMAdapter factory
                                       wires "watsonx" → WatsonxProvider
                                       exports WatsonxProvider + WatsonxAdapter (alias)
    context.ts                      ← buildModuleContext(node, graph, gitStats?): ModuleContext
                                       assembles graph-derived context slice for the LLM
    providers/
      watsonx.ts                    ← WatsonxProvider: @ibm-cloud/watsonx-ai SDK + IamAuthenticator
                                       textChat() chat API (NOT deprecated text/generation REST)
                                       _chat(): maxTokens: 4096 + 60s timeout (Promise.race) —
                                         reasoning models (gpt-oss) burn tokens on hidden
                                         reasoning_content and need real headroom + real time
                                       summarizeModule, classifyLayer, buildModulePrompt
                                       explainDiff: real implementation (layers + neighbourhood context + diff)
                                       answerQuestion: real implementation (debob explain)
                                       reads WATSONX_URL + WATSONX_MODEL_ID (not ENDPOINT)

 engine/
   index.ts                        ← runInit(repoRoot, options): Promise<InitResult>
                                      runUpdate(repoRoot, options): Promise<UpdateResult>
                                      InitOptions, InitResult, UpdateOptions, UpdateResult types
                                      analyzer registry (ext→analyzer Map): TS + Python
                                      pipeline: scan → analyze → git → buildGraph → persist →
                                        semantic? → manifest → writeAgentInstructions
                                      incremental helpers: makeFileNode, mergeAnalysisResults, markHotFiles,
                                        mergeGitFileStats, removeUnreferencedPackages, applyFileMetadata
   review.ts                       ← runReview(repoRoot, options): Promise<ReviewResult>
                                      ReviewOptions, ReviewResult { ..., notes: string[] }
                                      reads git diff (--base uses three-dot/merge-base) → maps to
                                        graph nodes (both a/ and b/ paths, rename-aware) →
                                        2-hop neighbourhood → semantic_enrichments → llm.explainDiff()
                                      try/finally around adapter.close()
   explain.ts                      ← runExplain(repoRoot, options): Promise<ExplainResult>
                                      ExplainOptions, ExplainResult types
                                      findRelevantNodes() → join cached responsibility text →
                                        collect edges via getNodeEdges → llm.answerQuestion()
   agentInstructions.ts            ← writeAgentInstructions(repoRoot, manifest): void
                                      creates/refreshes the <!-- DEBOB:START/END --> block in the
                                      repo's root AGENTS.md — the "any agent discovers the graph
                                      automatically" mechanism; called from runInit + runUpdate

  query/
    index.ts                        ← getNodeEdges, getFileImports, getFileExports, getNodeNeighbours
                                       buildModuleContext re-exported here for engine compatibility
                                       findRelevantNodes(graph, question, enrichments?, limit?):
                                         keyword-overlap scoring for debob explain retrieval

  visualiser/
    server.ts                       ← startVisualiserServer(repoRoot, options): local HTTP server
                                       reads graph via readGraph(), serves GET /api/graph (JSON)
                                       and GET / (inline Cytoscape.js HTML — no build step)
                                       port auto-retry (7842–7846), returns { url, close }
                                       layout: fcose — REQUIRES all three CDN script tags in
                                         order (layout-base → cose-base → cytoscape-fcose);
                                         falls back to plain cose if they fail to load
                                       invisible 'edge-structural' anchors (file → its symbols)
                                         keep 0-degree symbol nodes from wrecking the layout
                                         inside compound region boxes — layout-only, never in
                                         the /api/graph payload

docs/
  architecture.md                   ← Full architecture reference: system overview, pipeline,
                                       graph model, DB schema (all 6 tables), incremental update
                                       design, LLM architecture, extension guides (language + LLM
                                       provider), debob review foundation
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
- **Relative import resolution**: a specifier like `./foo.js` must be remapped to `./foo.ts` when
  no literal `.js` file exists on disk — this codebase (like any ESM-TS project) imports with the
  *compiled* extension throughout. Missing this created disconnected phantom stub nodes for
  nearly every relative import in DeBob's own self-analysis. See `resolveImportTarget` in
  `src/analyzers/typescript/index.ts`.
- Python grammar (`src/analyzers/python/index.ts`): `import_statement`, `import_from_statement`,
  `relative_import` (`import_prefix` = dots, optional `dotted_name` = submodule),
  `function_definition`/`class_definition` (`name` is a real tree-sitter field on both). Verified
  empirically via a throwaway AST-dump script — don't assume grammar shape, dump it.

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

## All Sub-Tasks Complete ✅

All 11 original sub-tasks + A–J next-phase sub-tasks are implemented and verified.
The full DeBob system is operational:

- `npx debob init` — scans any Git repo, builds `.debob/context.db`, zero LLM calls, and writes/
  refreshes the `AGENTS.md` discovery block (see below) so any agent finds the graph
- `npx debob init --semantic` — additionally enriches the graph via watsonx.ai SDK
  - Reads `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_URL`, `WATSONX_MODEL_ID` from `.env`
  - Uses `@ibm-cloud/watsonx-ai` SDK chat API via `WatsonxProvider`
  - Writes `responsibility` + `layer` fields to `semantic_enrichments` table per file node
- `npx debob update` — incrementally re-analyzes only changed files; updates the graph in-place
- `npx debob update --semantic` — additionally enriches newly-analyzed nodes via LLM
- `npx debob review` — explains the impact of a git diff against the architectural graph
  - Requires `WATSONX_*` credentials; reads `git diff HEAD` or `--base <ref>` (three-dot/merge-base)
  - Output: affected files, layers touched, 2-hop neighbourhood, LLM impact explanation, notes
    when changed files aren't yet in the graph
- `npx debob explain "<question>"` — free-text Q&A over the graph, never raw source
  - Requires `WATSONX_*` credentials; keyword-overlap retrieval over nodes + cached enrichments
- `npx debob visualise` — opens interactive graph in browser (Cytoscape.js, local HTTP server)
- **`AGENTS.md` auto-instructions** (`src/engine/agentInstructions.ts`) — the actual mechanism
  behind "any agent knows what to do": `init`/`update` write a delimited, idempotent block into
  the repo's root `AGENTS.md` telling any AI coding agent to run `debob explain`/`debob review`
  instead of reading raw source. This is the primary interface; `.bob/skills/debob-query/SKILL.md`
  is the power-user fallback for raw queries the CLI doesn't cover.
- Python support (`src/analyzers/python/index.ts`) — shallow but real: imports + function/class
  nodes, proving `LanguageAnalyzer` is genuinely a plugin interface, not TS-only
- `githooks/post-commit` — opt-in (`git config core.hooksPath githooks`), backgrounds
  `debob update` after every commit
- `docs/architecture.md` — canonical reference for contributors and AI agents (note: written
  before Sub-Tasks A–J; still describes `update`/`review` as future and references the
  deprecated `WATSONX_ENDPOINT`/REST `text/generation` approach in places — `AGENTS.md` and
  `PROGRESS.md` are the current source of truth; this doc needs a refresh pass, not yet done)
- `README.md` — quick-start, all five commands, language support, team-sharing + automation docs

### watsonx Credentials (required for --semantic)

| Env var | Description |
|---|---|
| `WATSONX_API_KEY` | IBM Cloud IAM API key |
| `WATSONX_PROJECT_ID` | watsonx.ai project id |
| `WATSONX_URL` | Service URL (e.g. `https://us-south.ml.cloud.ibm.com`) |
| `WATSONX_MODEL_ID` | Chat-capable model id (e.g. `openai/gpt-oss-120b`, `meta-llama/llama-3-3-70b-instruct`) |

Place these in `.env` at the repo root — the CLI loads it automatically at startup.
Available chat-capable models on `us-south`: `ibm/granite-4-h-small`, `meta-llama/llama-3-3-70b-instruct`,
`mistralai/mistral-medium-2505`, `openai/gpt-oss-120b`, and others.

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
- Do NOT call `adapter.close()` and forget — sql.js won't persist without it
- Do NOT use the deprecated `text/generation` REST endpoint — use `WatsonxProvider` (SDK chat API)
- Do NOT read `WATSONX_ENDPOINT` — the correct env var is `WATSONX_URL`
- Do NOT hardcode model IDs — always pass `WATSONX_MODEL_ID` from env via `LLMConfig.modelId`
- Do NOT skip `maxTokens`/a timeout on `WatsonxProvider._chat()` calls — reasoning-capable models
  (e.g. `openai/gpt-oss-120b`) spend tokens on hidden `reasoning_content` and will silently return
  empty content (`finish_reason: "length"`) or hang without both
- Do NOT resolve relative TS/JS imports without remapping compiled extensions (`.js`→`.ts`) —
  see `resolveImportTarget` in `src/analyzers/typescript/index.ts`
- Do NOT hand-edit the `<!-- DEBOB:START -->...<!-- DEBOB:END -->` block in the root `AGENTS.md`
  — it's regenerated by `debob init`/`debob update` on every run; edit the rest of the file freely
- Do NOT load `cytoscape-fcose` (or `cose-bilkent`) from a single CDN `<script>` tag — they are
  webpack UMD bundles with *externalised* dependencies. All three tags, in order:
  `layout-base` → `cose-base` → `cytoscape-fcose`. A lone tag throws
  `Cannot read properties of undefined (reading 'layoutBase')` and silently drops the visualiser
  to the non-compound-aware `cose` fallback
- Do NOT use `:not()` in a cytoscape selector — it isn't supported; select on the absence of a
  data field instead (e.g. `'edge[type]'` to exclude the layout-only structural anchors)
- Do NOT add the structural anchor edges to the `/api/graph` payload or to `EdgeType` — they are
  a rendering-layer concern only and would corrupt the graph's "every edge is a real,
  traceable inference" contract
