# Analyze @debob-plan.md  and begin implementing subtask 9 , adhere to all instructions present in @AGENTS.md and @.bob\ , once it is completed and verified update debob-plan.md and PROGRESS.md

---

**Status:** active  **Date:** 2026-08-28

---

### 👤 User

Analyze @debob-plan.md  and begin implementing subtask 9 , adhere to all instructions present in @AGENTS.md and @.bob\ , once it is completed and verified update debob-plan.md and PROGRESS.md

The user has referenced the following files/folders.
Use your file reading tools to access their content if needed.

- debob-plan.md
- AGENTS.md
- .bob\ (folder):
  rules-agent
  rules-ask
  rules-plan

---

### 🤖 Assistant

> 🔧 called: use_skill



> 🔧 **use_skill** — create-plan

### 🤖 Assistant

> 🔧 called: read_file, read_file, read_file

Now let me read the key reference files in parallel to understand the full scope before proceeding.

> 🔧 **read_file** — PROGRESS.md

> 🔧 **read_file** — AGENTS.md

> 🔧 **read_file** — debob-plan.md

### 🤖 Assistant

> 🔧 called: read_file, read_file

Now let me read the Sub-Task 9 spec from the plan, plus the existing engine and current bin/debob.ts placeholder:

> 🔧 **read_file** — debob-plan.md

> 🔧 **read_file** — bin/debob.ts

### 🤖 Assistant

> 🔧 called: read_file, read_file

Now let me explore the engine and related files to understand what's available:

> 🔧 **read_file** — src/engine/index.ts

> 🔧 **read_file** — src/llm/adapter.ts

### 🤖 Assistant

> 🔧 called: read_file, read_file

Now let me check the package.json for installed dependencies (chalk, ora, commander) and the tsup config:

> 🔧 **read_file** — tsup.config.ts

> 🔧 **read_file** — package.json

### 🤖 Assistant

> 🔧 called: ask_followup_question

I have a thorough understanding of the codebase. The plan is clear and grounded. Let me now switch to agent mode to implement Sub-Task 9.

Here's a concise summary of what I'll implement before switching:

**Sub-Task 9 — CLI Entry Point** involves replacing the placeholder [`bin/debob.ts`](bin/debob.ts) with the full implementation:

1. **`init` command action** — reads `--repo`, `--max-commits`, `--semantic`, `--verbose` options; wires up an `ora` spinner; calls `runInit()`; renders a rich `chalk`-colored summary (files by language, nodes by type, edges, git commits, top-5 hot files, layer distribution, package deps, db path)
2. **`--semantic` path** — reads `WATSONX_API_KEY`, `WATSONX_PROJECT_ID`, `WATSONX_ENDPOINT` from env; calls `createLLMAdapter` if all vars present, warns and skips if not; since `createLLMAdapter` lives in Sub-Task 10 (not yet implemented), the CLI will stub it defensively
3. **`review` stub** — already present, just needs `chalk.yellow()` wrapping
4. **Error handling** — try/catch → `chalk.red` → `process.exit(1)`
5. **`tsup.config.ts`** already has `banner: { js: '#!/usr/bin/env node' }` — no change needed

One design question before I proceed:

### 🤖 Assistant

Sub-Task 10 (LLM layer / `createLLMAdapter`) is not yet implemented. The `--semantic` flag in Sub-Task 9 needs to call it. How should the CLI handle this gap?

> 🔧 **ask_followup_question** — Sub-Task 10 (LLM layer / `createLLMAdapter`) is not yet implemented. The `--semantic` flag in Sub-Task 9 needs to call it. How should the CLI handle this gap?

### 🤖 Assistant

> 🔧 called: list_files

The plan also says to import `createLLMAdapter` from `src/llm/index.ts` — which doesn't exist yet. I need to check what's there and create a minimal stub so the import resolves at typecheck time:

> 🔧 **list_files** — src/llm

### 🤖 Assistant

> 🔧 called: switch_mode, update_todo_list, write_file, update_todo_list

`src/llm/index.ts` doesn't exist yet. I'll need to create a minimal stub for it so the CLI import resolves. Now switching to agent mode to implement.

> 🔧 **switch_mode** — agent

> 🔧 **update_todo_list** — 
[ ] Create src/llm/index.ts stub (createLLMAdapter)
[ ] Implement bin/debob.ts full CLI
[ ] Run npm run typecheck — must pass zero errors
[ ] Write and run _test_9.mjs ad-hoc test, then delete
[ ] Update debob-plan.md and PROGRESS.md


> 🔧 **write_file** — src/llm/index.ts

> 🔧 **update_todo_list** — 
[x] Create src/llm/index.ts stub (createLLMAdapter)
[-] Implement bin/debob.ts full CLI
[ ] Run npm run typecheck — must pass zero errors
[ ] Write and run _test_9.mjs ad-hoc test, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: write_file

Now let me implement the full CLI. I need to look at what `InitResult` returns to know how to render the summary precisely:

> 🔧 **write_file** — bin/debob.ts

### 🤖 Assistant

> 🔧 called: execute_command, execute_command

Now run typecheck:

> 🔧 **execute_command** — npm run typecheck 2>&1

> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run typecheck 2>&1

### 🤖 Assistant

> 🔧 called: update_todo_list, write_file, execute_command

Typecheck passes with zero errors. Now let me write and run the ad-hoc test:

