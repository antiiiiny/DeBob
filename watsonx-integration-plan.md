# DeBob — watsonx Integration Plan

> **Scope:** Replace the existing deprecated `text/generation` REST implementation in
> `src/llm/providers/watsonx.ts` with the official `@ibm-cloud/watsonx-ai` Node.js SDK
> using the chat API. Align all env var names to the four confirmed variables. Add a
> standalone connectivity test before touching the pipeline.
>
> `debob init` remains fully deterministic with zero LLM calls by default.
> `debob init --semantic` is the only entry point for LLM enrichment.

---

## Confirmed Environment Variables

| Variable | Purpose |
|---|---|
| `WATSONX_API_KEY` | IAM API key for authentication |
| `WATSONX_PROJECT_ID` | watsonx.ai project id |
| `WATSONX_URL` | Service instance URL (e.g. `https://us-south.ml.cloud.ibm.com`) |
| `WATSONX_MODEL_ID` | Model to use (e.g. `ibm/granite-3-8b-instruct`) |

---

## What Changes and Why

| File | Change | Reason |
|---|---|---|
| `package.json` | Add `@ibm-cloud/watsonx-ai` dependency | SDK replaces raw `fetch` REST |
| `src/llm/adapter.ts` | Rename `LLMConfig.endpoint` → `LLMConfig.url` | Align with `WATSONX_URL` env var name |
| `src/llm/providers/watsonx.ts` | Full rewrite — SDK + chat API | Deprecated endpoint removed |
| `bin/debob.ts` | Read `WATSONX_URL` + `WATSONX_MODEL_ID`; pass to factory | Env var alignment |
| `src/llm/index.ts` | Pass `modelId` from config into `WatsonxProvider` | `WATSONX_MODEL_ID` wired through |

**Files that do NOT change:** `src/llm/adapter.ts` interface methods, `src/llm/context.ts`, `src/llm/index.ts` factory shape, `src/query/index.ts`, `src/engine/index.ts`, all persistence/scanner/graph/analyzer code.

---

## Sub-Tasks

---

### Sub-Task 1 — Add SDK dependency

**Status:** `[ ] pending`

**Intent:**
Add `@ibm-cloud/watsonx-ai` to `package.json` dependencies so the SDK is available for import. No code uses it yet.

**Expected Outcomes:**
- `package.json` has `"@ibm-cloud/watsonx-ai": "^1.x"` (latest stable) in `dependencies`
- `npm install` resolves without conflict
- `npm run typecheck` still passes

**Todo List:**
1. Add `"@ibm-cloud/watsonx-ai": "^1.1.5"` to `dependencies` in `package.json` (check npm for latest 1.x)
2. Run `npm install`
3. Run `npm run typecheck` — must exit 0

**Relevant Context:**
- Package: `@ibm-cloud/watsonx-ai` on npm
- Must not change `web-tree-sitter` version (pinned to exact `"0.22.6"`)
- No native addons — the SDK is pure JS, this is safe

---

### Sub-Task 2 — Align `LLMConfig` and `bin/debob.ts` to new env vars

**Status:** `[ ] pending`

**Intent:**
Rename `LLMConfig.endpoint` to `LLMConfig.url` so the field name mirrors `WATSONX_URL`. Add `modelId` reading from `WATSONX_MODEL_ID` in the CLI. This is a pure type/naming alignment — no logic changes.

**Expected Outcomes:**
- `LLMConfig` has `url?: string` instead of `endpoint?: string`
- `bin/debob.ts` reads `WATSONX_URL` and `WATSONX_MODEL_ID` from env and passes them to `createLLMAdapter`
- Warning message in CLI updated to name all four required env vars
- `npm run typecheck` passes

**Todo List:**
1. In `src/llm/adapter.ts`: rename `endpoint?: string` → `url?: string` in `LLMConfig`, update JSDoc comment
2. In `bin/debob.ts`:
   - Change `process.env['WATSONX_ENDPOINT']` → `process.env['WATSONX_URL']`
   - Add `const modelId = process.env['WATSONX_MODEL_ID']`
   - Update the missing-vars guard to check all four: `apiKey`, `projectId`, `url`, `modelId`
   - Update the warning message to name all four vars
   - Pass `{ provider: 'watsonx', apiKey, projectId, url, modelId }` to `createLLMAdapter`
