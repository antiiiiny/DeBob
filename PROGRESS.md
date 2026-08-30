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

## Enrichment Quality (Sub-Task N) — ✅ done, measured on two repos

A head-to-head showed DeBob winning on speed and cost but **losing on quality**: a cold Claude
agent with no DeBob access described 30 modules in 105s / 86,885 tokens, versus DeBob's 44 in
21s / 34,013 — but the agent's text was richer, e.g. `builder.ts` as *"stubbing or dropping
dangling edge endpoints"*. The cause was input starvation: `buildModulePrompt` sent only a file
path, import specifiers, declaration names and churn.

**Four defects and one inefficiency found:**
1. **`Exports` was wrong on every call.** `getFileExports` reads `exports` edges, which only
   exist for *re-exports*. A file doing `export function buildGraph` was described to the model
   as **"Exports (0)"**. Renamed to `reExports` and documented for what it actually is.
2. **The call graph was computed and ignored** — 160 `calls` edges never reached `ModuleContext`.
3. **`buildModuleContext` existed twice.** `src/llm/context.ts` and `src/query/index.ts` held
   independent implementations; only the query one was live and **nothing imported the other**.
   PROGRESS.md described it as a re-export, which it was not. The dead file is deleted; the live
   copy stays in `query/` because moving it the other way would create an import cycle.
4. **Dotted filenames never resolved.** `./fetch-poems.api` makes `extname()` return `.api`, so
   the extensionless probe was skipped and every such import became a phantom stub. This is the
   standard `*.api.ts` / `*.config.ts` / `*.types.ts` convention — **found only by testing the
   second repo**, where it produced 13 phantom nodes (now 2).
5. **The same context was sent twice per module.** `summarizeModule` and `classifyLayer` built
   byte-identical prompts. Merged into `describeModule`, which returns both fields in one call.

**What landed:** `describeModule` (with a liberal JSON parser and per-module fallback to the two
old calls); `reExports` fix plus `calls`/`calledBy`/`layer`/`doc` in `ModuleContext`; doc-comment
extraction in the TS analyzer (file-level + JSDoc on declarations, capped at 500/300 chars with a
2,000-char per-module budget); and a README-derived project preamble in `src/engine/preamble.ts`.

**The merge paid for the quality.** Measured on this repo:

| | Before | After |
|---|---|---|
| Calls | 88 | **46** |
| Prompt tokens | 22,416 | 27,478 |
| Completion tokens | 11,597 | **6,484** |
| **Total** | **34,013** | **33,962** |

Total spend is flat to within 51 tokens, slightly faster (21s → 19s), with far richer input.
Average summary length 144 → 219 chars. The reduction ratio drops 7.1× → 6.0× **only because it
is computed from prompt tokens**; total cost did not move.

⚠️ **The preamble is adaptive, and must stay that way.** It is paid on *every* call, so its cost
scales with module count while its benefit does not. DeBob has 26 source files; the Next.js
monorepo has 243. A 100-token preamble there would cost ~24,000 tokens against a repo whose
entire source is ~65,000. `buildProjectPreamble` returns undefined above 100 modules.

**Cross-repo validation** (`Test-project-1/nextjs-monorepo-example`, 338 files, 749 nodes):
orphan symbols **0**, phantom stubs **13 → 2** after defect 4, arrow-function extraction confirmed
working at scale (121 function + 176 variable nodes from React/Next code that produced *nothing*
before Sub-Task K). Only **11%** of its nodes carry a doc comment versus DeBob's heavy commenting
— so the Part 3 quality gain is real here but much weaker there, exactly as predicted.

---

## Token Accounting (Sub-Task M) — ✅ done, measured

DeBob's central claim is "the LLM never receives the repository". That was asserted in prose
with no number behind it — the weakest kind of efficiency claim to put in front of a judge.
Every watsonx `textChat` response already carries an exact usage block; `_chat()` read
`choices` and `finish_reason` and threw `usage` away.