> 🔧 **update_todo_list** — 
[x] Create src/llm/index.ts stub (createLLMAdapter)
[x] Implement bin/debob.ts full CLI
[x] Run npm run typecheck — must pass zero errors
[-] Write and run _test_9.mjs ad-hoc test, then delete
[ ] Update debob-plan.md and PROGRESS.md


> 🔧 **write_file** — _test_9.mjs

> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" --import tsx/esm _test_9.mjs 2>&1

### 🤖 Assistant

> 🔧 called: execute_command, update_todo_list

All 17 tests pass. Delete the test file and update the progress docs:

> 🔧 **execute_command** — Remove-Item _test_9.mjs

> 🔧 **update_todo_list** — 
[x] Create src/llm/index.ts stub (createLLMAdapter)
[x] Implement bin/debob.ts full CLI
[x] Run npm run typecheck — must pass zero errors
[x] Write and run _test_9.mjs ad-hoc test, then delete
[-] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: apply_diff, apply_diff, update_todo_list

Now update both docs:

> 🔧 **apply_diff** — debob-plan.md

> 🔧 **apply_diff** — PROGRESS.md

> 🔧 **update_todo_list** — 
[x] Create src/llm/index.ts stub (createLLMAdapter)
[x] Implement bin/debob.ts full CLI
[x] Run npm run typecheck — must pass zero errors
[x] Write and run _test_9.mjs ad-hoc test, then delete
[x] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

Sub-Task 9 is complete. Here's a summary of everything delivered:

---

## Sub-Task 9 — CLI Entry Point ✅

### Files created / modified

**[`bin/debob.ts`](bin/debob.ts)** — Full replacement of the scaffold placeholder:
- `#!/usr/bin/env node` shebang (tsup already adds it via `banner.js`)
- `init` command with `--repo`, `--max-commits`, `--semantic`, `--verbose` options
- `ora` spinner during engine run; `.succeed()` / `.fail()` on completion
- Rich `chalk`-colored summary: file count, node/edge counts, git commit count, layer distribution (sorted by count), top-5 hot files with churn scores, external packages (truncated at 10 + count), absolute DB path
- `--semantic` guard: reads `WATSONX_*` env vars → calls `createLLMAdapter` → warns and skips if vars missing or adapter throws (forward-compatible with Sub-Task 10)
- `review` stub prints `chalk.yellow('debob review — coming soon')`
- Wraps action in try/catch → `chalk.red` error + `process.exit(1)` on failure

**[`src/llm/index.ts`](src/llm/index.ts)** — New minimal stub:
- `createLLMAdapter(provider, config): LLMAdapter` factory
- Throws `"not yet implemented"` so the CLI can catch and warn gracefully until Sub-Task 10 lands

### Verification
- `npm run typecheck` — ✅ zero errors
- 17/17 ad-hoc tests passed: `--help`, `init --help`, `review`, `init` on the DeBob repo (full pipeline, `.debob/context.db` created, summary rendered correctly)

---

### 👤 User

Analyze @debob-plan.md  and begin implementing subtask 10  , adhere to all instructions present in @AGENTS.md and @.bob\ , once it is completed and verified update debob-plan.md and PROGRESS.md

---

### 🤖 Assistant

> 🔧 called: use_skill



> 🔧 **use_skill** — create-plan

### 🤖 Assistant

> 🔧 called: read_file, read_file, read_file, read_file

Let me read the Sub-Task 10 spec and all relevant existing files before planning:

> 🔧 **read_file** — debob-plan.md

> 🔧 **read_file** — src/query/index.ts

> 🔧 **read_file** — src/graph/types.ts

> 🔧 **read_file** — src/llm/index.ts

### 🤖 Assistant

> 🔧 called: switch_mode, update_todo_list

Now I have everything I need. Let me switch to agent mode and implement Sub-Task 10.

Here is what the sub-task requires:

1. **[`src/query/index.ts`](src/query/index.ts)** — add `getNodeNeighbours` and `getNodeEdges` (already partly there), plus flesh out the module
2. **[`src/llm/context.ts`](src/llm/context.ts)** — new file: `buildModuleContext` moved/improved here (currently lives in `src/query/index.ts` as a stub)
3. **[`src/llm/adapter.ts`](src/llm/adapter.ts)** — add JSDoc to each method
4. **[`src/llm/providers/watsonx.ts`](src/llm/providers/watsonx.ts)** — new file: `WatsonxAdapter` using Node's built-in `fetch`
5. **[`src/llm/index.ts`](src/llm/index.ts)** — update factory to wire `WatsonxAdapter`

> 🔧 **switch_mode** — agent

> 🔧 **update_todo_list** — 
[ ] src/query/index.ts — add getNodeNeighbours helper
[ ] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[ ] src/llm/adapter.ts — add JSDoc to each method
[ ] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[ ] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[ ] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: apply_diff, update_todo_list

**Step 1** — add `getNodeNeighbours` to `src/query/index.ts`. The existing file already has `getNodeEdges`, `getFileImports`, `getFileExports`, and `buildModuleContext`. The spec asks to add `getNodeNeighbours`. I'll also keep `buildModuleContext` here (the engine already imports it from this path) but also export it from `src/llm/context.ts` so both paths work cleanly.

> 🔧 **apply_diff** — src/query/index.ts

> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[-] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[ ] src/llm/adapter.ts — add JSDoc to each method
[ ] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[ ] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[ ] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: write_file, update_todo_list

