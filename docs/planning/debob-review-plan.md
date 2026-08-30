# DeBob — Sub-Tasks D + E Implementation Plan

> **Source spec:** `debob-impl-plan.md` (status tracking) + `debob-next-plan.md` (full specs).
> **Rule:** `npm run typecheck` must pass before moving from D to E.
> **Order:** D first (code), then E (docs cleanup).

---

## Baseline State

Sub-tasks A, B, C are complete. The codebase has:

- `runUpdate` fully implemented in `src/engine/index.ts`
- Layer propagation wired in both `runInit` and `runUpdate`
- `.bob/skills/debob-query/SKILL.md` exists (Bob query skill)
- `bin/debob.ts` has `update` command; `review` is still a one-liner stub (line 313–320)
- `WatsonxProvider.explainDiff()` still throws "not yet implemented" (`src/llm/providers/watsonx.ts` line 127)
- `src/engine/review.ts` does not exist
- `.bob/rules-agent/AGENTS.md` line 37 still says "Do NOT implement debob review, debob update, or debob explain yet"

---

## Sub-Task D — `debob review` (Diff Impact Analysis)

**Status:** `[ ] pending`

**Intent:**
Replace the `debob review` stub with a working diff impact analysis command. Read the git diff,
map changed files to graph nodes, collect their 2-hop neighbourhood, read cached semantic enrichments
for context, then call `WatsonxProvider.explainDiff()` with a `DiffContext`. Print affected files,
layers touched, and the LLM explanation.

**Expected Outcomes:**
- `debob review` (no args) reads `git diff HEAD` — explains impact of uncommitted changes
- `debob review --base <ref>` reads `git diff <ref>..HEAD`
- Output: list of affected files, layers touched, neighbourhood size, LLM explanation paragraph
- Exits with code 1 if not in a Git repo or no diff found
- `npm run typecheck` passes

**Todo List:**

1. Create `src/engine/review.ts`:
   - Export `ReviewOptions`: `{ base?: string; verbose?: boolean; llm: LLMAdapter }`
   - Export `ReviewResult`: `{ affectedFiles: string[]; affectedLayers: string[]; neighbourhoodSize: number; explanation: string }`
   - Implement `runReview(repoRoot: string, options: ReviewOptions): Promise<ReviewResult>`:
     a. Run `simpleGit(repoRoot).diff([options.base ?? 'HEAD'])` to get raw diff string
     b. Parse changed file paths from diff header lines (`diff --git a/<path> b/<path>`)
     c. Throw `"No diff found."` if changed paths list is empty; throw `"Not a Git repository."` if simpleGit throws
     d. Open existing DB via `openDb(repoRoot)` + `new SqlitePersistenceAdapter(db, dbPath)`; throw `"No graph found. Run 'debob init' first."` if `.debob/context.db` does not exist
     e. Call `adapter.readGraph()` to get the full graph
     f. For each changed path, find the matching node in `graph.nodes` (node id = relative path)
     g. Collect 2-hop neighbourhood: call `getNodeNeighbours(graph, nodeId, 2)` for each affected node, deduplicate
     h. Call `adapter.readSemanticEnrichments()` with the ids of affected + neighbourhood nodes to get cached responsibility/layer data
     i. Build `layersSummary: string[]` — unique layer values from enrichments where `field === 'layer'`
     j. Build `DiffContext`: `{ diff: rawDiff.slice(0, 200 lines), affectedNodes, neighbourhood: subGraph, layersSummary }`
     k. Call `options.llm.explainDiff(diffContext)` to get the explanation string
     l. Call `adapter.close()`
     m. Return `ReviewResult`

2. Implement `WatsonxProvider.explainDiff()` in `src/llm/providers/watsonx.ts`:
   - Remove the stub that throws
   - Call `this._chat([systemMsg, userMsg])` where:
     - System: `"You are a software architecture assistant. Given a git diff and the architectural context of affected modules (no raw source), describe the impact of this change in plain language."`
     - User: structured string assembling `layersSummary`, one line per affected node with its responsibility (from enrichments embedded in context), then the truncated diff
   - Return the model response

