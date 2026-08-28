import { WatsonXAI } from '@ibm-cloud/watsonx-ai'
import { IamAuthenticator } from '@ibm-cloud/watsonx-ai/authentication'
import type { LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext } from '../adapter.js'

// ─── Prompt builders ──────────────────────────────────────────────────────────

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

// ─── WatsonxProvider ──────────────────────────────────────────────────────────

/**
 * IBM watsonx.ai LLM provider using the official @ibm-cloud/watsonx-ai SDK.
 *
 * Uses the textChat API (chat completions — not the deprecated text/generation endpoint).
 * Credentials are passed via LLMConfig; this class never reads process.env directly.
 *
 * The adapter NEVER receives or sends raw source code.
 * All input is structured ModuleContext slices assembled by the context builder.
 */
export class WatsonxProvider implements LLMAdapter {
  /** Identifies this provider for storage in `semantic_enrichments.llmProvider`. */
  readonly provider = 'watsonx'

  private readonly client: WatsonXAI
  private readonly projectId: string
  readonly modelId: string

  constructor(config: LLMConfig) {
    if (!config.apiKey) throw new Error('WatsonxProvider: apiKey is required (WATSONX_API_KEY)')
    if (!config.projectId) throw new Error('WatsonxProvider: projectId is required (WATSONX_PROJECT_ID)')
    if (!config.url) throw new Error('WatsonxProvider: url is required (WATSONX_URL)')
    if (!config.modelId) throw new Error('WatsonxProvider: modelId is required (WATSONX_MODEL_ID)')

    this.projectId = config.projectId
    this.modelId = config.modelId

    this.client = new WatsonXAI({
      authenticator: new IamAuthenticator({ apikey: config.apiKey }),
      serviceUrl: config.url,
    })
  }

  // ─── summarizeModule ────────────────────────────────────────────────────────

  /**
   * Ask the LLM to summarize a module's responsibility from its graph slice.
   * Called by `debob init --semantic` for each file node.
   */
  async summarizeModule(context: ModuleContext): Promise<string> {
    const moduleText = buildModulePrompt(context)
    return this._chat([
      {
        role: 'system',
        content:
          'You are a software architecture assistant. ' +
          'Given module metadata (no source code), write one concise sentence ' +
          "describing the module's primary responsibility.",
      },
      {
        role: 'user',
        content: moduleText + '\n\nResponsibility:',
      },
    ])
  }

  // ─── classifyLayer ──────────────────────────────────────────────────────────

  /**
   * Ask the LLM to infer the architectural layer from a module's graph slice.
   * Called by `debob init --semantic` for each file node.
   * Returns one of: presentation | business | data | config | test | infra
   */
  async classifyLayer(context: ModuleContext): Promise<string> {
    const moduleText = buildModulePrompt(context)
    const raw = await this._chat([
      {
        role: 'system',
        content:
          'You are a software architecture assistant. ' +
          'Given module metadata (no source code), classify the module into exactly one of these ' +
          'architectural layers: presentation, business, data, config, test, infra. ' +
          'Respond with only the single layer name — no explanation, no punctuation.',
      },
      {
        role: 'user',
        content: moduleText + '\n\nLayer:',
      },
    ])
    // Normalise: lowercase, strip non-alpha, fallback to 'unclassified'
    return raw.trim().toLowerCase().replace(/[^a-z]/g, '') || 'unclassified'
  }

  // ─── explainDiff (stub) ─────────────────────────────────────────────────────

  /** @throws Always — implemented in `debob review` (future sub-task). */
  async explainDiff(_context: DiffContext): Promise<string> {
    throw new Error('WatsonxProvider.explainDiff: not yet implemented (debob review)')
  }

  // ─── answerQuestion (stub) ──────────────────────────────────────────────────

  /** @throws Always — implemented in `debob explain` (future sub-task). */
  async answerQuestion(_context: QueryContext): Promise<string> {
    throw new Error('WatsonxProvider.answerQuestion: not yet implemented (debob explain)')
  }

  // ─── Internal chat helper ────────────────────────────────────────────────────

  /**
   * Send a list of chat messages to the watsonx.ai textChat API and return the
   * assistant's reply text.
   *
   * Uses WatsonXAI.textChat() from the official @ibm-cloud/watsonx-ai SDK.
   * Response shape follows the OpenAI-compatible chat schema:
   *   response.result.choices[0].message.content
   */
  private async _chat(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
  ): Promise<string> {
    const response = await this.client.textChat({
      modelId: this.modelId,
      projectId: this.projectId,
      messages,
    })

    const content = response.result?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error(
        `WatsonxProvider: unexpected response shape — ${JSON.stringify(response.result)}`,
      )
    }

    return content.trim()
  }
}