**Step 2** — create `src/llm/context.ts`. The spec says `buildModuleContext(node, graph, gitStats?)` lives here. The engine already calls `buildModuleContext` from `src/query/index.ts`, so I'll keep that export there and have `src/llm/context.ts` re-export it (single source of truth in query, context.ts is the canonical LLM-layer entry point).

> 🔧 **write_file** — src/llm/context.ts

> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[-] src/llm/adapter.ts — add JSDoc to each method
[ ] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[ ] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[ ] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: apply_diff, update_todo_list

**Step 3** — add JSDoc to `LLMAdapter` methods in `src/llm/adapter.ts`. The interface already has JSDoc; the spec says to add "which debob command uses it and what context it expects" — the existing comments already cover this. I'll enhance them slightly to be explicit:

> 🔧 **apply_diff** — src/llm/adapter.ts

> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[-] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[ ] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[ ] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: write_file, update_todo_list

**Step 4** — create `src/llm/providers/watsonx.ts` with `WatsonxAdapter`:

> 🔧 **write_file** — import type { LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext } from '../adapter.js'

// ─── Watsonx REST API constants ───────────────────────────────────────────────

const WATSONX_API_VERSION = '2023-05-29'

// ─── Prompt builders ─────────────────────────────────────────────────────────

/**
 * Build a structured text prompt from a ModuleContext.
 * NEVER includes raw source code — only graph-derived metadata.
 */
function buildModulePrompt(ctx: ModuleContext): string {
  const lines: string[] = [
    `File: ${ctx.filePath}`,
    '',
    `Imports (${ctx.imports.length}):`,
    ...ctx.imports.map(i => `  - ${i}`),
    '',
    `Exports (${ctx.exports.length}):`,
    ...ctx.exports.map(e => `  - ${e}`),
    '',
    `Declarations (${ctx.declarations.length}):`,
    ...ctx.declarations.map(d =>
      `  - ${d.type} ${d.name}${d.startLine != null ? ` (line ${d.startLine})` : ''}`,
    ),
  ]

  if (ctx.gitStats) {
    lines.push(
      '',
      `Git stats:`,
      `  - Churn score   : ${ctx.gitStats.churnScore}`,
      `  - Author count  : ${ctx.gitStats.authorCount}`,
      `  - Last modified : ${ctx.gitStats.lastModifiedAt}`,
    )
  }

  return lines.join('\n')
}

// ─── WatsonxAdapter ───────────────────────────────────────────────────────────

/**
 * IBM watsonx text-generation LLM adapter.
 *
 * Uses the REST API endpoint `POST /ml/v1/text/generation?version=2023-05-29`.
 * Credentials are read from the `LLMConfig` passed at construction time — they
 * are sourced exclusively from environment variables by the CLI; this class
 * never reads process.env directly.
 *
 * The adapter NEVER receives or sends raw source code.
 * All input is structured `ModuleContext` slices assembled by the context builder.
 */
export class WatsonxAdapter implements LLMAdapter {
  /** Identifies this provider for storage in `semantic_enrichments.llmProvider`. */
  readonly provider = 'watsonx'

  private readonly apiKey: string
  private readonly projectId: string
  private readonly endpoint: string
  /** Defaults to granite-13b-instruct-v2 if not specified. */
  readonly modelId: string

  constructor(config: LLMConfig) {
    if (!config.apiKey) throw new Error('WatsonxAdapter: apiKey is required')
    if (!config.projectId) throw new Error('WatsonxAdapter: projectId is required')
    if (!config.endpoint) throw new Error('WatsonxAdapter: endpoint is required')

    this.apiKey = config.apiKey
    this.projectId = config.projectId
    this.endpoint = config.endpoint.replace(/\/$/, '') // strip trailing slash
    this.modelId = config.modelId ?? 'ibm/granite-13b-instruct-v2'
  }

  // ─── summarizeModule ───────────────────────────────────────────────────────

  /**
   * Ask the LLM to summarize a module's responsibility from its graph slice.
   * Called by `debob init --semantic` for each file node.
   */
  async summarizeModule(context: ModuleContext): Promise<string> {
    const modulePrompt = buildModulePrompt(context)
    const input = [
      'You are a software architecture assistant.',
      'Given the following module metadata (no source code), write one concise sentence',
      'describing the module\'s primary responsibility.',
      '',
      modulePrompt,
      '',
      'Responsibility:',
    ].join('\n')

    return this._generate(input)
  }

  // ─── classifyLayer ─────────────────────────────────────────────────────────

  /**
   * Ask the LLM to infer the architectural layer from a module's graph slice.
   * Called by `debob init --semantic` for each file node.
   * Returns one of: presentation | business | data | config | test | infra
   */
  async classifyLayer(context: ModuleContext): Promise<string> {
    const modulePrompt = buildModulePrompt(context)
    const input = [
      'You are a software architecture assistant.',
      'Given the following module metadata (no source code), classify the module into exactly',
      'one of these architectural layers: presentation, business, data, config, test, infra.',
      'Respond with only the single layer name — no explanation.',
      '',
      modulePrompt,
      '',
      'Layer:',
    ].join('\n')

    const raw = await this._generate(input)
    // Normalize to lower-case and strip punctuation / extra whitespace
    return raw.trim().toLowerCase().replace(/[^a-z]/g, '') || 'unclassified'
  }