3. Run `npm run typecheck` — fix any cascade errors from the rename

**Relevant Context:**
- `src/llm/adapter.ts` lines 6–17 — `LLMConfig` interface
- `bin/debob.ts` lines 50–70 — `--semantic` env var block
- `src/llm/providers/watsonx.ts` will be rewritten in Sub-Task 3, so leave `endpoint` references there for now — they will be replaced wholesale

---

### Sub-Task 3 — Rewrite `WatsonxProvider` using the SDK chat API

**Status:** `[ ] pending`

**Intent:**
Replace the raw `fetch`-based `text/generation` implementation with the `@ibm-cloud/watsonx-ai` SDK's chat completion API. Rename the class from `WatsonxAdapter` to `WatsonxProvider` to match the user's naming (keep the `LLMAdapter` interface satisfied). The factory in `src/llm/index.ts` exports it under both names for backward compat, or just updates the reference.

**Expected Outcomes:**
- `src/llm/providers/watsonx.ts` uses `WatsonxAIParameters` / `WatsonxAIClient` (or equivalent SDK entry) from `@ibm-cloud/watsonx-ai`
- Authentication uses `IamAuthenticator` from `ibm-cloud-sdk-core` (bundled with the SDK)
- Chat API method used: `client.textChat(...)` (or `client.chat(...)` — check SDK docs for exact method name on the `WatsonxAI` service class)
- `summarizeModule` and `classifyLayer` send structured `ModuleContext` as a user chat message — never raw source
- `explainDiff` and `answerQuestion` remain stubs (`throw new Error('not yet implemented')`)
- Constructor validates `url`, `apiKey`, `projectId`, `modelId` — all four required; throws descriptive error if any missing
- `npm run typecheck` passes

**Todo List:**
1. Import `WatsonxAI` from `@ibm-cloud/watsonx-ai` and `IamAuthenticator` from `ibm-cloud-sdk-core`
2. Constructor:
   - Validate all four required fields (`apiKey`, `projectId`, `url`, `modelId`) — throw if any missing
   - Instantiate `WatsonxAI` client: `new WatsonxAI({ authenticator: new IamAuthenticator({ apikey }), serviceUrl: url })`
   - Store `projectId` and `modelId` as instance fields
3. Private `_chat(messages: Array<{role, content}>): Promise<string>` helper:
   - Call `this.client.textChat({ modelId, projectId, messages })`
   - Extract the assistant reply from the response: `response.result.choices[0].message.content`
   - Throw a descriptive error if the response shape is unexpected
4. `summarizeModule(context)`:
   - Build the system message: `"You are a software architecture assistant. Given module metadata (no source code), write one concise sentence describing the module's primary responsibility."`
   - Build the user message: the same structured text format from `buildModulePrompt` (file, imports, exports, declarations, git stats)
   - Call `_chat([system, user])`, return the result
5. `classifyLayer(context)`:
   - System message: instruct to classify into exactly one of `presentation | business | data | config | test | infra`, respond with only the label
   - User message: structured module context (same format)
   - Call `_chat([system, user])`, normalise response to lowercase, strip non-alpha, fallback to `'unclassified'`
6. Update `src/llm/index.ts` to import `WatsonxProvider` (or keep `WatsonxAdapter` as an alias — choose one name and be consistent)
7. Run `npm run typecheck` — must pass

**Relevant Context:**
- SDK package: `@ibm-cloud/watsonx-ai`
- SDK class: `WatsonxAI` — import from `@ibm-cloud/watsonx-ai`
- Auth class: `IamAuthenticator` — import from `ibm-cloud-sdk-core`
- Chat method on `WatsonxAI`: `textChat({ modelId, projectId, messages })` — verify exact method name against SDK types after install
- Response shape: `response.result.choices[0].message.content` (OpenAI-compatible chat schema)
- `LLMConfig` at this point has `url` (not `endpoint`) — from Sub-Task 2
- `buildModulePrompt` helper from existing code can be kept verbatim — it produces structured text from `ModuleContext`, no source code
- Do NOT read `process.env` inside this file — credentials are passed via `LLMConfig` from the CLI

