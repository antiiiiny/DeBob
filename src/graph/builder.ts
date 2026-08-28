import type { Node, Edge, Graph } from './types.js'
import type { AnalysisResult } from '../analyzers/interface.js'
import type { ScannedFile } from '../scanner/types.js'
import type { GitMetadata } from '../persistence/interface.js'

// ─── Symbol Node Types ────────────────────────────────────────────────────────

/** Node types that represent named symbols — win over bare file nodes on id collision. */
const SYMBOL_NODE_TYPES = new Set(['function', 'class', 'interface', 'variable', 'route'])

// ─── Churn Percentile Helper ──────────────────────────────────────────────────

/**
 * Given an array of non-negative numbers, return the value at the given percentile.
 * Uses nearest-rank method. Returns 0 for empty arrays.
 */
function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.ceil((pct / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)] ?? 0
}

// ─── Stub Node Factory ────────────────────────────────────────────────────────

function makeStubNode(id: string): Node {
  const isPackage = id.startsWith('pkg::')
  return {
    id,
    type: isPackage ? 'package' : 'file',
    name: isPackage ? id.replace('pkg::', '') : (id.split('/').pop() ?? id),
    filePath: id,
    confidence: 1.0,
    dataSource: 'static',
    metadata: { stub: true },
  }
}

// ─── Graph Builder ────────────────────────────────────────────────────────────

/**
 * Combine scanner output, all analyzer results, and Git metadata into a single
 * deduplicated, consistent Graph.
 *
 * Steps:
 *  1. Seed file nodes from ScannedFile list.
 *  2. Merge AnalysisResult nodes — symbol nodes win over bare file nodes on id collision.
 *  3. Merge AnalysisResult edges — deduped by edge id.
 *  4. Attach git metadata (churnScore, lastModifiedAt, authorCount) + contentHash to each file node.
 *  5. Mark top-10% churn file nodes as hot.
 *  6. Stub out any edge source/target that has no corresponding node.
 *  7. Return { nodes, edges }.
 *
 * Pure function — no I/O.
 */
export function buildGraph(
  files: ScannedFile[],
  analysisResults: AnalysisResult[],
  gitMetadata: GitMetadata,
): Graph {
  const nodes = new Map<string, Node>()
  const edgeMap = new Map<string, Edge>()

  // ─── Step 1: Seed file nodes from scanner ────────────────────────────────────

  for (const file of files) {
    nodes.set(file.relativePath, {
      id: file.relativePath,
      type: 'file',
      name: file.relativePath.split('/').pop() ?? file.relativePath,
      filePath: file.relativePath,
      confidence: 1.0,
      dataSource: 'static',
    })
  }

  // ─── Step 2: Merge analyzer nodes ────────────────────────────────────────────

  for (const result of analysisResults) {
    for (const node of result.nodes) {
      const existing = nodes.get(node.id)
      if (existing === undefined) {
        // Net-new node — insert unconditionally
        nodes.set(node.id, node)
      } else if (SYMBOL_NODE_TYPES.has(node.type) && existing.type === 'file') {
        // Symbol node wins over bare file node on the same id
        nodes.set(node.id, node)
      }
      // All other collisions (e.g. same symbol from multiple passes): first writer wins
    }
  }

  // ─── Step 3: Merge analyzer edges ────────────────────────────────────────────

  for (const result of analysisResults) {
    for (const edge of result.edges) {
      if (!edgeMap.has(edge.id)) {
        edgeMap.set(edge.id, edge)
      }
    }
  }

  // ─── Step 4: Attach git metadata + contentHash to file nodes ─────────────────

  // Build a quick lookup: relativePath → GitFileStats
  const gitStatsMap = new Map(
    gitMetadata.fileStats.map(s => [s.filePath, s]),
  )

  // Build a quick lookup: relativePath → contentHash from ScannedFile
  const contentHashMap = new Map(
    files.map(f => [f.relativePath, f.contentHash]),
  )

  for (const [id, node] of nodes) {
    if (node.type !== 'file') continue

    const gitStats = gitStatsMap.get(id)
    const contentHash = contentHashMap.get(id)

    // Only mutate if there is something to attach
    if (gitStats !== undefined || contentHash !== undefined) {
      node.metadata = {
        ...node.metadata,
        ...(contentHash !== undefined ? { contentHash } : {}),
        ...(gitStats !== undefined
          ? {
              churnScore: gitStats.churnScore,
              lastModifiedAt: gitStats.lastModifiedAt,
              authorCount: gitStats.authorCount,
            }
          : {}),
      }
    }
  }

  // ─── Step 5: Mark hot files (top 10% by churnScore) ──────────────────────────

  // Collect churn scores from file nodes that have one
  const fileNodesWithChurn: Array<{ id: string; churn: number }> = []
  for (const [id, node] of nodes) {
    if (node.type === 'file' && typeof node.metadata?.['churnScore'] === 'number') {
      fileNodesWithChurn.push({ id, churn: node.metadata['churnScore'] as number })
    }
  }

  if (fileNodesWithChurn.length > 0) {
    const churnValues = fileNodesWithChurn.map(f => f.churn)
    const threshold = percentile(churnValues, 90)

    // Only mark files that actually have churn > 0 and meet the threshold.
    // When all files share the same churn score (e.g. all = 1), threshold === that value
    // and all would be marked hot — gate with > to avoid that noise, but fall back to
    // >= when every file shares the same non-zero score (i.e. no strict upper tier exists).
    const maxChurn = Math.max(...churnValues)
    const useStrict = maxChurn > threshold

    for (const { id, churn } of fileNodesWithChurn) {
      const isHot = useStrict ? churn > threshold : churn >= threshold && churn > 0
      if (isHot) {
        const node = nodes.get(id)!
        node.metadata = { ...node.metadata, hot: true }
      }
    }
  }

  // ─── Step 6: Stub missing edge endpoints ─────────────────────────────────────

  for (const edge of edgeMap.values()) {
    if (!nodes.has(edge.source)) {
      nodes.set(edge.source, makeStubNode(edge.source))
    }
    if (!nodes.has(edge.target)) {
      nodes.set(edge.target, makeStubNode(edge.target))
    }
  }

  // ─── Step 7: Return graph ─────────────────────────────────────────────────────

  return { nodes, edges: Array.from(edgeMap.values()) }
}
