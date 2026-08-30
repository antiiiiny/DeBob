# DeBob — Next Phase Plan

> **Purpose:** This plan covers the four improvements needed to make DeBob genuinely useful
> rather than a one-shot demo tool. Read `PROGRESS.md` and `debob-plan.md` before starting
> any sub-task here.
>
> **Rule:** Do not start any sub-task until the previous one passes `npm run typecheck`.
> Each sub-task is self-contained and reviewable on its own.

---

## Overview

| # | Sub-task | Depends on |
|---|---|---|
| A | Incremental update — `debob update` | existing `file_cache` table, `openDb`, `extractGitMetadata` |
| B | Layer propagation — write semantic layer back to nodes | `semantic_enrichments` table, `readGraph()` |
| C | Bob skill — query `.debob/context.db` from Bob chat | sub-task A (graph must be current), sub-task B (layers must be accurate) |
| D | `debob review` — diff impact analysis | `explainDiff` stub on `WatsonxProvider`, `extractGitMetadata` |
| E | Update `.bob/rules-*/AGENTS.md` stale content | all of the above |

---

## Sub-Task A — Incremental Update (`debob update`)

**Status:** `[x] done`

**Intent:**
`debob init` currently re-runs the full pipeline every time — re-scans all files, re-runs
tree-sitter on everything, re-extracts all git history, rebuilds the entire graph, and
overwrites the DB. The `file_cache` table with `contentHash`, `analyzerVersion`,
`schemaVersion`, and `lastGitCommit` was designed to prevent this, but the engine never
reads it. This sub-task implements `debob update` — a fast incremental re-analysis that
only re-processes files that have actually changed.

**Expected Outcomes:**
- New function `runUpdate(repoRoot, options): Promise<UpdateResult>` in `src/engine/index.ts`
- `UpdateResult` type: `{ addedNodes, removedNodes, updatedNodes, addedEdges, removedEdges, reanalyzedFiles, skippedFiles, dbPath }`
- On second run with no file changes: 0 files re-analyzed, DB untouched except manifest `updatedAt`
- On a file change: only changed files go through tree-sitter; unchanged files use cached nodes/edges
- If `manifest.schemaVersion !== SCHEMA_VERSION`: fall back to full `runInit` automatically
- `debob update` CLI command wired in `bin/debob.ts`

**Todo List:**
1. Add `runUpdate` to `src/engine/index.ts`:
   a. Open existing DB via `openDb(repoRoot)`. If `.debob/context.db` does not exist, throw: `"No graph found. Run 'debob init' first."`
   b. Read manifest via `readManifest(repoRoot)`. If `manifest.schemaVersion !== SCHEMA_VERSION`, log warning and call `runInit` (full rebuild) instead.
   c. Load `file_cache` entries via `adapter.readFileCacheEntries()` — build a `Map<filePath, FileCacheEntry>`
   d. Scan current files via `scanRepository(repoRoot)` — diff against cache:
      - `added`: files in scan result not in cache
      - `changed`: files whose `contentHash` differs from cache entry
      - `removed`: files in cache not in scan result
      - `unchanged`: everything else — skip tree-sitter entirely
   e. Run tree-sitter analyzer only on `added + changed` files
   f. Extract git metadata since `manifest.headCommit` (use `simple-git` log `--since` or diff) — only new commits
   g. Load the existing graph via `adapter.readGraph()`
   h. Remove nodes/edges belonging to `removed` files from the graph (purge by `filePath`)
   i. Merge new analysis results for `added + changed` files into the existing graph using `buildGraph` logic (same dedup rules)
   j. Persist the updated graph: `adapter.saveNodes`, `adapter.saveEdges`, update `file_cache` for changed/added files only, delete cache entries for removed files
   k. If `--semantic`: only run LLM enrichment on re-analyzed file nodes (not the whole graph)
   l. `adapter.close()`, write manifest with `updatedAt` timestamp
   m. Return `UpdateResult`
2. Add `UpdateResult` and `UpdateOptions` interfaces (similar shape to `InitResult`/`InitOptions`)
3. Add `update` command to `bin/debob.ts` with `--repo`, `--semantic`, `--verbose` options
4. Update `src/types/index.ts` re-export barrel to include `UpdateResult`, `UpdateOptions`
5. Run `npm run typecheck` — must pass

