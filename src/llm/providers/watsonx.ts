import type { LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext } from '../adapter.js'

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
