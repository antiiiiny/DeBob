---
name: debob-enrich
description: Enrich the DeBob repository knowledge graph (.debob/context.db) with module responsibilities and architectural layers, using this agent instead of a hosted LLM. Activate when the user asks to enrich the graph, describe the modules, fill in responsibilities, classify layers, or run semantic enrichment without an API key.
---

# DeBob Agent Enrichment Skill

DeBob's graph is built deterministically — files, imports, exports, declarations, git churn.
The *semantic* layer on top (what each module is **for**, and which architectural layer it
belongs to) normally comes from a hosted model via `debob init --semantic`, which needs
watsonx credentials.

This skill does the same job using **you**, the coding agent already running in the repo. No
API key, no network round-trips. The output lands in exactly the same `semantic_enrichments`
table and is indistinguishable downstream apart from its provenance tag.

Use it when the user says any of:
- "enrich the debob graph" / "describe the modules"
- "fill in the responsibilities" / "classify the layers"
- "run semantic enrichment without an API key"
- "I don't have watsonx credentials"

---

## Step 1 — Check the graph exists

```bash
test -f .debob/context.db && echo "graph found" || echo "run: debob init"
```

If it's missing, run `debob init` first (structural only, no credentials needed).

---

## Step 2 — Export the work

```bash
debob enrich --export .debob/enrichment.json
```

This writes one task per file module. By default it **skips modules already enriched** — so
this is safe to re-run and will only ever give you the outstanding work. Pass `--all` to
redo everything.

If it reports `Tasks written: 0`, everything is already enriched. Stop and say so.

---

## Step 3 — Fill it in

Read `.debob/enrichment.json`. Each entry in `tasks` gives you the graph facts for one module:

```json
{
  "nodeId": "src/scanner/index.ts",
  "filePath": "src/scanner/index.ts",
  "imports": ["glob", "node:fs", "src/scanner/types.ts"],
  "exports": ["scanRepository", "summarizeByLanguage"],
  "declarations": [{ "name": "scanRepository", "type": "function", "startLine": 88 }],
  "gitStats": { "churnScore": 4, "authorCount": 1 },
  "currentLayer": "data"
}
```

Write a JSON file — `.debob/enrichment-answers.json` — containing one answer per task:

```json
[
  {
    "nodeId": "src/scanner/index.ts",
    "responsibility": "Walks the repository and produces the canonical list of analysable source files, applying the ignore rules, extension allowlist and size cap. Every downstream stage starts from its output.",
    "layer": "data"
  }
]
```

Rules that matter:

- **`nodeId` must be copied verbatim.** The importer rejects ids it can't find in the graph,
  so a paraphrased or invented id is silently dropped (it will be listed under "Skipped").
- **`layer` must be one of:** `presentation`, `business`, `data`, `config`, `test`, `infra`.
  Anything else is rejected for that node. The `validLayers` field in the export is the
  authority.
- **Say what the module is FOR**, not what it imports. "Assembles the targeted context slice
  the LLM receives, enforcing that raw source never leaves the repo" is useful.
  "Imports fs and path and exports two functions" is not — the graph already knows that.
- Keep it to **1–3 sentences**. This text is what `debob explain` retrieves against and what
  the visualiser shows in its Node Inspector, so it should read as prose.
- **Prefer the graph facts.** They're usually enough. Read the actual source file only when
  a module's purpose genuinely isn't inferable from its name, imports, exports and
  declarations — that's the exception, not the routine.
- `currentLayer` is whatever the path heuristics guessed. Treat it as a hint you're free to
  overrule; that's much of the point of doing this.

For a large repo, work through the tasks in batches rather than trying to hold all of them at
once, appending to the answers array as you go.

---

## Step 4 — Import

```bash
debob enrich --import .debob/enrichment-answers.json
```

Report back what it prints: responsibilities written, layers written, and how many symbols
inherited a layer from their file. **Check the "Skipped" list** — entries there mean a bad
`nodeId` or an invalid `layer`, and are worth fixing and re-importing rather than ignoring.

---

## Step 5 — Confirm

```bash
debob explain "what does the scanner do?"     # needs credentials; skip if none
debob visualise                                # click a haloed node — summary appears
```

The cyan halo in the visualiser marks enriched nodes, so coverage is visible at a glance.

---

## Notes

- Enrichments are tagged `llmProvider: "agent"`, `modelId: "claude-code"` (override with
  `--model`). Provenance stays honest: `dataSource` and `confidence` still distinguish
  LLM-derived text from deterministic facts.
- Running `debob update` **without** `--semantic` deletes enrichments for re-analyzed files.
  After a big update, re-run this skill — `--export` will hand you exactly the modules that
  lost their enrichment, and nothing else.
- A plain `debob init` preserves existing enrichments and restores cached layers, so a
  structural rebuild won't cost you this work.