**Relevant Context:**
- `src/persistence/interface.ts` — `FileCacheEntry`, `readFileCacheEntries()` already defined
- `src/persistence/sqlite.ts` — `openDb`, `readManifest`, `SqlitePersistenceAdapter.readFileCacheEntries()`
- `src/scanner/index.ts` — `ScannedFile.contentHash` is SHA-256 of file content (already computed by scanner)
- `src/engine/index.ts` — `runInit` is the reference implementation; `runUpdate` follows the same pipeline but with a filter step before analysis
- `src/git/index.ts` — `extractGitMetadata` accepts `maxCommits` option; for update, pass `--since=<lastCommitHash>` or filter by date
- Incremental git: use `simple-git` `log({ from: lastCommitHash, to: 'HEAD' })` to get only new commits
- Node/edge purge for removed files: delete all nodes where `filePath` is in removed set, then delete any edge whose source or target no longer has a corresponding node
- `manifest.headCommit` is not yet stored — add it to the `Manifest` interface in `sqlite.ts` and write it in `runInit` too

---

## Sub-Task B — Layer Propagation

**Status:** `[x] done`

**Intent:**
After `debob init --semantic`, the `semantic_enrichments` table holds `field="layer"` rows
for every file node. But `Node.layer` is never set from these — it stays `undefined`.
As a result, `InitResult.layerDistribution` always reports `unclassified: 136` even after
a full semantic run. This also means Bob can't use `node.layer` in graph queries — it must
join `semantic_enrichments` manually, which is fragile.

Fix: after the semantic enrichment loop in `runInit` (and `runUpdate`), read back the
`layer` enrichments and update `Node.layer` in the DB to match.

**Expected Outcomes:**
- After `debob init --semantic`, `layerDistribution` in the summary shows real layers (not all `unclassified`)
- `Node.layer` in the DB matches the LLM-inferred layer for file nodes
- `debob visualise` color-codes nodes by layer correctly (no change needed in server.ts — it already reads `node.layer`)

**Todo List:**
1. In `src/engine/index.ts`, after `adapter.saveSemanticEnrichments(enrichments)` in the semantic block:
   a. Filter `enrichments` to only `field === 'layer'` entries
   b. For each, get the node from `graph.nodes`, set `node.layer = entry.value as ArchitecturalLayer`
   c. Call `adapter.saveNodes(updatedFileNodes)` to persist the `layer` column in the DB
2. Verify `InitResult.layerDistribution` now reflects real layers after a `--semantic` run
3. Run `npm run typecheck` — must pass

**Relevant Context:**
- `src/graph/types.ts` — `ArchitecturalLayer` = `'presentation' | 'business' | 'data' | 'config' | 'test' | 'infra'`
- `src/persistence/schema.ts` — `nodes` table has a `layer TEXT` column already
- `src/engine/index.ts` lines 191–216 — semantic enrichment loop; the fix goes immediately after `saveSemanticEnrichments`
- `layerDistribution` is built at lines 248–252 from `node.layer ?? 'unclassified'` — will work correctly once `node.layer` is populated

---

## Sub-Task C — Bob Skill: Graph Query from Chat

**Status:** `[x] done`

**Intent:**
The core token-saving value of DeBob is that Bob can query the pre-built graph to
understand a codebase without reading source files. This sub-task creates a Bob skill
that teaches Bob how to query `.debob/context.db` programmatically from chat — using
`openDb` + `readGraph()` + `semantic_enrichments` to answer architecture questions,
find relevant files, and assemble targeted context slices.

Without this skill, Bob reads source files directly (expensive, noisy). With it, Bob
queries the graph (cheap, structured, grounded in static analysis + LLM enrichments).

**Expected Outcomes:**
- A new skill file at `src/skills/debob-query.md` (Bob skill format)
- The skill teaches Bob: when to use DeBob vs. reading files, how to open the DB, what
  queries to run for common tasks, how to interpret `semantic_enrichments`
- Bob can answer "what does X file do?", "what imports Y?", "which files are in the data layer?"
  without opening a single source file
- Skill also covers: when to recommend `debob update`, how to detect a stale graph

