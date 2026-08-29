# DeBob — Implementation Plan (Sub-Tasks A–E)

> **Source spec:** `debob-next-plan.md` — read it before touching any sub-task.
> **Rule:** `npm run typecheck` must pass before moving to the next sub-task.
> Sub-tasks must be implemented in order A → B → C → D → E.

---

## Baseline State (established before this plan)

The following structural groundwork is **already in place** from the recent baseline edits:

- `UpdateOptions` and `UpdateResult` types declared in `src/engine/index.ts`
- Helper functions extracted in `src/engine/index.ts`: `makeFileNode`, `makeStubNode`,
  `applyFileMetadata`, `mergeAnalysisResults`, `removeUnreferencedPackages`, `markHotFiles`,
  `mergeGitFileStats`, `countChangedEntries`
- `PersistenceAdapter` extended with: `deleteNodesByFilePaths`, `deleteEdgesBySourceIds`,
  `deleteEdgesByNodeIds`, `deleteFileCacheEntries`, `deleteSemanticEnrichments`,
  `readGraph`, `readFileCacheEntries`, `readGitFileStats`, `readSemanticEnrichments`
- All adapter methods implemented in `SqlitePersistenceAdapter` (`src/persistence/sqlite.ts`)
- `Manifest.headCommit?: string` added to the manifest type
- `GitExtractOptions.fromCommit?: string` added and wired into the git log command
- `GitMetadata.headCommit: string` field present

**What is NOT yet done:** `runUpdate` body, manifest `headCommit` write in `runInit`,
`update` CLI command, types barrel export, and Sub-Tasks B–E.

---

## Sub-Task A — `runUpdate` + `debob update` CLI

**Status:** `[x] done`

**Intent:**
Wire up the already-scaffolded helper functions into a concrete `runUpdate` implementation,
add `headCommit` to the manifest written by `runInit`, expose `debob update` in the CLI,
and export the new types from the barrel.

**Expected Outcomes:**
- `runUpdate(repoRoot, options): Promise<UpdateResult>` is fully implemented in `src/engine/index.ts`
- Second run with no file changes: `reanalyzedFiles` is empty; only manifest `updatedAt` changes
- File change: only affected files are re-analyzed; unchanged files use cached nodes/edges
- Schema version mismatch falls back to `runInit` automatically
- `debob update` command works in the CLI with `--repo`, `--semantic`, `--verbose`
- `npm run typecheck` passes

**Todo List:**
1. In `src/engine/index.ts`, inside `runInit`, add `headCommit: gitMetadata.headCommit` to the
   manifest object written in Step 9 (the `writeManifest` call).
2. Implement `runUpdate` in `src/engine/index.ts` — follow the step-by-step sequence in
   `debob-next-plan.md` Sub-Task A items 1a–1m:
   - Open DB; throw if `.debob/context.db` does not exist
   - Read manifest; fall back to `runInit` if schema version mismatches
   - Load `file_cache` entries from DB; build a `Map<filePath, FileCacheEntry>`
   - Scan current files; classify into `added`, `changed`, `removed`, `unchanged`
   - Run tree-sitter analysis only on `added + changed` files
   - Extract incremental git metadata using `fromCommit: manifest.headCommit`
   - Load the existing graph via `adapter.readGraph()`
   - Purge removed-file nodes/edges/cache/enrichments from graph and DB
   - Use `mergeAnalysisResults` to merge new analysis into existing graph
   - Load existing git file stats, merge with incremental stats via `mergeGitFileStats`,
     re-apply metadata to file nodes, re-run `markHotFiles`
   - Persist updated nodes, edges, file cache, git stats
   - If `--semantic`: run LLM enrichment only on nodes from re-analyzed files
   - `adapter.close()`; write updated manifest (`updatedAt` + `headCommit`)
   - Return `UpdateResult`
3. Add `update` command to `bin/debob.ts` with `--repo`, `--semantic`, `--verbose` options;
   reuse the same LLM credential resolution and spinner pattern as `init`.
   Print a summary: files re-analyzed, files skipped, nodes added/removed/updated.
4. Add `UpdateResult` and `UpdateOptions` to the exports in `src/types/index.ts`.
5. Run `npm run typecheck` — must pass with zero errors.

**Relevant Context:**
- `src/engine/index.ts` — helpers are already written above `runInit`; `runUpdate` goes
  after `runInit` following the same section-header style
- `src/persistence/sqlite.ts` — all adapter methods for incremental cleanup already exist
- `src/git/index.ts` — `extractGitMetadata(repoRoot, { fromCommit })` is already wired
- `bin/debob.ts` — add command between the `visualise` block and the `review` stub;
  mirror the `init` command's LLM credential resolution block exactly
- `src/types/index.ts` line 44 — add `UpdateResult, UpdateOptions` to the engine export line

---

## Sub-Task B — Layer Propagation

**Status:** `[x] done`

