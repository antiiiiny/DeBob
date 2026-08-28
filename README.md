# DeBob

> Git remembers what changed. DeBob remembers what the codebase **means**.

DeBob is a persistent repository-understanding and context system for AI coding agents.

It creates a `.debob/` directory inside any Git repository containing a structured, queryable graph representation of that repository — built from static code analysis, Git history, and optional LLM semantic enrichment.

---

## Quick Start

```bash
# Run inside any Git repository
npx debob init

# With LLM semantic enrichment (requires IBM watsonx credentials)
npx debob init --semantic
```

## What it does

`debob init` scans your repository and produces `.debob/context.db` — a SQLite database containing:

- **Nodes**: files, functions, classes, interfaces, external packages
- **Edges**: imports, exports, extends, implements relationships
- **Git data**: commit history, per-file churn scores, author counts
- **File cache**: content hashes and analyzer versions for incremental updates
- **Semantic enrichments** *(with `--semantic`)*: module responsibilities, architectural layer classifications

## Commands

| Command | Description |
|---|---|
| `debob init` | Scan repository and build the graph |
| `debob init --semantic` | Also run LLM semantic enrichment |
| `debob init --repo <path>` | Analyze a specific repository path |
| `debob init --max-commits <n>` | Limit Git history depth (default: 500) |
| `debob review` | *(coming soon)* Review a diff in the context of the graph |

## IBM watsonx Setup (for `--semantic`)

Set these environment variables before running `debob init --semantic`:

```bash
export WATSONX_API_KEY=your_api_key
export WATSONX_PROJECT_ID=your_project_id
export WATSONX_ENDPOINT=https://us-south.ml.cloud.ibm.com
```

## `.debob/` Contents

```
.debob/
├── context.db      # SQLite graph database
└── manifest.json   # Run metadata
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for a full explanation of the system design, graph model, incremental update strategy, and extension guides.

---

*Built with [IBM Bob](https://ibm.com)*
