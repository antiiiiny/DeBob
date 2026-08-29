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

/**
 * Give every symbol node the layer of the file that declares it, where it has none of
 * its own. Layer is only ever determined per *file* — by `inferLayer`'s path heuristics
 * and, in `--semantic` mode, by the LLM — so without this every function, class and
 * interface stays unclassified no matter how well its file was classified.
 *
 * Exported because it must run **twice**: once here, and again after `--semantic`
 * propagates LLM layers onto file nodes, which happens well after the graph is built.
 * Returns only the nodes it actually changed, so callers can persist just those.
 */
export function inheritLayersFromFiles(nodes: Map<string, Node>): Node[] {
  const changed: Node[] = []
  for (const node of nodes.values()) {
    if (node.type === 'file' || node.type === 'package') continue
    if (node.layer !== undefined) continue
    const fileNode = nodes.get(node.filePath)
    if (fileNode?.layer === undefined) continue
    node.layer = fileNode.layer
    changed.push(node)
  }
  return changed
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
      } else if (existing.type === 'file' && node.type === 'file') {
        // Step 1 seeds a bare file node per scanned file, with no layer. The analyzer
        // then produces a file node for the same id carrying `inferLayer`'s result.
        // Plain first-writer-wins silently threw that layer away for every single file.
        if (existing.layer === undefined && node.layer !== undefined) existing.layer = node.layer
        if (existing.startLine === undefined) existing.startLine = node.startLine
        if (existing.endLine === undefined) existing.endLine = node.endLine
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

  // ─── Step 6: Inherit layer from declaring file ───────────────────────────────

  inheritLayersFromFiles(nodes)

  // ─── Step 7: Resolve or drop missing edge endpoints ──────────────────────────

  // A missing *file* or *package* endpoint is a real thing that simply wasn't scanned
  // (an ignored path, an uninstalled dependency), so it gets a stub node. A missing
  // *symbol* endpoint is different: it means an analyzer emitted an edge to a name it
  // couldn't resolve, and stubbing it fabricates a `file` node named after a TypeScript
  // type. Drop those edges instead — a missing edge beats an invented node.
  const isSymbolId = (id: string): boolean => id.includes('::') && !id.startsWith('pkg::')

  const resolvedEdges: Edge[] = []
  for (const edge of edgeMap.values()) {
    const missingSource = !nodes.has(edge.source)
    const missingTarget = !nodes.has(edge.target)

    if ((missingSource && isSymbolId(edge.source)) || (missingTarget && isSymbolId(edge.target))) {
      continue
    }
    if (missingSource) nodes.set(edge.source, makeStubNode(edge.source))
    if (missingTarget) nodes.set(edge.target, makeStubNode(edge.target))
    resolvedEdges.push(edge)
  }

  // ─── Step 8: Return graph ─────────────────────────────────────────────────────

  return { nodes, edges: resolvedEdges }
}