**What landed:**
- `TokenUsage { promptTokens, completionTokens, totalTokens, callCount }` in
  `src/llm/adapter.ts`, and an **optional** `getUsage?()` on `LLMAdapter` — optional by design
  so a provider that can't report usage omits it rather than fabricating zeros.
- `WatsonxProvider` accumulates per call. Usage is recorded **before** the truncation/shape
  error checks: a call that burned tokens and then failed still cost money, and skipping it
  would understate the total. `getUsage()` returns `undefined` until a call has reported, and
  hands back a copy so a caller can't mutate the running total.
- `InitResult`/`UpdateResult` gain `tokenUsage?` and `sourceBytes` (summed from
  `ScannedFile.sizeBytes`, already collected); `ReviewResult`/`ExplainResult` gain `tokenUsage?`.
- `printTokenUsage()` in `bin/debob.ts` renders both halves, labelled differently on purpose.

**Measured on this repo** (44 modules, `openai/gpt-oss-120b`):

```
Prompt        : 22,416   graph slices actually sent          (exact, from IBM)
Completion    : 11,597   includes hidden reasoning tokens    (exact, from IBM)
Total         : 34,013   across 88 calls                     (44 files × 2 — as predicted)
Raw source    : ~159,028 est. from 0.61 MB at ~4 chars/token (ESTIMATE)
Reduction     : ~7.1×
```

Cross-checked the byte figure with an independent filesystem walk: 0.63 MB vs DeBob's 0.61 MB,
the 3% gap explained by `.gitignore`/`.debobignore` filtering. The ratio holds.

**Honesty rules baked into the renderer — do not relax these:**
- Prompt/completion/total are **exact provider counts** and are rendered plainly.
- The raw-source figure is an **estimate**: always `~`-prefixed, always carrying its assumption
  ("est. from N MB at ~4 chars/token"). Never present it as measured.
- Completion tokens are labelled as including hidden reasoning. A trivial
  `"Reply with exactly: ok"` measured **51 completion tokens** on `gpt-oss-120b` — these counts
  do not measure answer length.
- No usage reported ⇒ **print nothing**. "Not measured" must never render as `0`, which would
  be a false claim rather than an absent one. Covered by a test.
- `review` prints no reduction ratio: it deliberately sends the raw diff, so "vs. sending the
  source" would compare unlike things.

---

## Faster Enrichment + Agent Enrichment (Sub-Task L) — ✅ done, speedup measured

Two changes, both aimed at "enrichment is the slowest part of a run".

**1. Enrichment now runs concurrently.** It was strictly sequential — `for (const node of
graph.nodes.values())` with `await` inside; only the *two calls per file* were parallel. On a
40-file repo that's 40 serial round-trips, and the wall-clock cost is almost entirely network
idle. `src/engine/concurrency.ts` adds `mapWithConcurrency`, used by both `runInit` and
`runUpdate`, with `--concurrency <n>` on the CLI (default 6, clamped to 24 so a typo can't
cause a rate-limit storm).

**Measured** on this repo (44 file nodes, 88 watsonx calls, `openai/gpt-oss-120b`), full
`debob init --semantic` wall-clock, both runs exit 0:

| Run | Wall clock |
|---|---|
| `--concurrency 1` (the old sequential behaviour) | **141s** |
| `--concurrency 8` | **21s** |

**~6.7× end-to-end.** Structural-only `init` is ~3–4s warm (16s on a cold WASM start), so
enrichment is essentially all of that time; the phase itself is roughly 137s → 17s. Don't
subtract a fixed structural baseline to quote a bigger ratio — it varies by an order of
magnitude between cold and warm runs, which is exactly the mistake the first measurement made.

⚠️ **`--concurrency N` means 2N simultaneous HTTP requests**, because each file fires
`summarizeModule` and `classifyLayer` in parallel via `Promise.all`. So the default of 6 is 12
in flight, and 8 is 16. watsonx tolerated 16 fine here; lower the flag if a provider starts
rate-limiting.

`concurrency.test.ts` covers the mechanism itself (limit respected, input order preserved,
8×30ms completes in <150ms rather than ~240ms, every item visited exactly once).