  // ─── explainDiff (stub) ────────────────────────────────────────────────────

  /**
   * @throws Always — implemented in `debob review` (Sub-Task future).
   */
  async explainDiff(_context: DiffContext): Promise<string> {
    throw new Error('WatsonxAdapter.explainDiff: not yet implemented (debob review)')
  }

  // ─── answerQuestion (stub) ─────────────────────────────────────────────────

  /**
   * @throws Always — implemented in `debob explain` (Sub-Task future).
   */
  async answerQuestion(_context: QueryContext): Promise<string> {
    throw new Error('WatsonxAdapter.answerQuestion: not yet implemented (debob explain)')
  }

  // ─── Internal HTTP helper ──────────────────────────────────────────────────

  /**
   * Call the watsonx text generation REST endpoint and return the generated text.
   *
   * Endpoint: POST {endpoint}/ml/v1/text/generation?version=2023-05-29
   * Body: { model_id, project_id, input, parameters: { max_new_tokens: 256 } }
   * Auth: Bearer {apiKey}
   */
  private async _generate(input: string): Promise<string> {
    const url = `${this.endpoint}/ml/v1/text/generation?version=${WATSONX_API_VERSION}`

    const body = JSON.stringify({
      model_id: this.modelId,
      project_id: this.projectId,
      input,
      parameters: { max_new_tokens: 256 },
    })

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '(no body)')
      throw new Error(`WatsonxAdapter: HTTP ${response.status} from ${url} — ${text}`)
    }

    const json = await response.json() as {
      results?: Array<{ generated_text?: string }>
    }

    const generated = json.results?.[0]?.generated_text
    if (typeof generated !== 'string') {
      throw new Error(`WatsonxAdapter: unexpected response shape — ${JSON.stringify(json)}`)
    }

    return generated.trim()
  }
}


> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[x] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[-] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[ ] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: write_file, update_todo_list

**Step 5** — update `src/llm/index.ts` to wire `WatsonxAdapter`:

> 🔧 **write_file** — import type { LLMAdapter } from './adapter.js'
import type { LLMConfig } from './adapter.js'
import { WatsonxAdapter } from './providers/watsonx.js'

// ─── LLM Adapter Factory ──────────────────────────────────────────────────────

/**
 * Create an LLMAdapter for the given provider.
 *
 * V1 supported providers:
 *  - `"watsonx"` → `WatsonxAdapter` (IBM watsonx REST API)
 *
 * Future providers are added by importing their class and extending the switch.
 *
 * @throws If `provider` is not a recognised value.
 */
export function createLLMAdapter(provider: string, config: LLMConfig): LLMAdapter {
  switch (provider) {
    case 'watsonx':
      return new WatsonxAdapter(config)
    default:
      throw new Error(
        `createLLMAdapter: unknown provider "${provider}". Supported: "watsonx"`,
      )
  }
}

export type { LLMAdapter, LLMConfig }
export { WatsonxAdapter }


> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[x] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[x] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[-] npm run typecheck — must pass zero errors
[ ] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

> 🔧 called: execute_command

**Step 6** — typecheck:

> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run typecheck 2>&1

### 🤖 Assistant

> 🔧 called: update_todo_list, write_file, execute_command

Zero errors. Now write and run the ad-hoc test:

> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[x] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[x] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[x] npm run typecheck — must pass zero errors
[-] Write and run _test_10.mjs, then delete
[ ] Update debob-plan.md and PROGRESS.md


> 🔧 **write_file** — /**
 * Ad-hoc test for Sub-Task 10 — LLM Adapter + watsonx + Context Builder
 *
 * Tests (no network calls — watsonx calls are mocked):
 *  1. getNodeNeighbours returns correct nodes at depth 1 and depth 2
 *  2. buildModuleContext (context.ts) assembles correct imports/exports/declarations/gitStats
 *  3. createLLMAdapter throws for unknown provider
 *  4. createLLMAdapter returns WatsonxAdapter for "watsonx"
 *  5. WatsonxAdapter constructor validates required config fields
 *  6. WatsonxAdapter.summarizeModule constructs expected prompt and calls fetch correctly
 *  7. WatsonxAdapter.classifyLayer normalises response to lower-case
 *  8. WatsonxAdapter.explainDiff and answerQuestion throw "not yet implemented"
 *  9. Prompt contains filePath, imports, exports, declarations — NOT raw source
 */

import { fileURLToPath } from 'url'
import { join } from 'path'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// ─── Dynamic imports (ESM) ────────────────────────────────────────────────────

const { getNodeNeighbours, getNodeEdges, getFileImports, getFileExports } =
  await import(join(__dirname, 'src/query/index.js'))
const { buildModuleContext } =
  await import(join(__dirname, 'src/llm/context.js'))
