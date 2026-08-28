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
  /** API endpoint URL (e.g. "https://us-south.ml.cloud.ibm.com"). */
  endpoint?: string
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
  /** List of exported symbol names. */
  exports: string[]
  /** Declarations found in this file (functions, classes, interfaces). */
  declarations: Array<{
    name: string
    type: 'function' | 'class' | 'interface' | 'variable'
    startLine?: number
  }>
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

// ─── LLM Adapter Interface ────────────────────────────────────────────────────

/**
 * Provider-agnostic LLM adapter interface.
 *
 * The LLM is NEVER given the full repository. The context builder (src/llm/context.ts)
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
   * Called by: `debob review` (future command — not yet implemented).
   * Context: `DiffContext` including the unified diff, affected nodes, and graph neighbourhood.
   * Output: human-readable explanation of risks and affected workflows.
   *
   * @param context Diff context including affected graph nodes and neighbourhood.
   * @returns Human-readable explanation of the diff's impact.
   */
  explainDiff(context: DiffContext): Promise<string>

  /**
   * Answer a free-form question using targeted graph context.
   *
   * Called by: `debob explain` (future command — not yet implemented).
   * Context: `QueryContext` with the question and relevant nodes/edges from the graph.
   * Output: human-readable answer grounded in graph evidence, not raw source.
   *
   * @param context Query context including the question and relevant graph nodes.
   * @returns Human-readable answer grounded in graph data.
   */
  answerQuestion(context: QueryContext): Promise<string>
}
