import { existsSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { scanRepository } from '../scanner/index.js'
import { TypeScriptAnalyzer } from '../analyzers/typescript/index.js'
import type { LanguageAnalyzer, AnalysisResult } from '../analyzers/interface.js'
import { extractGitMetadata } from '../git/index.js'
import { buildGraph } from '../graph/builder.js'
import type { Node } from '../graph/types.js'
import { openDb, SqlitePersistenceAdapter, writeManifest } from '../persistence/sqlite.js'
import { SCHEMA_VERSION } from '../persistence/schema.js'
import type { FileCacheEntry, SemanticEnrichment } from '../persistence/interface.js'
import type { LLMAdapter } from '../llm/adapter.js'
import { buildModuleContext } from '../query/index.js'

const _require = createRequire(import.meta.url)
// package.json is at the repo root — two directories above src/engine/

// ─── Public Types ─────────────────────────────────────────────────────────────

/** Options accepted by runInit. */
export interface InitOptions {
  /** Maximum number of Git commits to analyze. Default: 500. */
  maxCommits?: number
  /** Log each pipeline stage with counts. */
  verbose?: boolean
  /** Run LLM semantic enrichment after structural extraction. Requires llm. */
  semantic?: boolean
  /** LLM adapter instance. Required when semantic is true. */
  llm?: LLMAdapter
}

/**
 * Structured result returned by runInit.
 * Used by the CLI to render the human-readable summary.
 */
export interface InitResult {
  /** Total graph node count. */
  nodeCount: number
  /** Total graph edge count. */
  edgeCount: number
  /** Number of source files scanned. */
  fileCount: number
  /** Number of Git commits analyzed. */
  commitCount: number
  /** File nodes marked metadata.hot === true (highest-churn files). */
  hotFiles: Node[]
  /**
   * Count of nodes grouped by their layer assignment.
   * Nodes with no layer appear under the key "unclassified".
   */
  layerDistribution: Record<string, number>
  /** Unique package dependency ids (e.g. "pkg::express"). */
  packageDependencies: string[]
  /** Absolute path to .debob/context.db. */
  dbPath: string
}

// ─── Analyzer Registry ────────────────────────────────────────────────────────

/**
 * Build the extension → LanguageAnalyzer map.
 * TypeScriptAnalyzer handles .ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts.
 * Future analyzers are added here without modifying engine logic.
 */
async function buildAnalyzerRegistry(repoRoot: string): Promise<Map<string, LanguageAnalyzer>> {
  const registry = new Map<string, LanguageAnalyzer>()
  const tsAnalyzer = await TypeScriptAnalyzer.create(repoRoot)
  for (const ext of tsAnalyzer.extensions) {
    registry.set(ext, tsAnalyzer)
  }
  return registry
}

// ─── Verbose Logger ───────────────────────────────────────────────────────────

function makeLogger(verbose: boolean) {
  return (stage: string, detail: string): void => {
    if (verbose) {
      console.log(`[debob] ${stage}: ${detail}`)
    }
  }
}

// ─── runInit ──────────────────────────────────────────────────────────────────

/**
 * Core engine orchestrator for `debob init`.
 *
 * Pipeline:
 *   1. Validate repo root
 *   2. Scan files
 *   3. Analyze (static AST)
 *   4. Extract git metadata
 *   5. Build graph
 *   6. Persist to .debob/context.db
 *   7. Semantic enrichment (optional — only when semantic && llm)
 *   8. Write .debob/manifest.json
 *   9. Return InitResult
 *
 * IMPORTANT: adapter.close() is called unconditionally before returning.
 * sql.js does not persist to disk without it.
 */
export async function runInit(
  repoRoot: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const { maxCommits = 500, verbose = false, semantic = false, llm } = options
  const log = makeLogger(verbose)

  // ─── Step 1: Validate repo root ───────────────────────────────────────────

  if (!existsSync(repoRoot)) {
    throw new Error(`Repository root does not exist: ${repoRoot}`)
  }
  if (!existsSync(join(repoRoot, '.git'))) {
    throw new Error(`Not a Git repository (no .git directory found): ${repoRoot}`)
  }

  // ─── Step 2: Scan ─────────────────────────────────────────────────────────

  log('scan', 'starting...')
  const files = await scanRepository(repoRoot)
  log('scan', `${files.length} files found`)

  // ─── Step 3: Analyze ──────────────────────────────────────────────────────

  log('analyze', 'initializing analyzers...')
  const registry = await buildAnalyzerRegistry(repoRoot)

  const analysisResults: AnalysisResult[] = []
  let analyzedCount = 0

  for (const file of files) {
    const analyzer = registry.get(file.extension)
    if (!analyzer) continue
    try {
      const { readFileSync } = await import('fs')
      const source = readFileSync(file.path, 'utf8')
      const result = analyzer.analyze(file.relativePath, source)
      analysisResults.push(result)
      analyzedCount++
    } catch {
      // Skip files that fail to parse — do not abort the whole run
    }
  }
  log('analyze', `${analyzedCount} files analyzed`)

  // ─── Step 4: Git metadata ─────────────────────────────────────────────────

  log('git', 'extracting metadata...')
  const gitMetadata = await extractGitMetadata(repoRoot, { maxCommits })
  log('git', `${gitMetadata.commits.length} commits, ${gitMetadata.fileStats.length} file stats`)

  // ─── Step 5: Build graph ──────────────────────────────────────────────────

  log('build', 'building graph...')
  const graph = buildGraph(files, analysisResults, gitMetadata)
  log('build', `${graph.nodes.size} nodes, ${graph.edges.length} edges`)

  // ─── Step 6: Persist ──────────────────────────────────────────────────────

  log('persist', 'opening database...')
  const { db, dbPath } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)

  const allNodes = Array.from(graph.nodes.values())
  adapter.saveNodes(allNodes)
  adapter.saveEdges(graph.edges)
  adapter.saveGitCommits(gitMetadata.commits)
  adapter.saveGitFileStats(gitMetadata.fileStats)

  // Build file_cache entries — one per scanned file
  const now = new Date().toISOString()
  const fileCacheEntries: FileCacheEntry[] = files.map(file => {
    const analyzer = registry.get(file.extension)
    return {
      filePath: file.relativePath,
      contentHash: file.contentHash,
      analyzerVersion: analyzer?.version ?? 'none',
      schemaVersion: SCHEMA_VERSION,
      lastAnalyzedAt: now,
      lastGitCommit: gitMetadata.headCommit,
    }
  })
  adapter.saveFileCache(fileCacheEntries)
  log('persist', `${allNodes.length} nodes, ${graph.edges.length} edges, ${fileCacheEntries.length} cache entries saved`)

  // ─── Step 7: Semantic enrichment (optional) ───────────────────────────────

  if (semantic && llm) {
    log('semantic', 'running LLM enrichment...')
    const enrichments: SemanticEnrichment[] = []
    const provider = (llm as unknown as { provider?: string }).provider ?? 'unknown'
    const modelId = (llm as unknown as { modelId?: string }).modelId ?? 'unknown'

    for (const node of graph.nodes.values()) {
      if (node.type !== 'file') continue
      try {
        const context = buildModuleContext(node, graph)
        const [responsibility, layer] = await Promise.all([
          llm.summarizeModule(context),
          llm.classifyLayer(context),
        ])
        enrichments.push(
          { nodeId: node.id, field: 'responsibility', value: responsibility, llmProvider: provider, modelId, createdAt: now },
          { nodeId: node.id, field: 'layer', value: layer, llmProvider: provider, modelId, createdAt: now },
        )
      } catch {
        // Skip nodes that fail enrichment — do not abort the whole run
      }
    }

    adapter.saveSemanticEnrichments(enrichments)
    log('semantic', `${enrichments.length} enrichments saved`)
  }

  // ─── Step 8: Save to disk (REQUIRED for sql.js) ───────────────────────────

  adapter.close()
  log('persist', `database saved to ${dbPath}`)

  // ─── Step 9: Write manifest ───────────────────────────────────────────────

  const pkg = _require('../../package.json') as { version: string }
  const nodeCount = graph.nodes.size
  const edgeCount = graph.edges.length
  const fileCount = files.length
  const commitCount = gitMetadata.commits.length

  writeManifest(repoRoot, {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    initAt: now,
    repoPath: repoRoot,
    nodeCount,
    edgeCount,
    fileCount,
    commitCount,
    semantic,
  })
  log('manifest', 'written')

  // ─── Step 10: Build and return InitResult ─────────────────────────────────

  const hotFiles = allNodes.filter(n => n.metadata?.['hot'] === true)

  const layerDistribution: Record<string, number> = {}
  for (const node of allNodes) {
    const layer = node.layer ?? 'unclassified'
    layerDistribution[layer] = (layerDistribution[layer] ?? 0) + 1
  }

  const packageDependencies = allNodes
    .filter(n => n.type === 'package')
    .map(n => n.id)

  return {
    nodeCount,
    edgeCount,
    fileCount,
    commitCount,
    hotFiles,
    layerDistribution,
    packageDependencies,
    dbPath,
  }
}
