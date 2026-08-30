/**
 * Run an async worker over a list with a bounded number of calls in flight.
 *
 * Semantic enrichment was strictly sequential: one file, await, next file. With a
 * reasoning model taking several seconds per call that made enrichment the slowest part
 * of DeBob by a wide margin, and the wait was almost entirely network idle rather than
 * work. The provider is the same either way — the round-trips just overlap now.
 *
 * Results are returned in input order regardless of completion order. The worker is
 * expected to handle its own failures (enrichment skips nodes that fail rather than
 * aborting the run); anything it throws will reject the whole batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.floor(limit))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function runner(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index]!, index)
    }
  }

  const runners = Array.from(
    { length: Math.min(effectiveLimit, items.length) },
    () => runner(),
  )
  await Promise.all(runners)
  return results
}

/** Default number of enrichment calls in flight. */
export const DEFAULT_ENRICH_CONCURRENCY = 6