const { createLLMAdapter, WatsonxAdapter } =
  await import(join(__dirname, 'src/llm/index.js'))

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Build a minimal in-memory graph for testing. */
function makeGraph() {
  const nodes = new Map()

  const addNode = (id, type, filePath, name, extra = {}) => {
    nodes.set(id, { id, type, filePath, name, confidence: 1.0, dataSource: 'static', ...extra })
  }

  addNode('src/a.ts', 'file', 'src/a.ts', 'a.ts', {
    metadata: { churnScore: 3.5, authorCount: 2, lastModifiedAt: '2024-01-01' },
  })
  addNode('src/b.ts', 'file', 'src/b.ts', 'b.ts')
  addNode('src/c.ts', 'file', 'src/c.ts', 'c.ts')
  addNode('src/a.ts::MyClass', 'class', 'src/a.ts', 'MyClass', { startLine: 10 })
  addNode('src/a.ts::myFn', 'function', 'src/a.ts', 'myFn', { startLine: 30 })
  addNode('pkg::chalk', 'package', 'pkg::chalk', 'chalk')

  const edges = [
    { id: 'src/a.ts::imports::src/b.ts', source: 'src/a.ts', target: 'src/b.ts', type: 'imports', confidence: 1.0, dataSource: 'static' },
    { id: 'src/a.ts::imports::pkg::chalk', source: 'src/a.ts', target: 'pkg::chalk', type: 'imports', confidence: 1.0, dataSource: 'static' },
    { id: 'src/a.ts::exports::src/a.ts::MyClass', source: 'src/a.ts', target: 'src/a.ts::MyClass', type: 'exports', confidence: 1.0, dataSource: 'static' },
    { id: 'src/b.ts::imports::src/c.ts', source: 'src/b.ts', target: 'src/c.ts', type: 'imports', confidence: 1.0, dataSource: 'static' },
  ]

  return { nodes, edges }
}

let passed = 0
let failed = 0

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`)
    passed++
  } else {
    console.error(`  ❌ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function assertThrows(label, fn, messageIncludes) {
  try {
    fn()
    console.error(`  ❌ ${label}: expected throw but did not throw`)
    failed++
  } catch (e) {
    if (messageIncludes && !e.message.includes(messageIncludes)) {
      console.error(`  ❌ ${label}: threw but message "${e.message}" doesn't include "${messageIncludes}"`)
      failed++
    } else {
      console.log(`  ✅ ${label}`)
      passed++
    }
  }
}

async function assertThrowsAsync(label, fn, messageIncludes) {
  try {
    await fn()
    console.error(`  ❌ ${label}: expected throw but did not throw`)
    failed++
  } catch (e) {
    if (messageIncludes && !e.message.includes(messageIncludes)) {
      console.error(`  ❌ ${label}: threw but message "${e.message}" doesn't include "${messageIncludes}"`)
      failed++
    } else {
      console.log(`  ✅ ${label}`)
      passed++
    }
  }
}

// ─── Test 1: getNodeNeighbours ────────────────────────────────────────────────

console.log('\nTest 1: getNodeNeighbours')
const graph = makeGraph()

const depth1 = getNodeNeighbours(graph, 'src/a.ts', 1)
const depth1Ids = depth1.map(n => n.id).sort()
assert('depth=1 finds src/b.ts', depth1Ids.includes('src/b.ts'))
assert('depth=1 finds pkg::chalk', depth1Ids.includes('pkg::chalk'))
assert('depth=1 finds MyClass export', depth1Ids.includes('src/a.ts::MyClass'))
assert('depth=1 does not include self', !depth1Ids.includes('src/a.ts'))

const depth2 = getNodeNeighbours(graph, 'src/a.ts', 2)
const depth2Ids = depth2.map(n => n.id)
assert('depth=2 also finds src/c.ts (via b.ts)', depth2Ids.includes('src/c.ts'))

const depth0 = getNodeNeighbours(graph, 'src/a.ts', 0)
assert('depth=0 returns empty array', depth0.length === 0)

// ─── Test 2: buildModuleContext (context.ts) ──────────────────────────────────

console.log('\nTest 2: buildModuleContext')
const nodeA = graph.nodes.get('src/a.ts')
const ctx = buildModuleContext(nodeA, graph)

assert('filePath is correct', ctx.filePath === 'src/a.ts')
assert('imports includes src/b.ts', ctx.imports.includes('src/b.ts'))
assert('imports includes pkg::chalk', ctx.imports.includes('pkg::chalk'))
assert('exports includes src/a.ts::MyClass', ctx.exports.includes('src/a.ts::MyClass'))
assert('declarations has MyClass', ctx.declarations.some(d => d.name === 'MyClass' && d.type === 'class'))
assert('declarations has myFn', ctx.declarations.some(d => d.name === 'myFn' && d.type === 'function'))
assert('gitStats.churnScore === 3.5', ctx.gitStats?.churnScore === 3.5)
assert('gitStats.authorCount === 2', ctx.gitStats?.authorCount === 2)

// Test with no metadata (node B)
const nodeB = graph.nodes.get('src/b.ts')
const ctxB = buildModuleContext(nodeB, graph)
assert('gitStats is undefined when no metadata', ctxB.gitStats === undefined)

// Test explicit gitStats override
const explicit = { churnScore: 99, authorCount: 5, lastModifiedAt: '2025-01-01' }
const ctxExplicit = buildModuleContext(nodeA, graph, explicit)
assert('explicit gitStats override respected', ctxExplicit.gitStats?.churnScore === 99)

// ─── Test 3: createLLMAdapter — unknown provider ──────────────────────────────

console.log('\nTest 3: createLLMAdapter unknown provider')
assertThrows('throws for unknown provider', () => {
  createLLMAdapter('openai', { provider: 'openai' })
}, 'unknown provider')

// ─── Test 4: createLLMAdapter — watsonx ──────────────────────────────────────

