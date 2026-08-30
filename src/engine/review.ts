import { existsSync } from 'fs'
import { join } from 'path'
import simpleGit from 'simple-git'
import { openDb, SqlitePersistenceAdapter } from '../persistence/sqlite.js'
import { getNodeNeighbours } from '../query/index.js'
import type { Graph, Node } from '../graph/types.js'
import type { LLMAdapter, DiffContext, TokenUsage } from '../llm/adapter.js'

// ─── Public Types ─────────────────────────────────────────────────────────────

/** Options accepted by runReview. */
export interface ReviewOptions {
  /**
   * Git ref to diff against. When undefined, diffs the working tree vs HEAD
   * (staged + unstaged changes).
   */
  base?: string
  /** Log extra detail to stdout. */
  verbose?: boolean
  /** LLM adapter — required; runReview always calls explainDiff. */
  llm: LLMAdapter
}

/** Structured result returned by runReview. */
export interface ReviewResult {
  /** Repo-relative paths of files directly touched in the diff. */
  affectedFiles: string[]
  /** Unique architectural layers touched by affected + neighbourhood nodes. */
  affectedLayers: string[]
  /** Total number of neighbourhood nodes (2-hop from each affected file). */
  neighbourhoodSize: number
  /** LLM explanation of the diff's architectural impact. */
  explanation: string
  /** Non-fatal notes about the review (e.g. changed files not yet in the graph). */
  notes: string[]
  /** Provider-reported token spend for this run. Undefined = provider reports no usage. */
  tokenUsage?: TokenUsage
}

// ─── Diff helpers ─────────────────────────────────────────────────────────────

/**
 * Extract repo-relative file paths from a unified diff string.
 *
 * Captures both the `a/` (old) and `b/` (new) path from each `diff --git` header so that
 * renamed files have the best chance of resolving against whatever the graph currently has —
 * the graph may still hold the old path (not yet `debob update`d) or the new one.
 */
function extractChangedPaths(rawDiff: string): string[] {
  const paths = new Set<string>()
  for (const line of rawDiff.split('\n')) {
    // Match: diff --git a/<path> b/<path>
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (m) {
      paths.add(m[1])
      paths.add(m[2])
    }
  }
  return [...paths]
}

/** Truncate a diff string to at most `maxLines` lines. */
function truncateDiff(rawDiff: string, maxLines = 200): string {
  const lines = rawDiff.split('\n')
  if (lines.length <= maxLines) return rawDiff
  return lines.slice(0, maxLines).join('\n') + '\n... (truncated)'
}

// ─── runReview ────────────────────────────────────────────────────────────────

/**
 * Diff impact analysis.
 *
 * 1. Reads the git diff (uncommitted or between two refs)
 * 2. Finds each changed file's node in the persisted graph
 * 3. Collects a 2-hop neighbourhood from each affected node
 * 4. Reads cached semantic enrichments for context (no extra LLM calls)
 * 5. Calls llm.explainDiff() with a DiffContext assembled from the above
 */
export async function runReview(repoRoot: string, options: ReviewOptions): Promise<ReviewResult> {
  const { base, verbose, llm } = options

  // ─── Step 1: get the raw diff ───────────────────────────────────────────────

  let rawDiff: string
  try {
    const git = simpleGit(repoRoot)
    // Three-dot diff: compares HEAD against the merge-base of `base` and HEAD, so a diverged
    // base branch doesn't pull in unrelated changes — matches typical "review my branch" intent.
    rawDiff = base
      ? await git.diff([`${base}...HEAD`])
      : await git.diff(['HEAD'])
  } catch {
    throw new Error('Not a Git repository or git is not available.')
  }

  const changedPaths = extractChangedPaths(rawDiff)

  if (changedPaths.length === 0) {
    throw new Error('No diff found. Nothing to review.')
  }

  if (verbose) {
    console.log(`[debob review] ${changedPaths.length} changed file(s) detected.`)
  }

  // ─── Step 2: open graph ─────────────────────────────────────────────────────

  const dbPath = join(repoRoot, '.debob', 'context.db')
  if (!existsSync(dbPath)) {
    throw new Error("No graph found. Run 'debob init' first.")
  }

  const { db } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)

  try {
    const graph = adapter.readGraph()

    // ─── Step 3: find affected nodes ─────────────────────────────────────────

    const affectedNodes: Node[] = []
    for (const p of changedPaths) {
      const node = graph.nodes.get(p)
      if (node) affectedNodes.push(node)
    }

    const notes: string[] = []
    if (affectedNodes.length < changedPaths.length) {
      notes.push(
        `${changedPaths.length - affectedNodes.length} of ${changedPaths.length} changed path(s) ` +
          `were not found in the graph — run 'debob update' to pick up new/renamed files before reviewing.`,
      )
    }

    // ─── Step 4: collect 2-hop neighbourhood ─────────────────────────────────

    const neighbourMap = new Map<string, Node>()
    for (const node of affectedNodes) {
      const neighbours = getNodeNeighbours(graph, node.id, 2)
      for (const n of neighbours) {
        if (!affectedNodes.some(a => a.id === n.id)) {
          neighbourMap.set(n.id, n)
        }
      }
    }
    const neighbourNodes = [...neighbourMap.values()]

    if (verbose) {
      console.log(`[debob review] ${affectedNodes.length} affected node(s), ${neighbourNodes.length} neighbour(s).`)
    }

    // ─── Step 5: read cached semantic enrichments ────────────────────────────

    const allNodeIds = [
      ...affectedNodes.map(n => n.id),
      ...neighbourNodes.map(n => n.id),
    ]
    const enrichments = adapter.readSemanticEnrichments(allNodeIds.length > 0 ? allNodeIds : undefined)

    // Build layer summary from layer-type enrichments
    const layerSet = new Set<string>()
    for (const e of enrichments) {
      if (e.field === 'layer') layerSet.add(e.value)
    }
    // Also include any layer already on the node itself
    for (const n of affectedNodes) {
      if (n.layer) layerSet.add(n.layer)
    }
    const layersSummary = [...layerSet].sort()

    // ─── Step 6: build neighbourhood sub-graph ───────────────────────────────

    const allIds = new Set(allNodeIds)
    const neighbourEdges = graph.edges.filter(
      e => allIds.has(e.source) && allIds.has(e.target),
    )
    const neighbourGraph: Graph = {
      nodes: new Map(neighbourNodes.map(n => [n.id, n])),
      edges: neighbourEdges,
    }

    // ─── Step 7: assemble DiffContext and call LLM ───────────────────────────

    const diffContext: DiffContext = {
      diff: truncateDiff(rawDiff),
      affectedNodes,
      neighbourhood: neighbourGraph,
      layersSummary,
    }

    const explanation = await llm.explainDiff(diffContext)

    return {
      affectedFiles: changedPaths,
      affectedLayers: layersSummary,
      neighbourhoodSize: neighbourNodes.length,
      explanation,
      notes,
      tokenUsage: llm.getUsage?.(),
    }
  } finally {
    adapter.close()
  }
}