**2. `debob enrich` — semantic enrichment with no API key.** The agent already running in the
repo does the work instead of a hosted model:

```bash
debob enrich --export .debob/enrichment.json    # module contexts, skips already-enriched
# agent fills in { nodeId, responsibility, layer } per task
debob enrich --import .debob/enrichment-answers.json
```

`src/engine/enrich.ts` — `runEnrichExport` / `runEnrichImport`. Output lands in the same
`semantic_enrichments` table as `--semantic`, tagged `llmProvider: "agent"`,
`modelId: "claude-code"` (override with `--model`), and runs the same post-processing:
layers propagate onto file nodes, then `inheritLayersFromFiles` gives symbols their layer.
Downstream (`explain`, the visualiser) can't tell the difference apart from the provenance tag.

Validation is deliberate, since the input is agent-written:
- Unknown `nodeId` → skipped and reported (guards against a stale export or an invented id).
- `layer` not in `ARCHITECTURAL_LAYERS` → that field skipped, but the node's **responsibility
  still lands**. Partial acceptance beats losing good text over one bad enum.
- The parser accepts a bare array, `{ answers: [...] }`, or `{ tasks: [...] }` — being liberal
  costs nothing and saves a "wrong wrapper key" round-trip.

Verified by round-trip on this repo: 40 tasks exported; an answers file containing a bad
`nodeId` and an invalid layer produced exactly the expected `Skipped` entries while the valid
rows were written.

**3. `manifest.semantic` now reports reality, not the flag.** It recorded "was `--semantic`
passed on this run", which was fine while that was the only way to get enrichments. With
`debob enrich` it isn't: a fully enriched graph would still write `semantic: false`, and the
AGENTS.md block words itself from that field — so it told every agent "no semantic enrichment
yet" on a graph with 44 responsibilities in it. Both `runInit` and `runUpdate` now derive it
from `hasResponsibilityEnrichments(adapter)`, and `runEnrichImport` refreshes the manifest plus
the AGENTS.md block after a successful import (best-effort; a failure there must not lose the
enrichments just written).

**Discovery.** Two mechanisms, because they cover different tools:
- `.bob/skills/debob-enrich/SKILL.md` — for Bob/agents that read `.bob/skills/`.
- **The `AGENTS.md` auto-block** (`src/engine/agentInstructions.ts`) now carries an "Enriching
  the graph (you can do this yourself — no API key)" section. This is the one that matters for
  arbitrary repos: `.bob/skills/` is only present in this repo, whereas `debob init` writes
  `AGENTS.md` into *any* target repo, and Claude Code / Cursor auto-load it.

---

## Graph Truth + watsonx Surfacing (Sub-Task K) — ✅ done

Measuring the graph after the visualiser fix showed the real problem was *what was in it*, not
how it was drawn. Before this work, against this repo:

```
nodes 162   file 42 | function 67 | interface 29 | package 20 | class 4
edges 117   imports 100 | exports 12 | implements 4 | extends 1
orphans     108 of 162 (67%) had zero edges
layers      120 of 162 (74%) unclassified
```

**Root causes found (all now fixed):**

1. **11 of 15 `EdgeType` values were never emitted by anything.** The graph was a file-import
   graph with 96 symbol nodes floating decoratively beside it. There was no `declares` type at
   all and no call extraction, so a plain `export function foo() {}` had no edge to anything.
2. **The TS analyzer never handled `arrow_function`, `variable_declarator`, `method_definition`
   or `call_expression`.** `export const Foo = () => {}` produced **no node at all** — the
   dominant modern style — class methods didn't exist, and no `variable` node was ever created
   despite the type, legend entry and filter existing. Sub-Task 5's own todo item #6 specified
   arrow functions and was marked done without being implemented. This repo's self-graph hid it
   because debob happens to use no arrow exports.
3. **`extends`/`implements` targeted bare source text**, not node ids, so `makeStubNode` invented
   a `file` node named after each TypeScript type. That's why the graph had 42 file nodes against
   a `fileCount` of 38.