**Intent:**
After `debob init --semantic` or `debob update --semantic`, the `semantic_enrichments` table
holds `field="layer"` rows for every file node, but `Node.layer` is never written back — so
`layerDistribution` always reports all nodes as `unclassified`. Write the layer values from
enrichments back to `Node.layer` in the DB immediately after `saveSemanticEnrichments` in
both `runInit` and (later) `runUpdate`.

**Expected Outcomes:**
- After `debob init --semantic`, `layerDistribution` in the printed summary reflects real
  layers, not all `unclassified`
- `Node.layer` in the DB matches the LLM-inferred layer for all enriched file nodes
- `debob visualise` color-codes nodes by layer correctly (no change to `server.ts` needed)
- `npm run typecheck` passes

**Todo List:**
1. In the semantic enrichment block of `runInit` (after `adapter.saveSemanticEnrichments`):
   a. Filter `enrichments` to entries where `field === 'layer'`
   b. For each, find the node in `graph.nodes` by `entry.nodeId`; set `node.layer` to
      `entry.value as ArchitecturalLayer`
   c. Collect those updated nodes; call `adapter.saveNodes(updatedLayerNodes)` to persist
2. Apply the same layer-propagation step after the semantic block in `runUpdate`
   (once `runUpdate` exists from Sub-Task A)
3. Run `npm run typecheck` — must pass.

**Relevant Context:**
- `src/engine/index.ts` — semantic block ends with `adapter.saveSemanticEnrichments(enrichments)`;
  the propagation step goes immediately after inside the same `if (semantic && llm)` block
- `src/graph/types.ts` — `ArchitecturalLayer` type for the cast
- `layerDistribution` loop at the bottom of `runInit` reads `node.layer ?? 'unclassified'`
  and will show real values once the DB is updated

---

## Sub-Task C — Bob Skill: Graph Query from Chat

**Status:** `[x] done`

**Intent:**
Create a Bob skill file that teaches Bob how to query `.debob/context.db` from chat to answer
architecture questions without reading raw source files. This is the primary token-saving
mechanism: graph queries + cached enrichments replace bulk file reads.

**Expected Outcomes:**
- New skill file at `.bob/skills/debob-query.md` in Bob skill format
- Skill covers: when to use it, how to detect a stale graph, how to open the DB, common
  query patterns, how to read `semantic_enrichments`, the "never read raw source files" rule
- Bob can answer "what does X do?", "what imports Y?", "which files are in the data layer?"
  without opening a single source file

**Todo List:**
1. Check `.bob/` directory structure to confirm skills folder location and format of existing
   skill files before writing.
2. Create `.bob/skills/debob-query.md` with:
   a. Frontmatter: `name`, `description`, `triggers`
   b. **When to use this skill** section — triggered by architecture/dependency/responsibility
      questions about the repo
   c. **Prerequisite check** — look for `.debob/context.db` + `.debob/manifest.json`; if absent,
      tell user to run `npx debob init`; if `manifest.semantic === false`, suggest
      `npx debob update --semantic` for richer data
   d. **Staleness heuristic** — compare `manifest.headCommit` against `git rev-parse HEAD` via
      a one-liner `npx tsx` script; if different, recommend `npx debob update`
   e. **Opening the DB** — code pattern using `openDb` + `SqlitePersistenceAdapter` +
      `adapter.readGraph()` wrapped in a small `npx tsx` inline script
   f. **Reading semantic enrichments** — show the SQL pattern + the adapter method
   g. **Common query patterns** (as annotated code snippets):
      - "What does file X do?" → `semantic_enrichments` for `responsibility`
      - "What imports file X?" → edges where `target === X && type === 'imports'`
      - "What does file X depend on?" → edges where `source === X && type === 'imports'`
      - "Which files are in layer Y?" → nodes where `layer === Y`
      - "Which files are most volatile?" → nodes with `metadata.hot === true`
      - "What packages does this repo use?" → nodes where `type === 'package'`
   h. **Never read raw source files** — state the architectural invariant explicitly
