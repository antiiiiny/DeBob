import type { Graph, Node } from '../graph/types.js'
import type { GitFileStats } from '../persistence/interface.js'

// ─── LLM Configuration ───────────────────────────────────────────────────────

export interface LLMConfig {
  /** Provider identifier (e.g. "watsonx"). */
  provider: string
  /** API key — read from environment, never stored. */
  apiKey?: string
  /** Provider-specific model id (e.g. "ibm/granite-13b-instruct-v2"). */
  modelId?: string
  /** Service URL (e.g. "https://us-south.ml.cloud.ibm.com"). Maps to WATSONX_URL env var. */
  url?: string
  /** Provider-specific project or workspace id. */
  projectId?: string
}

// ─── Context Types ────────────────────────────────────────────────────────────

/**
 * Structured context assembled by the context builder for a single module.
 * This — not raw source code — is what the LLM receives.
 */
export interface ModuleContext {
  /** Relative file path. */
  filePath: string
  /** List of module specifiers this file imports (resolved or raw). */
  imports: string[]
  /**
   * Module paths this file *re-exports* from (`export { x } from './y.js'`).
   *
   * Named `reExports`, not `exports`, because that is genuinely all it holds: it is derived
   * from `exports` edges, which the analyzers only emit for re-export statements. It was
   * previously called `exports` and documented as "exported symbol names", so a file doing
   * `export function foo()` was described to the model as having zero exports. Declared
   * symbols are in `declarations`.
   */
  reExports: string[]
  /** Declarations found in this file (functions, classes, interfaces). */
  declarations: Array<{
    name: string
    type: 'function' | 'class' | 'interface' | 'variable'
    startLine?: number
    /** Author-written doc comment for this symbol, when it has one. */
    doc?: string
  }>
  /** Architectural layer, if one has been inferred or assigned. */
  layer?: string
  /** Symbols elsewhere in the repo that this module's code calls. */
  calls?: string[]
  /** Symbols elsewhere in the repo that call into this module. */
  calledBy?: string[]
  /** The module's own leading doc comment, when it has one. */
  doc?: string
  /** Optional git stats for context (churn, authors). */
  gitStats?: Pick<GitFileStats, 'churnScore' | 'authorCount' | 'lastModifiedAt'>
}

/**
 * Context for explaining a diff.
 * Used by `debob review` (future command).
 */
export interface DiffContext {
  /** The raw unified diff string. */
  diff: string
  /** Nodes directly involved in the diff. */
  affectedNodes: Node[]
  /** Graph neighbourhood of affected nodes (imports, dependents). */
  neighbourhood: Graph
  /** Summary of architectural layers involved. */
  layersSummary: string[]
}

/**
 * Context for answering a free-form question.
 * Used by `debob explain` (future command).
 */
export interface QueryContext {
  /** The user's question. */
  question: string
  /** Relevant nodes identified by the query engine. */
  relevantNodes: Node[]
  /** Relevant edges between those nodes. */
  relevantEdges: Graph['edges']
}

/** Both semantic fields for one module, produced by a single `describeModule` call. */
export interface ModuleDescription {
  /** One to three sentences on what the module is for. */
  responsibility: string
  /** An ArchitecturalLayer name, or 'unclassified' when the model gave nothing usable. */
  layer: string
}

// ─── Token Usage ──────────────────────────────────────────────────────────────

/**
 * Cumulative token spend for one adapter instance.
 *
 * These are counts reported by the provider, not local estimates — they are the evidence
 * for DeBob's central claim that the LLM receives targeted graph slices rather than the
 * repository. Compare `promptTokens` against the byte size of the source that was *not*
 * sent (see `InitResult.sourceBytes`).
 */
export interface TokenUsage {
  /** Tokens in the prompts DeBob sent — i.e. the size of the context slices. */
  promptTokens: number
  /**
   * Tokens the model generated. For reasoning-capable models (e.g. `openai/gpt-oss-120b`)
   * this is dominated by hidden `reasoning_content` and is NOT a measure of answer length:
   * a two-character reply was measured at 51 completion tokens.
   */
  completionTokens: number
  /** Provider-reported total. Not assumed to equal prompt + completion. */
  totalTokens: number
  /** Number of provider calls that reported usage. */
  callCount: number
}