3. Replace the `review` stub in `bin/debob.ts` (lines 313–320) with a real command:
   - Options: `--repo <path>` (default: `cwd`), `--base <git-ref>` (default: none → uncommitted changes), `--verbose`
   - Same `WATSONX_*` credential block as `update` command — LLM is required (not optional); exit 1 with clear message if creds missing
   - Spinner during LLM call
   - Print: affected files list, layers touched, neighbourhood size, then explanation paragraph
   - Exit 0 on success, 1 on error

4. Add `ReviewResult` and `ReviewOptions` to the engine export line in `src/types/index.ts` (line 44).

5. Run `npm run typecheck` — must pass with zero errors.

**Relevant Context:**
- `src/llm/adapter.ts` — `DiffContext` type (lines 46–55): `{ diff, affectedNodes, neighbourhood: Graph, layersSummary }`
- `src/llm/providers/watsonx.ts` — stub at lines 124–129; `_chat()` helper at lines 148–165
- `src/query/index.ts` — `getNodeNeighbours(graph, nodeId, depth)` at line 19
- `src/persistence/interface.ts` — `readSemanticEnrichments(nodeIds?)` at line 86; `SemanticEnrichment` at line 32
- `src/persistence/sqlite.ts` — `openDb`, `SqlitePersistenceAdapter`
- `bin/debob.ts` lines 221–258 — `update` command's LLM credential block is the exact pattern to mirror
- `bin/debob.ts` lines 313–320 — stub to replace entirely
- `src/types/index.ts` line 44 — engine export line to extend

---

## Sub-Task E — `.bob/rules-agent/AGENTS.md` Cleanup

**Status:** `[ ] pending`

**Intent:**
Remove the now-false prohibition in `.bob/rules-agent/AGENTS.md` that says "Do NOT implement
debob review, debob update, or debob explain yet." Both `debob review` and `debob update` now
exist. Leaving this rule in place will confuse future agents into thinking those features are
forbidden. Also do a light accuracy pass on the other two rules files.

**Expected Outcomes:**
- `.bob/rules-agent/AGENTS.md` no longer forbids `debob review` or `debob update`
- All three `.bob/rules-*/AGENTS.md` files accurately reflect the current codebase state
- No stale "coming soon" or "not yet implemented" language remains in rules files

**Todo List:**

1. Edit `.bob/rules-agent/AGENTS.md`:
   - Replace the single line `"Do NOT implement debob review, debob update, or debob explain yet"` with:
     `"Do NOT implement debob explain — this is out of scope for V1"`
   - (Keep the other Forbidden entries unchanged)

2. Verify `.bob/rules-ask/AGENTS.md` — check that the CLI command list accurately says `review` is implemented (line 29 currently says "review: stub" — update to reflect real implementation).

3. Verify `.bob/rules-plan/AGENTS.md` — confirm D and E are now marked complete in the sequence block. Update the status from `pending` to `complete` for both.

4. Update `debob-impl-plan.md`:
   - Mark Sub-Task D status as `[x] done`
   - Mark Sub-Task E status as `[x] done`

**Relevant Context:**
- `.bob/rules-agent/AGENTS.md` line 37 — the stale prohibition
- `.bob/rules-ask/AGENTS.md` line 29 — "review: stub (coming soon)" will be stale after D
- `.bob/rules-plan/AGENTS.md` lines 12–13 — D and E marked `pending`

---

## Execution Order

```
D (implement debob review) → E (update stale rules)
```

E is deliberately last — update the docs only after the code is working and typechecked.

---

## Out of Scope

- `debob explain` free-form Q&A — explicitly deferred in `debob-next-plan.md`
- Python/Rust/Go language analyzers
- Any changes to the graph schema or persistence layer
