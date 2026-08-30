import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** Hard cap on the preamble, before the per-repo scaling below. */
const PREAMBLE_CAP = 600

/**
 * Above this many modules, the preamble is dropped entirely.
 *
 * The preamble is paid on *every* enrichment call, so its cost scales with module count
 * while its benefit does not. Measured: DeBob has 26 source files, but a Next.js monorepo
 * of comparable total size has 243 — a 100-token preamble there costs ~24,000 tokens
 * against a repo whose entire source is ~65,000. Past this threshold the framing is not
 * worth what it displaces.
 */
const PREAMBLE_MODULE_LIMIT = 100

/**
 * A short description of the project, for framing per-module summaries.
 *
 * Without it the model describes each module in isolation and reaches for generic phrasing;
 * with it, summaries are written relative to what the project actually is. Sourced from the
 * repository's own README so there is no second document to maintain and drift.
 *
 * Returns undefined when there is no README, when it yields nothing usable, or when the
 * repository has too many modules for the per-call cost to be worth paying.
 */
export function buildProjectPreamble(repoRoot: string, moduleCount: number): string | undefined {
  if (moduleCount > PREAMBLE_MODULE_LIMIT) return undefined

  const readmePath = join(repoRoot, 'README.md')
  if (!existsSync(readmePath)) return undefined

  let raw: string
  try {
    raw = readFileSync(readmePath, 'utf8')
  } catch {
    // An unreadable README is not worth failing an entire enrichment run over.
    return undefined
  }

  // Everything before the first section heading: conventionally the elevator pitch.
  const intro = raw.split(/^##\s/m)[0] ?? ''

  const text = intro
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    // Drop the H1, badge images, and block-quote taglines — chrome, not description.
    .filter(line => !line.startsWith('#'))
    .filter(line => !/^[[!]/.test(line))
    .map(line => line.replace(/^>\s*/, ''))
    .join(' ')
    // Strip the markdown that survives: links keep their text, emphasis is dropped.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length < 40) return undefined
  return text.length > PREAMBLE_CAP ? text.slice(0, PREAMBLE_CAP).trimEnd() + '…' : text
}
