---
name: debob-query
description: Query the DeBob repository knowledge graph (.debob/context.db) to answer architecture, dependency, and file-responsibility questions without reading raw source files. Activate when the user asks what a file does, what imports something, which files are in a layer, which files are most volatile, or any similar structural question about the codebase.
---

# DeBob Graph Query Skill

Use this skill when the user asks any of the following about the repository:
- "What does file X do?"
- "What imports file X?" / "What depends on X?"
- "Which files are in the data / business / presentation layer?"
- "Which files change most often?" / "What are the hot files?"
- "What external packages does this repo use?"
- "What are the entry points?"
- "Is the graph up to date?"
- Any architecture, dependency, or responsibility question about the codebase.

**Core rule: never read raw source files.** Use the graph data and `semantic_enrichments` instead. This is the architectural invariant of DeBob.

---

## Step 1 — Check Prerequisites

Before querying, verify the graph exists:

```bash
# Check for DB and manifest
test -f .debob/context.db && echo "DB found" || echo "Run: npx debob init"
cat .debob/manifest.json 2>/dev/null | npx tsx -e "
  const m = JSON.parse(require('fs').readFileSync('.debob/manifest.json','utf8'));
  console.log('schemaVersion:', m.schemaVersion);
  console.log('initAt:', m.initAt);
  console.log('semantic:', m.semantic);
  console.log('headCommit:', m.headCommit);
"
```

- If `.debob/context.db` is missing → tell user: **"Run `npx debob init` first."**
- If `manifest.semantic === false` → enrichments not available; suggest `npx debob update --semantic` for responsibility/layer data.
- If more than 7 days old → suggest `npx debob update` to refresh.

---

## Step 2 — Staleness Check

Check if the graph is stale (new commits since last update):

```typescript
// _check_stale.mjs — run with: npx tsx _check_stale.mjs
import { readManifest } from './src/persistence/sqlite.js'
import simpleGit from 'simple-git'

const manifest = readManifest(process.cwd())
const head = (await simpleGit(process.cwd()).revparse(['HEAD'])).trim()
if (manifest?.headCommit && manifest.headCommit !== head) {
  console.log('STALE — run: npx debob update')
  console.log('  graph HEAD:', manifest.headCommit)
  console.log('  repo  HEAD:', head)
} else {
  console.log('UP TO DATE')
}
```

If stale, recommend `npx debob update` before answering the question.

---

## Step 3 — Opening the Database

All graph queries go through the adapter:

```typescript
// _query.mjs — run with: npx tsx _query.mjs
import { openDb, SqlitePersistenceAdapter } from './src/persistence/sqlite.js'

const { db, dbPath } = await openDb(process.cwd())
const adapter = new SqlitePersistenceAdapter(db, dbPath)
const graph = adapter.readGraph()
// graph.nodes: Map<string, Node>
// graph.edges: Edge[]
console.log('nodes:', graph.nodes.size, '| edges:', graph.edges.length)
// NOTE: do NOT call adapter.close() for read-only queries — the DB is in-memory;
// close() writes to disk and should only be called after mutations.
```

---

## Step 4 — Reading Semantic Enrichments

LLM-generated responsibilities and layers are stored separately:

```typescript
const enrichments = adapter.readSemanticEnrichments()
// Build lookup maps
const responsibility = new Map(
  enrichments.filter(e => e.field === 'responsibility').map(e => [e.nodeId, e.value])
)
const layer = new Map(
  enrichments.filter(e => e.field === 'layer').map(e => [e.nodeId, e.value])
)
```

---

## Step 5 — Common Query Patterns

### "What does file X do?"
```typescript
const nodeId = 'src/services/auth.ts'  // relative path from repo root
const node = graph.nodes.get(nodeId)
const resp = responsibility.get(nodeId) ?? node?.responsibility ?? '(no enrichment — run debob update --semantic)'
console.log(resp)
```

### "What imports file X?" (reverse dependencies)
```typescript
const nodeId = 'src/services/auth.ts'
const importers = graph.edges
  .filter(e => e.target === nodeId && e.type === 'imports')
  .map(e => e.source)
console.log('Imported by:', importers)
```

### "What does file X depend on?" (forward dependencies)
```typescript
const nodeId = 'src/services/auth.ts'
const deps = graph.edges
  .filter(e => e.source === nodeId && e.type === 'imports')
  .map(e => e.target)
console.log('Imports:', deps)
```

### "Which files are in the data layer?"
```typescript
// Option 1: from Node.layer (populated after --semantic run with layer propagation)
const dataFiles = Array.from(graph.nodes.values())
  .filter(n => n.layer === 'data')
  .map(n => n.id)

// Option 2: from semantic_enrichments (works even before propagation)
const dataFromEnrichments = enrichments
  .filter(e => e.field === 'layer' && e.value === 'data')
  .map(e => e.nodeId)
```

### "Which files are most volatile / hot?"
```typescript
const hotFiles = Array.from(graph.nodes.values())
  .filter(n => n.metadata?.hot === true)
  .sort((a, b) => (b.metadata?.churnScore ?? 0) - (a.metadata?.churnScore ?? 0))
  .slice(0, 10)
hotFiles.forEach(n => console.log(n.id, '| churn:', n.metadata?.churnScore))
```

### "What external packages does this repo use?"
```typescript
const packages = Array.from(graph.nodes.values())
  .filter(n => n.type === 'package')
  .map(n => n.name)
console.log(packages)
```

### "What are the entry points?"
```typescript
// Files with many incoming imports but few outgoing (likely API/route files)
const incomingCount = new Map<string, number>()
for (const edge of graph.edges.filter(e => e.type === 'imports')) {
  incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1)
}
const candidates = Array.from(graph.nodes.values())
  .filter(n => n.type === 'file')
  .map(n => ({ id: n.id, incoming: incomingCount.get(n.id) ?? 0 }))
  .sort((a, b) => b.incoming - a.incoming)
  .slice(0, 5)
console.log(candidates)
```

---

## Step 6 — Assembling a ModuleContext for LLM

Only call the LLM if no `semantic_enrichments` row exists for a node (avoid redundant calls):

```typescript
import { buildModuleContext } from './src/query/index.js'

const nodeId = 'src/services/auth.ts'
if (!responsibility.has(nodeId)) {
  // No cached enrichment — build a context slice for the LLM
  const node = graph.nodes.get(nodeId)
  if (node) {
    const context = buildModuleContext(node, graph)
    // context.imports, context.exports, context.declarations, context.gitStats
    // Pass context to llm.summarizeModule(context) — never send raw source
    console.log(JSON.stringify(context, null, 2))
  }
}
```

---

## Architectural Invariants (NEVER violate)

1. **Never read raw source files** — use graph nodes, edges, and `semantic_enrichments`
2. **Never send full file content to the LLM** — only `ModuleContext` slices from `buildModuleContext`
3. **Always use `openDb` + `SqlitePersistenceAdapter`** — never import `sql.js` directly
4. **`adapter.close()` only after mutations** — read-only queries do not need it
5. **The graph lives in `.debob/context.db`** — never in per-file JSON files
