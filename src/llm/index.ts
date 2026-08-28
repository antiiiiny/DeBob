import type { LLMAdapter } from './adapter.js'
import type { LLMConfig } from './adapter.js'
import { WatsonxProvider } from './providers/watsonx.js'

// ─── LLM Adapter Factory ──────────────────────────────────────────────────────

/**
 * Create an LLMAdapter for the given provider.
 *
 * V1 supported providers:
 *  - `"watsonx"` → `WatsonxProvider` (IBM watsonx.ai SDK, chat API)
 *
 * Future providers are added by importing their class and extending the switch.
 *
 * @throws If `provider` is not a recognised value.
 */
export function createLLMAdapter(provider: string, config: LLMConfig): LLMAdapter {
  switch (provider) {
    case 'watsonx':
      return new WatsonxProvider(config)
    default:
      throw new Error(
        `createLLMAdapter: unknown provider "${provider}". Supported: "watsonx"`,
      )
  }
}

export type { LLMAdapter, LLMConfig }
export { WatsonxProvider }
// Backward-compat alias
export { WatsonxProvider as WatsonxAdapter }