**Todo List:**
1. Create `src/skills/debob-query.md` as a Bob skill with the following sections:
   a. **When to use this skill** — triggered when user asks about repo architecture, file responsibilities, dependencies, or "what does X do?"
   b. **Check if graph exists** — look for `.debob/context.db` and `.debob/manifest.json`; if missing, tell user to run `npx debob init` first; if `manifest.initAt` is > 7 days old or `manifest.semantic === false`, suggest `npx debob update --semantic`
   c. **Opening the DB** — use `openDb(repoRoot)` from `src/persistence/sqlite.ts`, then `new SqlitePersistenceAdapter(db, dbPath)`; call `adapter.readGraph()` to get `{ nodes: Map<string, Node>, edges: Edge[] }`
   d. **Reading semantic enrichments** — run SQL: `SELECT node_id, field, value FROM semantic_enrichments` to get LLM-cached responsibility and layer for each file — use these instead of calling watsonx again
   e. **Common query patterns** to include in the skill:
      - "What does file X do?" → get node by id, read `semantic_enrichments` for `responsibility`
      - "What imports file X?" → filter edges where `target === X && type === 'imports'`
      - "What does file X depend on?" → filter edges where `source === X && type === 'imports'`
      - "Which files are in the data layer?" → filter nodes where `layer === 'data'` (or query `semantic_enrichments` for `field='layer' AND value='data'`)
      - "Which files are most volatile?" → filter nodes where `metadata.hot === true`, sort by `churnScore`
      - "What are the entry points?" → find file nodes with many incoming `imports` edges and no outgoing (or `type === 'route'` nodes)
      - "What packages does this repo depend on?" → filter nodes where `type === 'package'`
   f. **Assembling a ModuleContext** — use `buildModuleContext(node, graph)` from `src/query/index.ts` to get a structured slice for any file node; pass this to `llm.summarizeModule()` only if no `semantic_enrichments` row exists yet (avoid redundant LLM calls)
   g. **Staleness heuristic** — if `manifest.headCommit !== (await git.revparse('HEAD'))` the graph is stale; recommend `npx debob update`
   h. **Never read raw source files** — the architectural invariant: Bob must use graph data, not `readFileSync`
2. Also update `.bob/rules-agent/AGENTS.md`, `.bob/rules-ask/AGENTS.md`, `.bob/rules-plan/AGENTS.md` to remove stale sub-task references and add a pointer to the new skill

**Relevant Context:**
- `src/persistence/sqlite.ts` — `openDb`, `readManifest`, `SqlitePersistenceAdapter`
- `src/query/index.ts` — `getNodeEdges`, `getFileImports`, `getFileExports`, `getNodeNeighbours`, `buildModuleContext`
- `src/graph/types.ts` — full Node/Edge/Graph type definitions
- Bob skill format: a markdown file with frontmatter and structured sections; check `.bob/` directory for existing examples
- The skill runs in Bob's context — it can use file tools to read the DB but must spawn `npx tsx` for TypeScript code, or read the binary DB via a helper script

---

## Sub-Task D — `debob review` (Diff Impact Analysis)

**Status:** `[x] done`

**Intent:**
`debob review` is stubbed but the full type infrastructure exists: `DiffContext`,
`explainDiff()` on `WatsonxProvider`, `getNodeNeighbours()` in the query layer.
This sub-task wires them together: read the current git diff, find which graph nodes
are affected, assemble a `DiffContext`, and call `llm.explainDiff()` to produce a
structured impact analysis.

**Expected Outcomes:**
- `debob review` (no args) reads `git diff HEAD` and explains the impact of uncommitted changes
- `debob review --base <ref>` reads `git diff <ref>..HEAD`
- Output: which layers are affected, which modules are at risk, one-sentence impact summary per affected file
- Requires `--semantic` creds (same `WATSONX_*` env vars)
- Exits with code 1 if not in a Git repo or no diff found

**Todo List:**
1. Add `runReview(repoRoot, options): Promise<ReviewResult>` to a new file `src/engine/review.ts`:
   a. Run `git diff <base>..HEAD` (default base: `HEAD`, so uncommitted changes) via `simple-git`
   b. Parse the unified diff to extract changed file paths (lines starting with `diff --git`)
   c. Open existing graph via `openDb` + `adapter.readGraph()`. If no DB, throw "run debob init first"
   d. For each changed file path, find its node in the graph by id (relativePath)
   e. Get neighbourhood: `getNodeNeighbours(graph, nodeId, depth=2)` — files that import or are imported by changed files
   f. Read `semantic_enrichments` for all affected + neighbourhood nodes (responsibility + layer) — build a summary string per node
   g. Build `DiffContext`: `{ diff: rawDiff, affectedNodes, neighbourhood: subGraph, layersSummary }`
   h. Call `llm.explainDiff(context)` and return the explanation
   i. `ReviewResult`: `{ affectedFiles, affectedLayers, neighbourhoodSize, explanation }`
2. Implement `WatsonxProvider.explainDiff()` — remove the stub, add the real prompt:
   - System: "You are a software architecture assistant. Given a git diff and the architectural context of affected modules (no raw source), describe the impact of this change."
   - User: structured context including layer summary, affected node responsibilities, diff (truncated to first 200 lines to cap tokens)
   - Return the model's response