4. **`buildGraph` silently discarded every file node's inferred layer.** Step 1 seeds a bare
   file node per scanned file with no layer; Step 2's "first writer wins" then dropped the
   analyzer's file node — which carried `inferLayer`'s result — on the id collision. A large
   part of the 74% unclassified rate. **Found by a unit test**, not by reading the code.
5. **`debob init` was not authoritative.** It upserts nodes and never deletes, so nodes an
   earlier run produced but a later one doesn't (renamed symbols, phantoms from a since-fixed
   analyzer bug) survived forever with nothing to remove them. A fresh `init` still showed 4
   ghost nodes carrying zero edges.

**What landed:**
- **`declares` edge type** (new in `src/graph/types.ts`): `file → symbol` and `class → method`,
  confidence 1.0, emitted by both analyzers. This replaced the invisible `edge-structural`
  anchors the visualiser used as a workaround — the containment is a real fact, so it now lives
  in the graph rather than the renderer.
- **Per-file symbol resolution table** in `src/analyzers/typescript/index.ts` — local
  declarations plus import bindings (named/aliased/default/namespace), built in a first pass so
  a call to a function declared later in the file still resolves. Everything that turns an
  identifier into an edge target goes through it.
- **`calls` / `instantiates` edges at confidence 0.9** — deliberately below 1.0, since
  name-based resolution isn't sound under shadowing or overloads. Sourced from the *enclosing
  declaration* (walked via `SyntaxNode.parent`), not the file.
- **Arrow-function and const exports, and class methods** now produce nodes; non-function
  top-level consts produce `variable` nodes. Method ids are class-qualified
  (`file.ts::Repo.save`) in **both** analyzers — Python's flat `file.py::save` would silently
  merge a method with a same-named module-level function.
