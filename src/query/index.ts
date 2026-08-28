import type { Node, Graph } from '../graph/types.js'
import type { ModuleContext } from '../llm/adapter.js'
import type { GitFileStats } from '../persistence/interface.js'

// ─── Graph Query Helpers ──────────────────────────────────────────────────────

/**
 * Return all outgoing and incoming edges for the given node id.
 */
export function getNodeEdges(graph: Graph, nodeId: string): Graph['edges'] {
  return graph.edges.filter(e => e.source === nodeId || e.target === nodeId)
}

/**
 * Return all nodes reachable from `nodeId` within `depth` hops (breadth-first).
 * Traverses both directions (source → target and target → source).
 * depth=1 returns immediate neighbours; depth=0 returns an empty array.
 */
export function getNodeNeighbours(graph: Graph, nodeId: string, depth: number): Node[] {
  if (depth <= 0) return []
  const visited = new Set<string>([nodeId])
  const queue: Array<{ id: string; remaining: number }> = [{ id: nodeId, remaining: depth }]
  const results: Node[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.remaining === 0) continue

    for (const edge of graph.edges) {
      const neighbourId =
        edge.source === current.id ? edge.target :
        edge.target === current.id ? edge.source :
        null

      if (neighbourId === null || visited.has(neighbourId)) continue
      visited.add(neighbourId)

      const node = graph.nodes.get(neighbourId)
      if (node) {
        results.push(node)
        queue.push({ id: neighbourId, remaining: current.remaining - 1 })
      }
    }
  }

  return results
}

/**
 * Return the ids of all files this node imports (outgoing `imports` edges).
 */
export function getFileImports(graph: Graph, filePath: string): string[] {
  return graph.edges
    .filter(e => e.source === filePath && e.type === 'imports')
    .map(e => e.target)
}

/**
 * Return the ids of all targets this node re-exports (outgoing `exports` edges).
 */
export function getFileExports(graph: Graph, filePath: string): string[] {
  return graph.edges
    .filter(e => e.source === filePath && e.type === 'exports')
    .map(e => e.target)
}

// ─── Module Context Builder ───────────────────────────────────────────────────

/**
 * Assemble a `ModuleContext` for a single file node from the graph.
 *
 * This is what the engine passes to the LLM adapter in `--semantic` mode.
 * The LLM never sees raw source; it only sees this structured slice.
 *
 * V1 minimal implementation:
 *  - imports: targets of outgoing `imports` edges from this file
 *  - exports: targets of outgoing `exports` edges from this file
 *  - declarations: symbol nodes (function/class/interface/variable) whose filePath === node.filePath
 *  - gitStats: optional churn/author data from node.metadata
 *
 * Full implementation (query helpers, neighbourhood traversal) comes in Sub-Task 10.
 */
export function buildModuleContext(node: Node, graph: Graph): ModuleContext {
  const filePath = node.filePath

  const imports = getFileImports(graph, filePath)
  const exports = getFileExports(graph, filePath)

  // Collect symbol declarations that belong to this file
  const declarations: ModuleContext['declarations'] = []
  for (const n of graph.nodes.values()) {
    if (
      n.filePath === filePath &&
      (n.type === 'function' || n.type === 'class' || n.type === 'interface' || n.type === 'variable')
    ) {
      declarations.push({
        name: n.name,
        type: n.type as 'function' | 'class' | 'interface' | 'variable',
        startLine: n.startLine,
      })
    }
  }

  // Attach git stats if available on the node's metadata
  const meta = node.metadata
  const gitStats: ModuleContext['gitStats'] = (
    meta !== undefined &&
    typeof meta['churnScore'] === 'number' &&
    typeof meta['authorCount'] === 'number' &&
    typeof meta['lastModifiedAt'] === 'string'
  )
    ? {
        churnScore: meta['churnScore'] as GitFileStats['churnScore'],
        authorCount: meta['authorCount'] as GitFileStats['authorCount'],
        lastModifiedAt: meta['lastModifiedAt'] as GitFileStats['lastModifiedAt'],
      }
    : undefined

  return { filePath, imports, exports, declarations, gitStats }
}
