import type { Node, Graph } from '../graph/types.js'
import type { ModuleContext } from './adapter.js'
import type { GitFileStats } from '../persistence/interface.js'
import { getFileImports, getFileExports } from '../query/index.js'

// ─── Module Context Builder ───────────────────────────────────────────────────

/**
 * Assemble a `ModuleContext` slice for a single file node from the graph.
 *
 * This is the ONLY thing the LLM receives — never raw source.
 * The context includes:
 *   - `filePath`      — relative path from repo root
 *   - `imports`       — module specifiers this file imports (graph edges, not source)
 *   - `exports`       — symbol ids re-exported by this file
 *   - `declarations`  — function / class / interface / variable symbol nodes
 *   - `gitStats`      — optional churn/author/date data from the node's metadata
 *
 * @param node     A file-type Node from the graph.
 * @param graph    The full in-memory graph.
 * @param gitStats Optional explicit git stats; if omitted, falls back to node.metadata.
 */
export function buildModuleContext(
  node: Node,
  graph: Graph,
  gitStats?: Pick<GitFileStats, 'churnScore' | 'authorCount' | 'lastModifiedAt'>,
): ModuleContext {
  const filePath = node.filePath

  const imports = getFileImports(graph, filePath)
  const exports = getFileExports(graph, filePath)

  // Collect symbol declarations that belong to this file node
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

  // Resolve git stats: prefer explicit parameter, fall back to node.metadata
  const resolvedGitStats: ModuleContext['gitStats'] = gitStats ?? (() => {
    const meta = node.metadata
    if (
      meta !== undefined &&
      typeof meta['churnScore'] === 'number' &&
      typeof meta['authorCount'] === 'number' &&
      typeof meta['lastModifiedAt'] === 'string'
    ) {
      return {
        churnScore: meta['churnScore'] as GitFileStats['churnScore'],
        authorCount: meta['authorCount'] as GitFileStats['authorCount'],
        lastModifiedAt: meta['lastModifiedAt'] as GitFileStats['lastModifiedAt'],
      }
    }
    return undefined
  })()

  return { filePath, imports, exports, declarations, gitStats: resolvedGitStats }
}
