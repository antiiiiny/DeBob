# DeBob

> Git remembers what changed. DeBob remembers what the codebase **means**.

DeBob is a persistent repository-understanding and context system for AI coding agents.

It scans any Git repository and builds `.debob/context.db` — a SQLite knowledge graph of files, symbols, imports, Git history, and optional LLM-inferred architectural context. AI agents query the graph instead of reading raw source files, cutting token cost by an order of magnitude.

---

## Using DeBob in a New Repository

### Step 1 — Build the graph

Run this once inside any Git repository:

```bash
node dist/bin/debob.js init
```

> **Windows / PowerShell note:** PowerShell blocks `.ps1` script shims, so `npx debob` may fail with a script execution policy error. Use `node dist/bin/debob.js <command>` directly, or prefix with `cmd /c "npx debob <command>"`.

This produces `.debob/context.db` and `.debob/manifest.json`. No credentials needed for the structural graph.

### Step 2 — Add LLM semantic enrichment (optional but recommended)

Create a `.env` file at the repository root:

```env
WATSONX_API_KEY=your_ibm_cloud_iam_api_key
WATSONX_PROJECT_ID=your_watsonx_project_id
WATSONX_URL=https://us-south.ml.cloud.ibm.com
WATSONX_MODEL_ID=meta-llama/llama-3-3-70b-instruct
```

Then run:

```bash
node dist/bin/debob.js init --semantic
```

This adds `responsibility` and architectural `layer` enrichments for every file node — stored in the `semantic_enrichments` table, never in the raw source.

### Step 3 — Explore the graph

```bash
node dist/bin/debob.js visualise
```

Opens an interactive Cytoscape.js graph in your browser. Filter by node type, layer, or hot-file status. Click any node to inspect its metadata.

### Step 4 — Keep it current

After making code changes, run an incremental update instead of a full re-init:

```bash
node dist/bin/debob.js update
```

Only files whose content has changed since the last run are re-analyzed. Unchanged files are skipped entirely.

### Step 5 — Review a diff

Before committing or reviewing a PR, explain the architectural impact of your changes:

```bash
node dist/bin/debob.js review
```

Requires watsonx credentials. Reads the current `git diff HEAD`, maps changed files to their graph neighbourhood, and asks the LLM to explain risks and affected modules — without sending raw source code.

---

## Commands

### `init` — Build the knowledge graph

```bash
node dist/bin/debob.js init [options]
```

| Option | Description | Default |
|---|---|---|
| `--repo <path>` | Path to the repository root | current directory |
| `--max-commits <n>` | Maximum Git commits to analyze | `500` |
| `--semantic` | Run LLM enrichment after structural extraction | off |
| `--verbose` | Log each pipeline stage with counts | off |

**Output:**

```
✔ Repository analysis complete

─── DeBob Init Summary ──────────────────────────────────

  Files scanned : 35
  Nodes         : 158
  Edges         : 98
  Git commits   : 16

  Layer distribution (file nodes):
    business             17
    infra                15
    config               13
    data                 9
    presentation         2

  🔥 Hot files (top churn):
    bin/debob.ts (churn: 6.00)
    PROGRESS.md (churn: 9.00)

  External packages (20):
    commander, chalk, ora, open, simple-git … +15 more

  Database      : /your/repo/.debob/context.db

─────────────────────────────────────────────────────────
```

> The `layer distribution` shows only file nodes. Symbol nodes (functions, classes, etc.) and package nodes do not receive layer assignments — that is expected.

---

### `update` — Incremental re-analysis

```bash
node dist/bin/debob.js update [options]
```

Re-analyzes only files whose content hash has changed since the last `init` or `update`. Unchanged files are skipped — the graph is patched in-place.

| Option | Description | Default |
|---|---|---|
| `--repo <path>` | Path to the repository root | current directory |
| `--semantic` | Run LLM enrichment on re-analyzed files only | off |
| `--verbose` | List the re-analyzed files | off |

Requires `debob init` to have been run first. If the schema version has changed since `init`, `update` automatically falls back to a full `init`.

---

### `visualise` — Interactive graph browser

```bash
node dist/bin/debob.js visualise [options]
# alias: viz
```

Starts a local HTTP server and opens the graph in your browser (Cytoscape.js). Auto-retries ports 7842–7846 if the default is busy.

| Option | Description | Default |
|---|---|---|
| `--repo <path>` | Path to the repository root | current directory |
| `--port <n>` | HTTP port to listen on | `7842` |

