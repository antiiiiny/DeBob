import { WatsonXAI } from '@ibm-cloud/watsonx-ai'
import { IamAuthenticator } from '@ibm-cloud/watsonx-ai/authentication'
import type { LLMAdapter, LLMConfig, ModuleContext, DiffContext, QueryContext, TokenUsage } from '../adapter.js'

/**
 * Max time to wait for a single watsonx chat call before failing with a clear error.
 * Reasoning-capable models (e.g. gpt-oss) can take well over 25s to finish their hidden
 * reasoning pass before emitting a visible answer — calibrated against real runs during
 * `debob review` rehearsal, not a guess.
 */
const CHAT_TIMEOUT_MS = 60_000

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

  /** Cumulative token spend, accumulated per call in `_chat`. See `getUsage`. */
  private usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0,
  }

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

  // ─── explainDiff ─────────────────────────────────────────────────────────────

  /**
   * Explain the impact of a git diff using architectural graph context.
   *
   * The LLM receives:
   *  - A system message establishing the architecture-assistant role
   *  - A user message with: layers affected, per-node responsibility summaries,
   *    and the truncated raw diff (first 200 lines)
   *
   * Raw source code is NEVER included — only graph-derived metadata.
   */
  async explainDiff(context: DiffContext): Promise<string> {
    const { diff, affectedNodes, neighbourhood, layersSummary } = context

    // Build per-node responsibility lines from neighbourhood enrichments.
    // We don't have direct access to enrichments here, so we use what the
    // engine already embedded: the affectedNodes list + the neighbourhood graph.
    const nodeLines: string[] = []
    const allNodes = [
      ...affectedNodes,
      ...neighbourhood.nodes.values(),
    ]
    for (const n of allNodes) {
      const layer = n.layer ? ` [${n.layer}]` : ''
      nodeLines.push(`  - ${n.id}${layer} (type: ${n.type})`)
    }

    const layerLine =
      layersSummary.length > 0
        ? `Layers affected: ${layersSummary.join(', ')}`
        : 'Layers affected: unknown'

    const userContent = [
      layerLine,
      '',
      `Directly changed files (${affectedNodes.length}):`,
      ...affectedNodes.map(n => `  - ${n.id}${n.layer ? ` [${n.layer}]` : ''}`),
      '',
      `Neighbourhood (2-hop, ${neighbourhood.nodes.size} nodes):`,
      ...[...neighbourhood.nodes.values()].map(n => `  - ${n.id}${n.layer ? ` [${n.layer}]` : ''}`),
      '',
      '--- diff (truncated to 200 lines) ---',
      diff,
    ].join('\n')

    return this._chat([
      {
        role: 'system',
        content:
          'You are a software architecture assistant. ' +
          'Given a git diff and the architectural context of affected modules (no raw source), ' +
          'describe in plain language: which parts of the system are affected, what risks the change ' +
          'introduces, and which neighbouring modules may need review.',
      },
      {
        role: 'user',
        content: userContent,
      },
    ])
  }

  // ─── answerQuestion ─────────────────────────────────────────────────────────

  /**
   * Answer a free-form question about the repository using targeted graph context.
   *
   * The LLM receives only the question plus a list of relevant nodes (id, type, layer,
   * cached responsibility if available) and the edges between them — never raw source.
   */
  async answerQuestion(context: QueryContext): Promise<string> {
    const { question, relevantNodes, relevantEdges } = context

    if (relevantNodes.length === 0) {
      return "I couldn't find anything in the repository graph relevant to that question."
    }

    const nodeLines = relevantNodes.map(n => {
      const layer = n.layer ? ` [${n.layer}]` : ''
      const resp = n.responsibility ? ` — ${n.responsibility}` : ''
      return `  - ${n.id} (type: ${n.type})${layer}${resp}`
    })

    const edgeLines = relevantEdges.map(e => `  - ${e.source} --${e.type}--> ${e.target}`)

    const userContent = [
      `Question: ${question}`,
      '',
      `Relevant nodes (${relevantNodes.length}):`,
      ...nodeLines,
      '',
      `Relevant edges (${edgeLines.length}):`,
      ...(edgeLines.length > 0 ? edgeLines : ['  (none)']),
    ].join('\n')

    return this._chat([
      {
        role: 'system',
        content:
          'You are a software architecture assistant answering questions about a codebase. ' +
          'You are given structured graph metadata (file paths, symbol names, types, layers, ' +
          'cached responsibility summaries, import/export relationships) — never raw source code. ' +
          'Answer the question grounded only in this data. If the data is insufficient to answer ' +
          'confidently, say so plainly rather than guessing.',
      },
      {
        role: 'user',
        content: userContent,
      },
    ])
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
  /**
   * Cumulative token usage across every call made by this instance.
   * Returns undefined when no call has reported usage, so callers can distinguish
   * "nothing measured" from a genuine zero.
   */
  getUsage(): TokenUsage | undefined {
    return this.usage.callCount === 0 ? undefined : { ...this.usage }
  }

  private async _chat(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
  ): Promise<string> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`WatsonxProvider: request timed out after ${CHAT_TIMEOUT_MS / 1000}s`)), CHAT_TIMEOUT_MS)
    })

    const response = await Promise.race([
      this.client.textChat({
        modelId: this.modelId,
        projectId: this.projectId,
        messages,
        // Reasoning-capable models (e.g. gpt-oss) spend tokens on hidden reasoning before the
        // final answer; watsonx's own default (1024) is too low and truncates before any
        // visible content is produced. Give enough headroom for reasoning + a full answer.
        maxTokens: 4096,
      }),
      timeout,
    ])

    // Record usage BEFORE the checks below: a call that burned tokens and then came back
    // truncated or malformed still cost money, and skipping it would understate the total.
    const usage = response.result?.usage
    if (usage) {
      this.usage.promptTokens += usage.prompt_tokens ?? 0
      this.usage.completionTokens += usage.completion_tokens ?? 0
      this.usage.totalTokens += usage.total_tokens ?? 0
      this.usage.callCount += 1
    }

    const content = response.result?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.length === 0) {
      const finishReason = response.result?.choices?.[0]?.finish_reason
      if (finishReason === 'length') {
        throw new Error(
          'WatsonxProvider: response was truncated before producing an answer (finish_reason: length). ' +
            'Try a shorter question/diff, or a non-reasoning model.',
        )
      }
      throw new Error(
        `WatsonxProvider: unexpected response shape — ${JSON.stringify(response.result)}`,
      )
    }

    return content.trim()
  }
}