- **Resolved heritage targets**; unresolvable ones emit nothing at all.
- **`buildGraph`**: file→symbol layer inheritance; file-node field merge (fixing cause 4); and
  edges to unresolved *symbol* endpoints are now **dropped rather than stubbed**, while missing
  file/package endpoints still stub (those are real things that just weren't scanned).
- **`adapter.clearGraph()`** + a call at the top of `runInit`'s persist step, making a full init
  authoritative. Deliberately preserves `semantic_enrichments` — LLM output is expensive and
  still valid for every node the rebuild reproduces.
- **watsonx responsibility surfaced in the visualiser.** `startVisualiserServer` now joins
  `readSemanticEnrichments()` onto the payload (the persisted `Node.responsibility` column is
  never populated — enrichments live only in their own table, exactly as `explain.ts` handles
  it). The Node Inspector leads with the summary as prose with a `watsonx · <modelId>`
  attribution, and enriched nodes carry a cyan halo with a legend entry.
- **Layer patterns extended** with filename-level rules and more directory names.

**Measured after:**

```
nodes 235   function 112 | file 40 | variable 29 | interface 29 | package 21 | class 4
edges 473   declares 174 | calls 160 | imports 110 | instantiates 12 | exports 12 | implements 4 | extends 1
orphans     13 (all genuinely edge-less files like README.md) — ZERO orphan symbols (was 95)
stub nodes  0 (was 4 phantoms)
file nodes  exactly 40 = files scanned
layers      21 unclassified — and those 21 are exactly the package nodes, which have no file
            to inherit from. Every file and symbol node is classified (was 74% unclassified).
```

Browser-verified via the Playwright harness: `orphanSymbols: 0`, `declaresEdges: 174`,
`enrichedNodes: 40`, `legacyStructuralEdges: 0`, zero page errors, layout still frames cleanly
in all three grouping modes, and the Node Inspector renders a watsonx summary attributed
`watsonx · openai/gpt-oss-120b`.

**Two further fixes this required, both discovered during verification:**
- **`runInit` now restores cached LLM layers.** `clearGraph()` drops the nodes the LLM's layers
  were written onto, while the enrichments themselves survive — so without this a plain
  structural `debob init` silently discarded paid-for watsonx output and every file fell back to
  path heuristics. It now re-applies them from `semantic_enrichments` with no LLM calls
  (`40 cached LLM layers restored, 93 inherited` on this repo).
- **`inheritLayersFromFiles` must run twice.** It was only called inside `buildGraph`, which
  happens *before* `--semantic` propagates LLM layers onto file nodes — so symbols only ever
  inherited the heuristic layer. It is now exported from `src/graph/builder.ts` and re-run after
  the semantic step (and after the layer restore above). This is what took unclassified from
  113 → 21.

**Known omission:** calls through a member expression (`adapter.close()`) are not extracted —
resolving the receiver needs type information, and matching on the property name alone would
invent edges. Documented in the analyzer's class doc comment.

**Tests:** `vitest` added (`npm test`), 29 cases over
`src/analyzers/typescript/index.test.ts` and `src/graph/builder.test.ts`. The suite found cause 4
on its first run.

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
| K | Graph truth (`declares`/`calls`/`instantiates`, arrow fns, methods, resolved heritage, layer inheritance, authoritative `init`) + watsonx responsibility in the visualiser + vitest | ✅ done |
| L | Concurrent enrichment (`--concurrency`) + `debob enrich` export/import for API-key-free agent enrichment + AGENTS.md/skill discovery | ✅ done (141s → 21s measured) |
| M | Token accounting: exact provider usage + not-sent counterfactual, printed by every command | ✅ done (~6.0× measured) |
| N | Enrichment quality: merged describeModule call, fixed reExports, call graph + doc comments + README preamble in context, dotted-filename resolution | ✅ done (flat tokens, richer output; validated on 2 repos) |

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
                                       marks top-10% churn file nodes hot
                                       file-node collisions MERGE (the analyzer's file node carries
                                         inferLayer's result; plain first-writer-wins threw it away)
                                       symbols inherit their declaring file's layer
                                       missing file/package endpoints stub; missing SYMBOL
                                         endpoints drop the edge (no phantom type-named nodes)
    builder.test.ts                 ← layer inheritance + stub-vs-drop endpoint rules

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
   concurrency.ts                  ← mapWithConcurrency(items, limit, worker)
                                      DEFAULT_ENRICH_CONCURRENCY = 6
                                      enrichment was serial; this overlaps the round-trips
   enrich.ts                       ← runEnrichExport / runEnrichImport
                                      API-key-free enrichment: export ModuleContexts as JSON,
                                        an agent writes { nodeId, responsibility, layer },
                                        import validates + writes to semantic_enrichments
                                      rejects unknown nodeIds and non-ArchitecturalLayer values,
                                        but still keeps a valid responsibility beside a bad layer
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
- Do NOT emit an edge to an identifier the analyzer could not resolve. `buildGraph` stubs any
  unknown endpoint, so an unresolved name becomes a phantom `file` node named after a TypeScript
  type. Resolve through the per-file symbol table and emit nothing on a miss
- Do NOT try to extract calls through a member expression (`adapter.close()`) by matching the
  property name — without the receiver's type that invents edges between unrelated symbols.
  Only plain-identifier callees are resolved, deliberately
- Do NOT give a `calls`/`instantiates` edge confidence 1.0 — name-based resolution is not sound
  under shadowing or overloads. They carry 0.9 so the graph stays honest about how it knows
- Do NOT give a class method a flat `file::method` id — it silently merges with a same-named
  module-level function. Methods are class-qualified: `file::Class.method`
- Do NOT assume `debob init` cleans up after itself without `adapter.clearGraph()` — every save
  is an upsert, so anything a previous run created and this one didn't survives indefinitely
- Do NOT put a backtick in a comment inside `src/visualiser/server.ts` — the whole page is one
  TypeScript template literal and a stray backtick terminates it (hit twice now)
- Do NOT query the adapter after `adapter.close()`. sql.js frees its heap on close, and any
  query afterwards fails with a bare **"out of memory"** that looks nothing like a use-after-free.
  Read whatever the manifest step needs *before* the close — see `graphHasEnrichments` in
  `runInit`/`runUpdate`
- Do NOT read `--concurrency N` as N requests in flight — each file fires two calls in parallel,
  so it is **2N**
