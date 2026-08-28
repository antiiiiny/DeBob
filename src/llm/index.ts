import type { LLMAdapter } from './adapter.js'
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
