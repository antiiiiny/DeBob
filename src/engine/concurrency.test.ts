import { describe, expect, it } from 'vitest'
import { mapWithConcurrency } from './concurrency.js'

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

describe('mapWithConcurrency', () => {
  it('returns results in input order, not completion order', async () => {
    // Descending delays: without ordering by index this comes back reversed.
    const items = [40, 30, 20, 10]
    const result = await mapWithConcurrency(items, 4, async (ms) => {
      await tick(ms)
      return ms
    })
    expect(result).toEqual([40, 30, 20, 10])
  })

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight -= 1
      return null
    })
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('actually overlaps work rather than running serially', async () => {
    const started = Date.now()
    await mapWithConcurrency(Array.from({ length: 8 }, (_, i) => i), 8, async () => {
      await tick(30)
      return null
    })
    // Serial would be ~240ms; overlapped should be far closer to one tick.
    expect(Date.now() - started).toBeLessThan(150)
  })

  it('visits every item exactly once', async () => {
    const seen: number[] = []
    await mapWithConcurrency(Array.from({ length: 50 }, (_, i) => i), 7, async (item) => {
      seen.push(item)
      return item
    })
    expect(seen).toHaveLength(50)
    expect(new Set(seen).size).toBe(50)
  })

  it('handles an empty list without spawning runners', async () => {
    expect(await mapWithConcurrency([], 5, async () => 'x')).toEqual([])
  })

  it('treats a nonsensical limit as at least one', async () => {
    expect(await mapWithConcurrency([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6])
  })

  it('does not spawn more runners than there are items', async () => {
    let peak = 0
    let inFlight = 0
    await mapWithConcurrency([1, 2], 16, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick(5)
      inFlight -= 1
      return null
    })
    expect(peak).toBeLessThanOrEqual(2)
  })
})
