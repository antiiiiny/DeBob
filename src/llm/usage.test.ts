import { describe, expect, it } from 'vitest'
import type { LLMAdapter, TokenUsage } from './adapter.js'

/**
 * `getUsage` is an optional interface member on purpose: a provider that cannot report
 * token counts should omit it rather than invent zeros. These lock down both the reporting
 * provider and — more importantly — the silent one, since "not measured" rendering as 0
 * would be a quietly wrong efficiency claim.
 */

/** Minimal stand-in for a provider that reports usage, accumulating like WatsonxProvider. */
class ReportingAdapter implements LLMAdapter {
  private usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, callCount: 0 }

  record(prompt: number, completion: number): void {
    this.usage.promptTokens += prompt
    this.usage.completionTokens += completion
    this.usage.totalTokens += prompt + completion
    this.usage.callCount += 1
  }

  async summarizeModule(): Promise<string> {
    this.record(100, 50)
    return 'summary'
  }
  async classifyLayer(): Promise<string> {
    this.record(80, 10)
    return 'business'
  }
  async explainDiff(): Promise<string> {
    return 'diff'
  }
  async answerQuestion(): Promise<string> {
    return 'answer'
  }
  getUsage(): TokenUsage | undefined {
    return this.usage.callCount === 0 ? undefined : { ...this.usage }
  }
}

/** A provider that simply does not implement the optional member. */
class SilentAdapter implements LLMAdapter {
  async summarizeModule(): Promise<string> {
    return 'summary'
  }
  async classifyLayer(): Promise<string> {
    return 'business'
  }
  async explainDiff(): Promise<string> {
    return 'diff'
  }
  async answerQuestion(): Promise<string> {
    return 'answer'
  }
}

describe('token usage reporting', () => {
  it('reports undefined before any call, not a zeroed object', async () => {
    // A zero here would render as "0 tokens used", which is a false claim rather than
    // an absent one.
    expect(new ReportingAdapter().getUsage()).toBeUndefined()
  })

  it('accumulates across calls', async () => {
    const adapter = new ReportingAdapter()
    await adapter.summarizeModule()
    await adapter.classifyLayer()

    const usage = adapter.getUsage()
    expect(usage).toEqual({
      promptTokens: 180,
      completionTokens: 60,
      totalTokens: 240,
      callCount: 2,
    })
  })

  it('accumulates per enriched module, two calls each', async () => {
    const adapter = new ReportingAdapter()
    for (let i = 0; i < 44; i += 1) {
      await Promise.all([adapter.summarizeModule(), adapter.classifyLayer()])
    }
    // Mirrors a real run: 44 file nodes => 88 calls.
    expect(adapter.getUsage()?.callCount).toBe(88)
  })

  it('hands back a copy, so callers cannot mutate the running total', async () => {
    const adapter = new ReportingAdapter()
    await adapter.summarizeModule()
    const snapshot = adapter.getUsage()!
    snapshot.promptTokens = 999_999
    expect(adapter.getUsage()?.promptTokens).toBe(100)
  })

  it('is safe to call optionally on a provider that omits it', () => {
    const adapter: LLMAdapter = new SilentAdapter()
    expect(adapter.getUsage?.()).toBeUndefined()
  })
})