**What you can do in the visualiser:**
- Filter nodes by type (file, class, function, interface, variable, package, route)
- Filter by architectural layer (business, data, presentation, config, infra, test)
- Toggle "hot files only" to show the highest-churn files
- Click any node to inspect its metadata: layer, confidence, churn score, author count, last modified

---

### `review` — Diff impact analysis

```bash
node dist/bin/debob.js review [options]
```

Reads a git diff, maps changed files to their graph nodes and 2-hop neighbourhood, then calls the LLM to explain which parts of the system are affected and what risks the change introduces.

| Option | Description | Default |
|---|---|---|
| `--repo <path>` | Path to the repository root | current directory |
| `--base <git-ref>` | Diff base ref (e.g. `main`, `HEAD~3`) | uncommitted changes vs HEAD |
| `--verbose` | Show detailed progress | off |

Requires watsonx credentials in `.env`. Exits with code 1 if no diff is found or the graph does not exist.

**Example:**

```bash
# Review uncommitted changes
node dist/bin/debob.js review

# Review everything since branching from main
node dist/bin/debob.js review --base main
```

---

## IBM watsonx Credentials

Place these in a `.env` file at the repository root. The CLI loads it automatically at startup — no `export` needed.

```env
WATSONX_API_KEY=your_ibm_cloud_iam_api_key
WATSONX_PROJECT_ID=your_watsonx_project_id
WATSONX_URL=https://us-south.ml.cloud.ibm.com
WATSONX_MODEL_ID=meta-llama/llama-3-3-70b-instruct
```

| Variable | Description |
|---|---|
| `WATSONX_API_KEY` | IBM Cloud IAM API key |
| `WATSONX_PROJECT_ID` | watsonx.ai project ID |
| `WATSONX_URL` | Service URL for your region |
| `WATSONX_MODEL_ID` | Chat-capable model ID |

Available chat-capable models on `us-south`: `ibm/granite-4-h-small`, `meta-llama/llama-3-3-70b-instruct`, `mistralai/mistral-medium-2505`, `openai/gpt-oss-120b`.

Credentials are **never** written to `.debob/` or any config file. If any variable is missing when `--semantic` is used, DeBob warns and skips LLM enrichment — the structural graph is still built.

---

## What Gets Built

### `.debob/` directory

```
.debob/
├── context.db      # SQLite knowledge graph
└── manifest.json   # Run metadata (version, counts, timestamp, headCommit, semantic flag)
```

### `context.db` tables

| Table | Contents |
|---|---|
| `nodes` | Files, functions, classes, interfaces, variables, packages — with type, layer, confidence |
| `edges` | Imports, exports, extends, implements, calls relationships between nodes |
| `git_commits` | Commit history (hashed author emails — raw emails never stored) |
| `git_file_stats` | Per-file churn score, author count, last modified date |
| `file_cache` | Content hashes and analyzer versions — drives incremental updates |
| `semantic_enrichments` | LLM-inferred `responsibility` and `layer` per file node, with provider + model provenance |

See [`docs/architecture.md`](docs/architecture.md) for the full schema and design rationale.

---

## How AI Agents Use DeBob

Instead of reading source files (expensive, noisy), an agent queries the graph:

```
"What does src/engine/index.ts do?"
→ read semantic_enrichments WHERE node_id = 'src/engine/index.ts' AND field = 'responsibility'

"What imports src/persistence/sqlite.ts?"
→ filter edges WHERE target = 'src/persistence/sqlite.ts' AND type = 'imports'

"Which files are in the data layer?"
→ filter nodes WHERE layer = 'data'

"Which files are most volatile?"
→ filter nodes WHERE metadata.hot = true, sort by churnScore desc
```

The Bob skill at [`.bob/skills/debob-query/SKILL.md`](.bob/skills/debob-query/SKILL.md) teaches Bob how to run these queries from chat without opening source files.

---

## Contributing

```bash
npm run typecheck   # tsc --noEmit — must pass before any commit
npm run build       # tsup → dist/
npm run dev         # tsx bin/debob.ts — run CLI in dev mode (no build needed)
```

See [`AGENTS.md`](.bob/rules-agent/AGENTS.md) for the full coding guide: dependency constraints, WASM pinning, sql.js patterns, ID conventions.

---

*Built with [IBM Bob](https://ibm.com)*