3. Update `.bob/rules-agent/AGENTS.md`, `.bob/rules-ask/AGENTS.md`, `.bob/rules-plan/AGENTS.md`
   to add a pointer to the new skill (Sub-Task E covers full rewrites; this step is just
   adding the pointer so it's discoverable before E runs).

**Relevant Context:**
- `src/persistence/sqlite.ts` — `openDb`, `SqlitePersistenceAdapter`, `readManifest`
- `src/query/index.ts` — `getFileImports`, `getFileExports`, `getNodeNeighbours`,
  `buildModuleContext`
- `src/graph/types.ts` — full `Node`/`Edge`/`Graph` types
- Bob skill format: check `.bob/` for existing skill files before writing

---

## Sub-Task D — `debob review` (Diff Impact Analysis)

**Status:** `[ ] pending`

**Intent:**
Replace the `debob review` stub with a real implementation. Read the current git diff,
map changed files to graph nodes, get their 2-hop neighbourhood, assemble a `DiffContext`,
call `llm.explainDiff()`, and print a structured impact analysis.

**Expected Outcomes:**
- `debob review` reads `git diff HEAD` (staged + unstaged changes) and explains the impact
- `debob review --base <ref>` reads `git diff <ref>..HEAD`
- Output: affected files, layers touched, neighbourhood size, LLM explanation paragraph
- `WatsonxProvider.explainDiff()` is implemented (was a stub)
- Exits with code 1 if not in a Git repo or no diff found
- `npm run typecheck` passes

**Todo List:**
1. Create `src/engine/review.ts`:
   - `ReviewOptions`: `{ base?: string; verbose?: boolean; llm: LLMAdapter }`
   - `ReviewResult`: `{ affectedFiles: string[]; affectedLayers: string[]; neighbourhoodSize: number; explanation: string }`
   - `runReview(repoRoot, options): Promise<ReviewResult>`:
     a. Run `git diff <base>..HEAD` (default base: `HEAD`) via `simpleGit(repoRoot).diff()`
     b. Extract changed file paths from the diff
     c. Throw if not in a repo or no diff
     d. Open existing graph via `openDb` + `adapter.readGraph()`; throw if no DB
     e. For each changed file, find its node in the graph
     f. Get neighbourhood: `getNodeNeighbours(graph, nodeId, 2)` for each changed node
     g. Read `semantic_enrichments` for all affected + neighbourhood nodes
     h. Build `DiffContext`; truncate diff to first 200 lines
     i. Call `llm.explainDiff(context)`; collect result
     j. Close adapter; return `ReviewResult`
2. Implement `WatsonxProvider.explainDiff()` in `src/llm/providers/watsonx.ts` — remove stub,
   add the real prompt with system message + structured context from `DiffContext`
3. Replace the `review` stub in `bin/debob.ts` with a real command:
   - Options: `--repo`, `--base <git-ref>`, `--verbose`
   - Same `WATSONX_*` env credential block as `init`
   - Print affected files, layers, and the LLM explanation
4. Add `ReviewResult` and `ReviewOptions` to `src/types/index.ts`.
5. Run `npm run typecheck` — must pass.

**Relevant Context:**
- `src/llm/adapter.ts` — `DiffContext` type (already defined)
- `src/llm/providers/watsonx.ts` — `explainDiff` stub to replace; `_chat()` private method
  is the right internal call to use
- `src/query/index.ts` — `getNodeNeighbours(graph, nodeId, depth)` already implemented
- `bin/debob.ts` — replace the existing `review` stub block entirely

---

## Sub-Task E — Update `.bob/rules-*/AGENTS.md` Files

**Status:** `[ ] pending`

**Intent:**
The three `.bob/rules-*/AGENTS.md` files are stale — they reference deprecated sub-task
numbers, wrong env var names (`WATSONX_ENDPOINT` instead of `WATSONX_URL`), and say the
engine/query/llm directories are "intentionally empty". Rewrite them to accurately reflect
the current state after Sub-Tasks A–D are done.

**Expected Outcomes:**
- All three files reflect the actual current codebase and completed features
- `rules-ask/AGENTS.md` has correct env var names, all sub-tasks 1–11 marked done, new
  `debob update` and `debob review` commands documented, pointer to `debob-query` skill
- `rules-agent/AGENTS.md` removes stale "do not implement review" prohibition; adds
  correct `WatsonxProvider` naming and `WATSONX_URL` constraint
- `rules-plan/AGENTS.md` replaces the "sub-tasks 7–11 pending" section with the new
  A–E sequence (all now complete)

**Todo List:**
1. Read each of the three `.bob/rules-*/AGENTS.md` files to identify stale content.
2. Rewrite `.bob/rules-ask/AGENTS.md`:
   - Add `debob-next-plan.md` and `debob-impl-plan.md` to key documentation pointers
   - Fix watsonx section: `WATSONX_URL` not `WATSONX_ENDPOINT`; class `WatsonxProvider`;
     sub-tasks 1–11 all done
   - Document `debob update` and `debob review` commands
   - Add pointer to `.bob/skills/debob-query.md` skill
3. Rewrite `.bob/rules-agent/AGENTS.md`:
   - Remove "Do NOT implement `debob review`" — it now exists
   - Add "Do NOT use deprecated `text/generation` REST endpoint — use `WatsonxProvider`"
   - Add "Do NOT read `WATSONX_ENDPOINT` — use `WATSONX_URL`"
   - Update ad-hoc testing patterns to include `debob update` and `debob review`
4. Rewrite `.bob/rules-plan/AGENTS.md`:
   - Replace the sub-tasks 7–11 implementation sequence with the completed A–E sequence
   - Update architectural constraints section with `WatsonxProvider` naming

---

## Execution Order

```
A (runUpdate + CLI) → B (layer propagation) → C (Bob skill) → D (debob review) → E (rules cleanup)
```

B is a small change that makes A's output immediately useful.
C depends on A + B so that the graph Bob queries is current and has accurate layers.
D is independent of C but benefits from B's layer data in the impact analysis.
E is last — rules files are updated only after the code they describe is complete.