---

### Sub-Task 4 — Standalone connectivity test

**Status:** `[ ] pending`

**Intent:**
Write a minimal `_test_watsonx.mjs` script that instantiates `WatsonxProvider` directly from env vars and sends a trivial prompt ("Say hello in one word.") through the chat API. This validates the SDK, auth, and network path before relying on the full pipeline. The script is deleted after passing.

**Expected Outcomes:**
- Script runs with `npx tsx _test_watsonx.mjs` and prints the model's reply
- If any env var is missing it prints a clear error and exits non-zero
- No graph, no engine, no persistence involved — pure LLM connectivity

**Todo List:**
1. Create `_test_watsonx.mjs`:
   ```
   - Read WATSONX_API_KEY, WATSONX_PROJECT_ID, WATSONX_URL, WATSONX_MODEL_ID from process.env
   - Throw/exit if any missing
   - Import WatsonxProvider from src/llm/providers/watsonx.ts (via tsx)
   - Instantiate with the four env vars
   - Call summarizeModule with a minimal fake ModuleContext:
       { filePath: 'test.ts', imports: [], exports: [], declarations: [] }
   - Print the result
   - console.log('✅ watsonx connectivity OK')
   ```
2. Run: `npx tsx _test_watsonx.mjs`
3. Confirm a string response is printed with exit code 0
4. Delete `_test_watsonx.mjs`

**Relevant Context:**
- `_test_*.mjs` files are gitignored (see `.gitignore`)
- Requires real credentials in `.env` — load with `dotenv` or set env vars manually before running
- The test intentionally uses `summarizeModule` not a raw SDK call, so it validates the full adapter path

---

### Sub-Task 5 — End-to-end pipeline smoke test with `--semantic`

**Status:** `[ ] pending`

**Intent:**
Run `debob init --semantic` on the DeBob repo itself to confirm the full pipeline works: scan → analyze → git → graph → LLM enrichment → persist → manifest. Verify that `semantic_enrichments` rows are written to `.debob/context.db`.

**Expected Outcomes:**
- `debob init --semantic` exits 0
- `.debob/context.db` contains rows in `semantic_enrichments` table
- `manifest.json` has `"semantic": true`
- `npm run typecheck` still passes (no regressions)

**Todo List:**
1. Ensure `.env` has all four `WATSONX_*` vars set
2. Run: `npx tsx bin/debob.ts init --semantic --verbose`
3. Write a quick `_test_semantic_verify.mjs` that opens `.debob/context.db` via `openDb`, queries `SELECT COUNT(*) FROM semantic_enrichments`, asserts count > 0, prints result
4. Run the verify script, confirm count > 0
5. Delete `_test_semantic_verify.mjs`
6. Run `npm run typecheck` — must pass

**Relevant Context:**
- `src/engine/index.ts` lines 191–216 — semantic enrichment loop (already correct; calls `buildModuleContext` → `llm.summarizeModule` / `llm.classifyLayer`)
- `src/persistence/sqlite.ts` — `openDb` + `SqlitePersistenceAdapter.readGraph()` for verification
- The engine skips enrichment silently on individual node failures — some nodes may not have enrichments if the model returns unexpected output

---

## Implementation Order

```
1 → 2 → 3 → typecheck → 4 (connectivity test) → 5 (pipeline smoke test)
```

Sub-tasks 1–3 must be done in order (each builds on the previous). Sub-task 4 requires real credentials. Sub-task 5 requires 4 to pass.

---

## What Must NOT Change

- `web-tree-sitter` version pin (`"0.22.6"` exact)
- `src/llm/adapter.ts` interface method signatures (`summarizeModule`, `classifyLayer`, `explainDiff`, `answerQuestion`)
- `src/llm/context.ts` — context builder is correct as-is
- `src/engine/index.ts` — engine pipeline is correct as-is
- All persistence, scanner, graph, analyzer code
- `debob init` (no `--semantic`) makes zero LLM calls — this invariant must hold