console.log('\nTest 4: createLLMAdapter watsonx')
const adapter = createLLMAdapter('watsonx', {
  provider: 'watsonx',
  apiKey: 'test-key',
  projectId: 'test-project',
  endpoint: 'https://fake.watsonx.ibm.com',
})
assert('returns WatsonxAdapter instance', adapter instanceof WatsonxAdapter)
assert('provider property is "watsonx"', adapter.provider === 'watsonx')
assert('modelId defaults to granite', adapter.modelId.includes('granite'))

// ─── Test 5: WatsonxAdapter constructor validation ────────────────────────────

console.log('\nTest 5: WatsonxAdapter constructor validation')
assertThrows('throws when apiKey missing', () => {
  new WatsonxAdapter({ provider: 'watsonx', projectId: 'p', endpoint: 'e' })
}, 'apiKey is required')
assertThrows('throws when projectId missing', () => {
  new WatsonxAdapter({ provider: 'watsonx', apiKey: 'k', endpoint: 'e' })
}, 'projectId is required')
assertThrows('throws when endpoint missing', () => {
  new WatsonxAdapter({ provider: 'watsonx', apiKey: 'k', projectId: 'p' })
}, 'endpoint is required')

// ─── Test 6: WatsonxAdapter.summarizeModule (mocked fetch) ───────────────────

console.log('\nTest 6: summarizeModule (mocked fetch)')

let capturedUrl = null
let capturedBody = null

const originalFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  capturedUrl = url
  capturedBody = JSON.parse(opts.body)
  return {
    ok: true,
    json: async () => ({ results: [{ generated_text: '  Auth service  ' }] }),
  }
}

const wa = new WatsonxAdapter({
  provider: 'watsonx',
  apiKey: 'key1',
  projectId: 'proj1',
  endpoint: 'https://fake.example.com/',
})

const summary = await wa.summarizeModule(ctx)
assert('returns trimmed text', summary === 'Auth service')
assert('URL contains /ml/v1/text/generation', capturedUrl?.includes('/ml/v1/text/generation'))
assert('URL contains version param', capturedUrl?.includes('version=2023-05-29'))
assert('body has model_id', capturedBody?.model_id === 'ibm/granite-13b-instruct-v2')
assert('body has project_id', capturedBody?.project_id === 'proj1')
assert('input contains filePath', capturedBody?.input?.includes('src/a.ts'))
assert('input contains imports section', capturedBody?.input?.includes('Imports'))
assert('input contains declarations section', capturedBody?.input?.includes('Declarations'))
assert('input does NOT contain source code keyword', !capturedBody?.input?.includes('export class') && !capturedBody?.input?.includes('function myFn'))
assert('trailing slash stripped from endpoint', !capturedUrl?.includes('//ml'))
assert('max_new_tokens is 256', capturedBody?.parameters?.max_new_tokens === 256)

// ─── Test 7: classifyLayer normalisation ──────────────────────────────────────

console.log('\nTest 7: classifyLayer normalisation')

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ results: [{ generated_text: '  Business\n' }] }),
})

const layer = await wa.classifyLayer(ctx)
assert('classifyLayer returns normalised "business"', layer === 'business', `got "${layer}"`)

globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ results: [{ generated_text: 'data.' }] }),
})
const layer2 = await wa.classifyLayer(ctx)
assert('strips punctuation → "data"', layer2 === 'data', `got "${layer2}"`)

// ─── Test 8: explainDiff and answerQuestion throw ─────────────────────────────

console.log('\nTest 8: stubs throw "not yet implemented"')
await assertThrowsAsync('explainDiff throws', () => wa.explainDiff({}), 'not yet implemented')
await assertThrowsAsync('answerQuestion throws', () => wa.answerQuestion({}), 'not yet implemented')

// ─── Test 9: HTTP error handling ──────────────────────────────────────────────

console.log('\nTest 9: HTTP error handling')
globalThis.fetch = async () => ({
  ok: false,
  status: 401,
  text: async () => 'Unauthorized',
})
await assertThrowsAsync('throws on HTTP error', () => wa.summarizeModule(ctx), 'HTTP 401')

// Restore fetch
globalThis.fetch = originalFetch

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('\n✅ All Sub-Task 10 tests passed.')


> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" --import tsx/esm _test_10.mjs 2>&1

### 🤖 Assistant

> 🔧 called: apply_diff, execute_command

The dynamic `import()` with a Windows absolute path fails on Node ESM. I need to use `file://` URLs for the dynamic imports:

> 🔧 **apply_diff** — _test_10.mjs

> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" --import tsx/esm _test_10.mjs 2>&1

### 🤖 Assistant

> 🔧 called: apply_diff, execute_command

38/39 pass. The one failure is my own test assertion being too strict — it was checking `!includes('export class')` but the prompt *does* contain the word "declarations" with the class name `MyClass`. Let me check what's actually in the prompt:

The assertion checked `!capturedBody?.input?.includes('export class')` which should be `true` (no `export class` in the structured prompt), AND `!capturedBody?.input?.includes('function myFn')` — but `function myFn` was in the declarations output as `function myFn`. The prompt format is `- function myFn (line 30)` which does contain `function myFn`. The intent of the test was to verify no raw source code — the declaration listing itself says "function myFn" which is fine and expected. The test assertion was wrong, not the code. Let me fix the assertion to be accurate:

> 🔧 **apply_diff** — <<<<<<< SEARCH
:start_line:190
-------
assert('input does NOT contain source code keyword', !capturedBody?.input?.includes('export class') && !capturedBody?.input?.includes('function myFn'))
=======
assert('input does NOT contain raw source code', !capturedBody?.input?.includes('const ') && !capturedBody?.input?.includes('return ') && !capturedBody?.input?.includes('{') )
>>>>>>> REPLACE


> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" --import tsx/esm _test_10.mjs 2>&1

### 🤖 Assistant

> 🔧 called: execute_command, update_todo_list, apply_diff, apply_diff

39/39 passing. Delete test file and update docs:

> 🔧 **execute_command** — Remove-Item _test_10.mjs

> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[x] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[x] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[x] npm run typecheck — must pass zero errors
[x] Write and run _test_10.mjs, then delete
[-] Update debob-plan.md and PROGRESS.md


> 🔧 **apply_diff** — debob-plan.md

> 🔧 **apply_diff** — PROGRESS.md

### 🤖 Assistant

> 🔧 called: apply_diff, update_todo_list

Now update the preview section in PROGRESS.md for the next sub-task:

> 🔧 **apply_diff** — <<<<<<< SEARCH
:start_line:191
-------
## Sub-Task 10 Preview — LLM Adapter + watsonx + Context Builder (NEXT)

Files: `src/llm/index.ts` (factory), `src/llm/context.ts`, `src/llm/providers/watsonx.ts`, `src/query/index.ts`

Implements `WatsonxAdapter`, `buildModuleContext`, and `createLLMAdapter` factory.
CLI already wires `--semantic` → `createLLMAdapter` — will activate once Sub-Task 10 lands.
=======
## Sub-Task 11 Preview — Architecture Documentation (NEXT)

Files: `docs/architecture.md` (new), `README.md` (update)

Write the canonical reference document covering all components, the graph model, DB schema,
incremental update design, LLM architecture, and extension guides.
>>>>>>> REPLACE


> 🔧 **update_todo_list** — 
[x] src/query/index.ts — add getNodeNeighbours helper
[x] src/llm/context.ts — new file: buildModuleContext (graph → ModuleContext)
[x] src/llm/adapter.ts — add JSDoc to each method
[x] src/llm/providers/watsonx.ts — new file: WatsonxAdapter
[x] src/llm/index.ts — wire WatsonxAdapter into createLLMAdapter factory
[x] npm run typecheck — must pass zero errors
[x] Write and run _test_10.mjs, then delete
[x] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

Sub-Task 10 is complete. Here's a full summary:

---

## Sub-Task 10 — LLM Adapter + watsonx + Context Builder ✅

### Files created / modified

**[`src/query/index.ts`](src/query/index.ts)** — Added `getNodeNeighbours(graph, nodeId, depth): Node[]`:
- BFS traversal, both directions (source→target and target→source)
- `depth=0` returns empty array; `depth=1` immediate neighbours; etc.

**[`src/llm/context.ts`](src/llm/context.ts)** — New file: canonical LLM-layer context builder:
- `buildModuleContext(node, graph, gitStats?)` — assembles `ModuleContext` from graph edges, symbol nodes, and git metadata
- Accepts optional explicit `gitStats` override, falls back to `node.metadata`
- Imports `getFileImports`/`getFileExports` from `src/query/index.ts`

**[`src/llm/adapter.ts`](src/llm/adapter.ts)** — Enhanced JSDoc on all four `LLMAdapter` methods:
- Documents which `debob` command calls each method, what context it expects, and where output is stored

**[`src/llm/providers/watsonx.ts`](src/llm/providers/watsonx.ts)** — New file: `WatsonxAdapter`:
- `summarizeModule` and `classifyLayer` — structured prompts built from `ModuleContext` fields (never raw source), call `POST /ml/v1/text/generation?version=2023-05-29` via `fetch`
- `classifyLayer` normalises output to lowercase bare string
- `explainDiff` / `answerQuestion` — stubs that throw `"not yet implemented"`
- Constructor validates `apiKey`, `projectId`, `endpoint`; strips trailing slash; defaults `modelId` to `ibm/granite-13b-instruct-v2`

**[`src/llm/index.ts`](src/llm/index.ts)** — Updated factory wires `"watsonx"` → `WatsonxAdapter`; exports `WatsonxAdapter` for re-use

### Verification
- `npm run typecheck` — ✅ zero errors
- 39/39 ad-hoc tests passed: graph traversal, context assembly, factory, constructor validation, mocked HTTP calls, prompt content correctness, normalisation, stubs, error handling

---

### 👤 User

Analyze @debob-plan.md  and begin implementing subtask 11 , adhere to all instructions present in @AGENTS.md and @.bob\ , once it is completed and verified update debob-plan.md and PROGRESS.md

---

### 🤖 Assistant

> 🔧 called: read_file, read_file

Let me read the Sub-Task 11 spec and all current source files to write accurate documentation:

> 🔧 **read_file** — debob-plan.md

> 🔧 **read_file** — README.md

### 🤖 Assistant

> 🔧 called: read_file, read_file, read_file, read_file, read_file, read_file, read_file

Now let me read all the key implementation files to get accurate details for the documentation:

> 🔧 **read_file** — src/persistence/schema.ts

> 🔧 **read_file** — src/persistence/interface.ts

> 🔧 **read_file** — src/analyzers/interface.ts

> 🔧 **read_file** — src/graph/builder.ts

> 🔧 **read_file** — src/scanner/index.ts