3. Add `review` command to `bin/debob.ts`:
   - Options: `--repo`, `--base <git-ref>` (default: staged/unstaged vs HEAD), `--verbose`
   - Same `WATSONX_*` env var requirement as `--semantic`
   - Print affected files, layers touched, and the LLM explanation
4. Add `ReviewResult`, `ReviewOptions` to `src/types/index.ts`
5. Run `npm run typecheck` — must pass

**Relevant Context:**
- `src/llm/adapter.ts` — `DiffContext`: `{ diff: string, affectedNodes: Node[], neighbourhood: Graph, layersSummary: string[] }`
- `src/llm/providers/watsonx.ts` — `explainDiff` is a stub; implement the `_chat()` call here
- `src/query/index.ts` — `getNodeNeighbours(graph, nodeId, depth)` already implemented
- `simple-git` is already a dependency — use `simpleGit(repoRoot).diff([base])` for the raw diff
- Token budget: truncate diff to 200 lines before sending to the model; include node responsibilities from `semantic_enrichments` (already cached — no extra LLM calls)
- `neighbourhood` in `DiffContext` is a sub-graph (nodes + edges) not the full graph — construct it from `getNodeNeighbours` results

---

## Sub-Task E — Update `.bob/rules-*/AGENTS.md` Skill Files

**Status:** `[x] done`

**Intent:**
All three `.bob/rules-*/AGENTS.md` files are stale. They reference sub-tasks 7–11 as
pending, describe `WATSONX_ENDPOINT` (renamed to `WATSONX_URL`), call the CLI a
"placeholder", and say the engine/query/llm directories are "intentionally empty".
A new agent reading these files will get confused and contradict the current state.

**Expected Outcomes:**
- All three files accurately reflect the current implementation
- `rules-ask/AGENTS.md` updated with correct env var names, current command list, and DeBob skill pointer
- `rules-agent/AGENTS.md` updated with new forbidden actions (`debob review` no longer forbidden — it now exists) and new `WatsonxProvider` naming
- `rules-plan/AGENTS.md` updated with current implementation sequence (all done), new sub-tasks A–D above

**Todo List:**
1. Rewrite `.bob/rules-ask/AGENTS.md`:
   - Update "Key Documentation Files" — add `debob-next-plan.md`
   - Fix "IBM watsonx Provider" section: `WATSONX_URL` not `WATSONX_ENDPOINT`; SDK not REST; class is `WatsonxProvider` not `WatsonxAdapter`; all sub-tasks 1–11 are done
   - Remove "intentionally empty" comment — those files now exist
   - Add pointer to the new `src/skills/debob-query.md` skill
2. Rewrite `.bob/rules-agent/AGENTS.md`:
   - Remove "Do NOT implement `debob review`" — it is now implemented
   - Add "Do NOT use the deprecated `text/generation` REST endpoint — use `WatsonxProvider`"
   - Add "Do NOT read `WATSONX_ENDPOINT` — use `WATSONX_URL`"
   - Update ad-hoc testing section with `debob update` and `debob review` test patterns
3. Rewrite `.bob/rules-plan/AGENTS.md`:
   - Replace the "Sub-tasks 7–11 pending" sequence with the new A–D sequence from this plan
   - Update architectural constraints section with `WatsonxProvider` naming, `.env` auto-load

---

## Execution Order

```
A (incremental update) → B (layer propagation) → C (Bob skill) → D (debob review) → E (skill file cleanup)
```

B is a 10-minute change that makes the output of A immediately more useful.
C depends on A+B being correct so the graph Bob queries is current and has accurate layers.
D is independent of C but benefits from B (layer data in the impact summary).
E is last — update docs only after the code they describe is done.

---

## What This Unlocks

After these four sub-tasks:

- **`debob update`** — run after any commit; only re-analyzes changed files; fast enough to put in a git pre-push hook
- **Bob skill** — Bob queries the graph from chat to answer architecture questions without reading source files; token cost for a "what does this repo do?" question drops from ~15k tokens (reading files) to ~500 tokens (graph query + cached enrichments)
- **`debob review`** — paste a PR diff, get a structured impact analysis grounded in the architectural graph
- **Accurate layer distribution** — the `debob init --semantic` summary finally shows real layers

---

## What Is Explicitly Out of Scope for This Plan

- `debob explain` free-form Q&A CLI command (after Bob skill is built, this is redundant)
- Python/Rust/Go language analyzer plugins (new `LanguageAnalyzer` implementations)
- Graph DB backend (swap `sql.js` for a proper graph store)
- Multi-repo support
- CI/CD integration or GitHub Actions workflow
