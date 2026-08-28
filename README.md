# DeBob

> Git remembers what changed. DeBob remembers what the codebase **means**.

DeBob is a persistent repository-understanding and context system for AI coding agents.

It creates a `.debob/` directory inside any Git repository containing a structured, queryable graph of that repository — built from static code analysis, Git history, and optional LLM semantic enrichment.

---

## Quick Start

```bash
# Run inside any Git repository
npx debob init

# With LLM semantic enrichment (requires IBM watsonx credentials)
npx debob init --semantic

# Analyze a specific repository
npx debob init --repo /path/to/repo
```

---

## What It Does

`debob init` scans your repository and produces `.debob/context.db` — a SQLite database containing:

| Content | Description |
|---|---|
| **Nodes** | Files, functions, classes, interfaces, external packages |
| **Edges** | Imports, exports, extends, implements relationships |
| **Git data** | Commit history, per-file churn scores, author counts, hot-file markers |
| **File cache** | Content hashes and analyzer versions for incremental updates |
| **Semantic enrichments** | *(with `--semantic`)* Module responsibilities, architectural layer classifications |

After `debob init`, the `.debob/context.db` graph can be queried by AI agents to get targeted context slices without reading raw source files.

---

## Commands

| Command | Description |
|---|---|
| `debob init` | Scan repository and build the knowledge graph |
| `debob init --semantic` | Also run LLM semantic enrichment on each file node |
| `debob init --repo <path>` | Analyze a specific repository path (default: `cwd`) |
| `debob init --max-commits <n>` | Limit Git history depth (default: `500`) |
| `debob init --verbose` | Log each pipeline stage with counts |
| `debob review` | *(coming soon)* Review a diff in the context of the graph |

---

## IBM watsonx Setup (`--semantic`)

Set these environment variables before running `debob init --semantic`:

```bash
export WATSONX_API_KEY=your_api_key
export WATSONX_PROJECT_ID=your_project_id
export WATSONX_ENDPOINT=https://us-south.ml.cloud.ibm.com
```

If any variable is missing, DeBob warns and skips LLM enrichment — the structural graph is still built.

Credentials are **never** stored in `.debob/` or any config file.

---

## `.debob/` Contents

```
.debob/
├── context.db      # SQLite knowledge graph (nodes, edges, git data, semantic enrichments)
└── manifest.json   # Run metadata (version, counts, timestamp, semantic flag)
```

The database contains six tables: `nodes`, `edges`, `git_commits`, `git_file_stats`, `file_cache`, `semantic_enrichments`. See [`docs/architecture.md`](docs/architecture.md) for the full schema.

---

## Output Summary

Running `debob init` prints a summary like:

```
✔ Repository analysis complete

─── DeBob Init Summary ──────────────────────────────────

  Files scanned : 38
  Nodes         : 142
  Edges         : 310
  Git commits   : 214

  Layer distribution:
    unclassified         98
    business             22
    data                 14
    config                8

  🔥 Hot files (top churn):
    src/engine/index.ts (churn: 12.00)
    src/persistence/sqlite.ts (churn: 8.00)

  External packages (4):
    commander, chalk, ora, simple-git

  Database      : /path/to/.debob/context.db

─────────────────────────────────────────────────────────
```

---

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for:

- Full system overview and pipeline diagram
- Graph model (Node, Edge, NodeType, EdgeType, ID conventions)
- Complete `.debob/context.db` schema (all 6 tables)
- Incremental update design (`file_cache` table)
- LLM architecture ("the LLM never receives raw source")
- How to add a language analyzer (e.g. Python)
- How to add an LLM provider (e.g. OpenAI)
- How `debob review` will be built on this foundation

---

## Contributing

```bash
npm run typecheck   # tsc --noEmit — must pass before any commit
npm run build       # tsup → dist/
npm run dev         # tsx bin/debob.ts — run CLI in dev mode
```

See `AGENTS.md` for the full coding guide (dependency constraints, WASM notes, sql.js patterns, ID conventions).

---

*Built with [IBM Bob](https://ibm.com)*