> 🔧 **read_file** — src/scanner/index.ts

> 🔧 **read_file** — src/persistence/sqlite.ts

### 🤖 Assistant

> 🔧 called: update_todo_list, write_file

Now I have all the factual details needed. Let me write the architecture doc and update README:

> 🔧 **update_todo_list** — 
[-] Write docs/architecture.md
[ ] Update README.md
[ ] npm run typecheck — confirm still passing
[ ] Update debob-plan.md and PROGRESS.md


> 🔧 **write_file** — docs/architecture.md

### 🤖 Assistant

> 🔧 called: update_todo_list, write_file

Now update the README:

> 🔧 **update_todo_list** — 
[x] Write docs/architecture.md
[-] Update README.md
[ ] npm run typecheck — confirm still passing
[ ] Update debob-plan.md and PROGRESS.md


> 🔧 **write_file** — # DeBob

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


### 🤖 Assistant

> 🔧 called: execute_command

Now run typecheck and then update the plan docs:

> 🔧 **execute_command** — & "C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" run typecheck 2>&1

### 🤖 Assistant

> 🔧 called: update_todo_list, apply_diff, apply_diff, update_todo_list

Zero errors. Now update both plan files:

> 🔧 **update_todo_list** — 
[x] Write docs/architecture.md
[x] Update README.md
[x] npm run typecheck — confirm still passing
[-] Update debob-plan.md and PROGRESS.md


> 🔧 **apply_diff** — <<<<<<< SEARCH
:start_line:610
-------
**Status:** `[ ] pending`
=======
**Status:** `[x] done`
>>>>>>> REPLACE


> 🔧 **apply_diff** — <<<<<<< SEARCH
:start_line:60
-------
| 11 | Architecture Documentation | ⬜ pending — **NEXT** |
=======
| 11 | Architecture Documentation | ✅ done |
>>>>>>> REPLACE

<<<<<<< SEARCH
:start_line:136
-------
docs/                               ← (empty — Sub-Task 11)
=======
docs/
  architecture.md                   ← Full architecture reference: system overview, pipeline,
                                       graph model, DB schema (all 6 tables), incremental update
                                       design, LLM architecture, extension guides (language + LLM
                                       provider), debob review foundation
>>>>>>> REPLACE

<<<<<<< SEARCH
:start_line:191
-------
## Sub-Task 11 Preview — Architecture Documentation (NEXT)

Files: `docs/architecture.md` (new), `README.md` (update)

Write the canonical reference document covering all components, the graph model, DB schema,
incremental update design, LLM architecture, and extension guides.

---
=======
## All Sub-Tasks Complete ✅

All 11 sub-tasks are implemented and verified. The full DeBob system is operational:

- `npx debob init` — scans any Git repo and builds `.debob/context.db`
- `npx debob init --semantic` — additionally runs LLM enrichment via `WATSONX_*` env vars
- `docs/architecture.md` — canonical reference for contributors and AI agents
- `README.md` — quick-start, commands, output summary, contributing guide

---
>>>>>>> REPLACE


> 🔧 **update_todo_list** — 
[x] Write docs/architecture.md
[x] Update README.md
[x] npm run typecheck — confirm still passing
[x] Update debob-plan.md and PROGRESS.md


### 🤖 Assistant

Sub-Task 11 is complete. All 11 sub-tasks are now done. Here's what was delivered:

---

## Sub-Task 11 — Architecture Documentation ✅

### Files created / modified

**[`docs/architecture.md`](docs/architecture.md)** — 430-line canonical reference document covering:

1. **System Overview** — three input sources (static AST, git, LLM), what `.debob/context.db` contains
2. **Core Principle** — full pipeline diagram from source → graph → LLM enrichment; explains why static facts and LLM facts are kept separate
3. **Component Responsibilities** — one section per module: `bin/debob.ts`, engine, scanner (4 exclusion guards), TypeScript analyzer (WASM pin warning), git extractor (email hashing), graph builder (7-step merge), persistence layer, query helpers, LLM layer
4. **Graph Model** — full `Node`/`Edge` interface definitions, `NodeType`, `EdgeType`, `ArchitecturalLayer`, ID convention table
5. **`.debob/` Schema** — all 6 `CREATE TABLE` statements verbatim, plus `manifest.json` shape
6. **Incremental Update Design** — `file_cache` role, 5-step `debob update` algorithm, schema/analyzer version change triggers (`[future]` labelled)
7. **LLM Architecture** — `ModuleContext` interface, `LLMAdapter` interface, `WatsonxAdapter` REST details, `semantic_enrichments` provenance model, env-only credentials rule
8. **How to Add a Language Analyzer** — concrete `PythonAnalyzer` example + 2-line engine registration
9. **How to Add an LLM Provider** — concrete `OpenAIAdapter` example + factory registration
10. **How `debob review` Will Be Built** — planned pipeline using existing `DiffContext`, `getNodeNeighbours`, and `explainDiff` stub

**[`README.md`](README.md)** — Finalized with:
- Quick-start with all three common invocations
- Full commands table including `--verbose`
- `WATSONX_*` env var section with graceful-degradation note
- `.debob/` contents with table of all 6 database tables
- Example terminal output summary block
- Architecture section linking to `docs/architecture.md` with topic list
- Contributing section with `npm run typecheck / build / dev`

**Verification**: `npm run typecheck` — ✅ zero errors