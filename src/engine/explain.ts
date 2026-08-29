import { existsSync } from 'fs'
import { join } from 'path'
import { openDb, SqlitePersistenceAdapter } from '../persistence/sqlite.js'
import { findRelevantNodes, getNodeEdges } from '../query/index.js'
import type { LLMAdapter, QueryContext } from '../llm/adapter.js'

// ─── Public Types ─────────────────────────────────────────────────────────────

/** Options accepted by runExplain. */
export interface ExplainOptions {
  /** The user's free-form question about the repository. */
  question: string
  /** Log extra detail to stdout. */
  verbose?: boolean
  /** LLM adapter — required; runExplain always calls answerQuestion. */
  llm: LLMAdapter
}

/** Structured result returned by runExplain. */
export interface ExplainResult {
  /** The question that was asked. */
  question: string
  /** Repo-relative paths of files the answer is grounded in. */
  relevantFiles: string[]
  /** LLM answer grounded in graph data. */
  answer: string
}

// ─── runExplain ───────────────────────────────────────────────────────────────

/**
 * Free-form question answering over the persisted repository graph.
 *
 * 1. Scores every graph node against the question by keyword overlap (including
 *    cached `responsibility` enrichments, when present)
 * 2. Selects the top N relevant nodes and the edges connecting them
 * 3. Calls llm.answerQuestion() with a QueryContext assembled from the above
 *
 * Never reads raw source files — only graph nodes, edges, and semantic_enrichments.
 */
export async function runExplain(repoRoot: string, options: ExplainOptions): Promise<ExplainResult> {
  const { question, verbose, llm } = options

  if (!question || !question.trim()) {
    throw new Error('A question is required, e.g. debob explain "what does the scanner do?"')
  }

  const dbPath = join(repoRoot, '.debob', 'context.db')
  if (!existsSync(dbPath)) {
    throw new Error("No graph found. Run 'debob init' first.")
  }

  const { db } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)

  try {
    const graph = adapter.readGraph()
    const enrichments = adapter.readSemanticEnrichments()

    const responsibilityByNodeId = new Map<string, string>()
    for (const e of enrichments) {
      if (e.field === 'responsibility') responsibilityByNodeId.set(e.nodeId, e.value)
    }

    const matched = findRelevantNodes(graph, question, enrichments)

    if (verbose) {
      console.log(`[debob explain] ${matched.length} relevant node(s) found.`)
    }

    // Attach cached responsibility text — Node.responsibility itself is never populated
    // in the persisted graph (only semantic_enrichments is), so it must be joined in here.
    const relevantNodes = matched.map(n => ({
      ...n,
      responsibility: responsibilityByNodeId.get(n.id) ?? n.responsibility,
    }))

    const edgeMap = new Map<string, ReturnType<typeof getNodeEdges>[number]>()
    for (const n of relevantNodes) {
      for (const edge of getNodeEdges(graph, n.id)) edgeMap.set(edge.id, edge)
    }
    const relevantEdges = [...edgeMap.values()]

    const context: QueryContext = { question, relevantNodes, relevantEdges }
    const answer = await llm.answerQuestion(context)

    return {
      question,
      relevantFiles: [...new Set(relevantNodes.map(n => n.filePath))],
      answer,
    }
  } finally {
    adapter.close()
  }
}
