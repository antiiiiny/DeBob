# Agent Prompt — DeBob Graph Visualiser

## Your Task

Implement a `debob visualise` CLI command that reads the persisted graph from `.debob/context.db`, spins up a local HTTP server, and opens the browser to an interactive graph visualisation.

---

## Codebase Context

Read these files in full before writing a single line of code:

- `PROGRESS.md` — complete implementation status and all architectural constraints
- `AGENTS.md` — critical rules (WASM pins, no native deps, sql.js pattern, ID conventions)
- `debob-plan.md` — full architecture plan
- `src/graph/types.ts` — Node, Edge, Graph type definitions
- `src/persistence/interface.ts` — PersistenceAdapter interface (`readGraph()` is the key method)
- `src/persistence/sqlite.ts` — `openDb(repoRoot)`, `SqlitePersistenceAdapter`
- `src/persistence/schema.ts` — DB table DDL and SCHEMA_VERSION
- `src/query/index.ts` — graph query helpers
- `bin/debob.ts` — the existing CLI structure to extend
- `package.json` — existing deps; do not break any pinned versions

---

## What to Build

### 1. New dependency: `open`

Add `open` (npm package) to `package.json` dependencies. This is Node's standard way to open a URL in the default browser cross-platform. No other new runtime dependencies are permitted.

> Do NOT add `express`, `vite`, `webpack`, or any bundler. The HTTP server must use Node's built-in `http` module only.

---

### 2. New file: `src/visualiser/server.ts`

Implement and export a single function:

```ts
export async function startVisualiserServer(
  repoRoot: string,
  options?: { port?: number }
): Promise<{ url: string; close: () => void }>
```

**What it must do:**

1. Call `openDb(repoRoot)` then `new SqlitePersistenceAdapter(db, dbPath)` to open the existing `.debob/context.db`. If the file does not exist (no prior `debob init`), throw a descriptive error: `"No graph found. Run 'debob init' first."`.
2. Call `adapter.readGraph()` to get `{ nodes: Map<string, Node>, edges: Edge[] }`. Then call `adapter.close()`.
3. Serialise the graph to a plain JSON object for the browser:
   ```ts
   {
     nodes: Array<{ id, type, name, filePath, layer?, startLine?, endLine?, confidence, dataSource, metadata? }>,
     edges: Array<{ id, source, target, type, confidence, dataSource }>
   }
   ```
   Nodes come from `Array.from(graph.nodes.values())`. Inline the `metadata` field as-is.
4. Also read `.debob/manifest.json` (use `readManifest(repoRoot)` from `src/persistence/sqlite.ts`). Include it in the served payload as a `manifest` key.
5. Spin up a Node `http.createServer` on the given port (default `7842`, try up to 5 consecutive ports if busy — `EADDRINUSE`).
6. Serve two routes:
   - `GET /api/graph` → `Content-Type: application/json` → the serialised `{ nodes, edges, manifest }` payload
   - `GET /` and `GET /*` → `Content-Type: text/html` → the **inline HTML string** (see Section 3 below)
7. Return `{ url: "http://localhost:<port>", close: () => server.close() }`.

**Important constraints:**
- Do NOT call `adapter.close()` after `readGraph()` — read is non-mutating; the DB is in-memory and `close()` writes to disk. Actually, `close()` IS safe to call after a read-only open — the in-memory state will be written back identically. Call it to release resources.
- Follow the sql.js pattern from `AGENTS.md`: always `adapter.close()` after use.
- Never mutate the DB inside the visualiser server.

---

### 3. Inline HTML + Visualisation

The entire front-end must be returned as a single inline HTML string from `src/visualiser/server.ts`. No separate static files. No build step. No file serving from disk.