// ─── LLM Adapter Interface ────────────────────────────────────────────────────

/**
 * Provider-agnostic LLM adapter interface.
 *
 * The LLM is NEVER given the full repository. The context builder (buildModuleContext in src/query/index.ts)
 * assembles targeted slices from graph queries, and only those slices are passed here.
 *
 * V1 provider: IBM watsonx (src/llm/providers/watsonx.ts)
 * Future providers: OpenAI, Anthropic, local Ollama, etc.
 */
export interface LLMAdapter {
  /**
   * Summarize a module's responsibility from its graph context slice.
   *
   * Called by: `debob init --semantic` — once per file node in the graph.
   * Context: a `ModuleContext` assembled from graph edges (imports, exports, declarations).
   *          The adapter MUST NOT receive or request raw source code.
   * Output stored in: `semantic_enrichments` table, `field = "responsibility"`.
   *
   * @param context Structured module slice assembled by `buildModuleContext`.
   * @returns A short human-readable description of the module's responsibility.
   */
  summarizeModule(context: ModuleContext): Promise<string>

  /**
   * Infer the architectural layer of a file from its imports/exports/declarations.
   *
   * Called by: `debob init --semantic` — once per file node in the graph.
   * Context: same `ModuleContext` shape used by `summarizeModule`.
   *          Prompt should emphasise import patterns, not source content.
   * Output stored in: `semantic_enrichments` table, `field = "layer"`.
   * Expected return values: one of "presentation" | "business" | "data" | "config" | "test" | "infra".
   *
   * @param context Structured module slice assembled by `buildModuleContext`.
   * @returns An architectural layer label string.
   */
  classifyLayer(context: ModuleContext): Promise<string>

  /**
   * Explain a diff in the context of the repository graph.
   *
   * Called by: `debob review`.
   * Context: `DiffContext` including the unified diff, affected nodes, and graph neighbourhood.
   * Output: human-readable explanation of risks and affected workflows.
   *
   * Note: `DiffContext.diff` is a raw unified diff — the one deliberate exception to the
   * "never send raw source" rule elsewhere in this interface. It's unavoidable for explaining
   * *what changed*, but keep it truncated (see `review.ts`'s `truncateDiff`) rather than sending
   * whole files.
   *
   * @param context Diff context including affected graph nodes and neighbourhood.
   * @returns Human-readable explanation of the diff's impact.
   */
  explainDiff(context: DiffContext): Promise<string>

  /**
   * Answer a free-form question using targeted graph context.
   *
   * Called by: `debob explain`.
   * Context: `QueryContext` with the question and relevant nodes/edges from the graph, selected
   *          by `findRelevantNodes` (src/query/index.ts) via keyword overlap against node
   *          id/name/type/layer and cached `responsibility` enrichments.
   * Output: human-readable answer grounded in graph evidence, not raw source.
   *
   * @param context Query context including the question and relevant graph nodes.
   * @returns Human-readable answer grounded in graph data.
   */
  answerQuestion(context: QueryContext): Promise<string>

  /**
   * Responsibility and layer for one module in a single call.
   *
   * `summarizeModule` and `classifyLayer` send byte-identical context, so asking them
   * separately transmitted every module's slice twice — about half of all prompt tokens
   * were a duplicate. Providers that implement this halve both call count and prompt spend;
   * callers fall back to the two separate methods when it is absent or its response can't
   * be parsed.
   */
  describeModule?(context: ModuleContext, preamble?: string): Promise<ModuleDescription>

  /**
   * Cumulative token usage across every call this adapter instance has made.
   *
   * Optional by design: a provider that cannot report usage should omit this rather than
   * fabricate numbers. Callers must treat `undefined` as "not measurable" and report
   * nothing, never zero.
   */
  getUsage?(): TokenUsage | undefined
}