**Technology:** Use [Cytoscape.js](https://js.cytoscape.org/) loaded from a CDN (`<script src="https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.30.2/cytoscape.min.js"></script>`). This is a pure JS library with no build requirements.

**Visual Design Requirements:**

Node colour by `type`:
| type | colour |
|---|---|
| `file` | `#4A90D9` (blue) |
| `class` | `#7B61FF` (purple) |
| `function` | `#50C878` (green) |
| `interface` | `#FFB347` (orange) |
| `variable` | `#87CEEB` (light blue) |
| `package` | `#FF6B6B` (red) |
| `route` | `#FFD700` (gold) |

Node size: `file` nodes scale by `metadata.churnScore` (min 20px, max 60px radius). All other nodes: 18px. Hot files (`metadata.hot === true`) get a bright red border (`border-color: #FF0000, border-width: 3`).

Edge colour by `type`:
| type | colour |
|---|---|
| `imports` | `#999` |
| `exports` | `#4A90D9` |
| `extends` | `#7B61FF` |
| `implements` | `#FFB347` |
| `calls` | `#50C878` |
| `depends_on` | `#FF6B6B` |
| all others | `#ccc` |

Layout: use `cose` (force-directed) as the default layout.

**UI panels the page must have:**

1. **Top bar** — shows repo name (last segment of path from manifest), node count, edge count, commit count (all from `manifest`).

2. **Left sidebar — Filters**
   - Checkboxes for each `NodeType` to show/hide that type
   - Checkboxes for each `EdgeType` to show/hide that edge type
   - Checkboxes for each `ArchitecturalLayer` (`presentation`, `business`, `data`, `config`, `test`, `infra`, `unclassified`) to filter by layer
   - "Hot files only" toggle (show only `metadata.hot === true` nodes and their edges)

3. **Right sidebar — Node Inspector**
   - Appears when a node is clicked
   - Shows: `id`, `name`, `type`, `filePath`, `layer`, `startLine`–`endLine`, `confidence`, `dataSource`, `churnScore`, `authorCount`, `lastModifiedAt`, `hot`
   - Lists all connected edges (source → type → target)

4. **Search bar** (top) — filters nodes by name substring match; highlights matching nodes, dims others.

5. **Legend** — small colour key for node types and edge types.

Fetch the data from `GET /api/graph` on page load using `fetch()`. Show a loading indicator while fetching.

---

### 4. Extend `bin/debob.ts`

Add a `visualise` command (alias: `viz`) to the existing `commander` program. Do not modify the existing `init` or `review` commands.

```
debob visualise [options]

Options:
  --repo <path>    Path to the repository root (default: current directory)
  --port <n>       Port to listen on (default: 7842)
```

**Action:**
1. Print an `ora` spinner: `"Reading graph from .debob/context.db..."`.
2. Call `startVisualiserServer(repo, { port })`.
3. Stop spinner with success.
4. Print with `chalk.green`: `"Graph visualiser running at <url>"`.
5. Print with `chalk.dim`: `"Press Ctrl+C to stop."`.
6. Call `open(url)` to open the browser automatically.
7. Keep the process alive (the HTTP server keeps the event loop open).
8. On `SIGINT` / `SIGTERM`: call `close()`, print `chalk.dim("Server stopped.")`, `process.exit(0)`.

---

## Constraints (non-negotiable)

- **No native Node addons** — no `better-sqlite3`, no native `tree-sitter`. Only WASM.
- **Do NOT change `web-tree-sitter` version** — stays at exact `"0.22.6"`.
- **No new bundlers or build-time tools** — no webpack, vite, esbuild for the front-end.
- **Strict TypeScript ESM** — all imports use `.js` extensions. `"type": "module"` in package.json.
- **No raw emails or secrets** in any served payload — the graph data is already safe (emails were SHA-256 hashed by the git extractor).
- **`npm run typecheck` must pass** with zero errors after your changes.

---

## Files You Will Create or Modify

| File | Action |
|---|---|
| `src/visualiser/server.ts` | **Create** — HTTP server + inline HTML |
| `bin/debob.ts` | **Modify** — add `visualise` command |
| `package.json` | **Modify** — add `open` to dependencies |

---

## Verification Steps

After implementation:

1. Run `npm run typecheck` — must exit 0 with zero errors.
2. Run `debob init` on the DeBob repo itself (it is a valid Git repo), confirm `.debob/context.db` is created.
3. Run `debob visualise` — browser should open, graph should render, filters and node inspector should work.
4. Write a `_test_visualiser.mjs` script that calls `startVisualiserServer(process.cwd(), { port: 7843 })`, fetches `/api/graph`, asserts `nodes.length > 0` and `edges.length > 0`, calls `close()`. Delete after passing.

---

## Graph Data Shape (for reference)

The `GET /api/graph` response will look like:

```json
{
  "manifest": {
    "version": "0.1.0",
    "schemaVersion": 1,
    "initAt": "2024-...",
    "repoPath": "/absolute/path/to/repo",
    "nodeCount": 142,
    "edgeCount": 89,
    "fileCount": 31,
    "commitCount": 47,
    "semantic": false
  },
  "nodes": [
    {
      "id": "src/engine/index.ts",
      "type": "file",
      "name": "index.ts",
      "filePath": "src/engine/index.ts",
      "confidence": 1.0,
      "dataSource": "static",
      "metadata": { "churnScore": 12, "authorCount": 2, "lastModifiedAt": "2024-...", "hot": true }
    },
    {
      "id": "src/engine/index.ts::runInit",
      "type": "function",
      "name": "runInit",
      "filePath": "src/engine/index.ts",
      "startLine": 104,
      "endLine": 268,
      "confidence": 1.0,
      "dataSource": "static"
    }
  ],
  "edges": [
    {
      "id": "src/engine/index.ts::imports::src/graph/builder.ts",
      "source": "src/engine/index.ts",
      "target": "src/graph/builder.ts",
      "type": "imports",
      "confidence": 1.0,
      "dataSource": "static"
    }
  ]
}
```

NodeType values: `'file' | 'function' | 'class' | 'interface' | 'variable' | 'route' | 'package'`
EdgeType values: `'imports' | 'exports' | 'calls' | 'depends_on' | 'extends' | 'implements' | 'instantiates' | 'exposes' | 'handles' | 'tests' | 'reads_from' | 'writes_to' | 'communicates_with' | 'configured_by' | 'related_to'`
ArchitecturalLayer values: `'presentation' | 'business' | 'data' | 'config' | 'test' | 'infra'`
