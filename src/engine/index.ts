import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { scanRepository } from '../scanner/index.js'
import { TypeScriptAnalyzer } from '../analyzers/typescript/index.js'
import { PythonAnalyzer } from '../analyzers/python/index.js'
import type { LanguageAnalyzer, AnalysisResult } from '../analyzers/interface.js'
import { extractGitMetadata } from '../git/index.js'
import { buildGraph, inheritLayersFromFiles } from '../graph/builder.js'
import type { ArchitecturalLayer, Edge, Graph, Node } from '../graph/types.js'
import { openDb, readManifest, SqlitePersistenceAdapter, writeManifest } from '../persistence/sqlite.js'
import type { Manifest } from '../persistence/sqlite.js'
import { writeAgentInstructions } from './agentInstructions.js'
import { SCHEMA_VERSION } from '../persistence/schema.js'
import type { FileCacheEntry, GitFileStats, SemanticEnrichment } from '../persistence/interface.js'
import type { LLMAdapter } from '../llm/adapter.js'
import { buildModuleContext } from '../query/index.js'
import type { ScannedFile } from '../scanner/types.js'

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

/** Options accepted by runUpdate. */
export interface UpdateOptions extends InitOptions {}

/**
 * Summary of the structural work completed by an incremental update.
 * Node and edge fields are counts; file fields contain repository-relative paths.
 */
export interface UpdateResult {
  addedNodes: number
  removedNodes: number
  updatedNodes: number
  addedEdges: number
  removedEdges: number
  reanalyzedFiles: string[]
  skippedFiles: string[]
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
  const pyAnalyzer = await PythonAnalyzer.create(repoRoot)
  for (const ext of pyAnalyzer.extensions) {
    registry.set(ext, pyAnalyzer)
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

// ─── Incremental-update helpers ────────────────────────────────────────────

function makeFileNode(file: ScannedFile): Node {
  return {
    id: file.relativePath,
    type: 'file',
    name: file.relativePath.split('/').pop() ?? file.relativePath,
    filePath: file.relativePath,
    confidence: 1.0,
    dataSource: 'static',
    metadata: { contentHash: file.contentHash },
  }
}

function makeStubNode(id: string): Node {
  const isPackage = id.startsWith('pkg::')
  return {
    id,
    type: isPackage ? 'package' : 'file',
    name: isPackage ? id.slice('pkg::'.length) : (id.split('/').pop() ?? id),
    filePath: id,
    confidence: 1.0,
    dataSource: 'static',
    metadata: { stub: true },
  }
}

function applyFileMetadata(
  node: Node,
  file: ScannedFile,
  gitStats: GitFileStats | undefined,
): void {
  node.metadata = {
    ...node.metadata,
    contentHash: file.contentHash,
    ...(gitStats === undefined
      ? {}
      : {
          churnScore: gitStats.churnScore,
          authorCount: gitStats.authorCount,
          lastModifiedAt: gitStats.lastModifiedAt,
        }),
  }
}

function mergeAnalysisResults(graph: Graph, analysisResults: AnalysisResult[]): void {
  const edgeMap = new Map(graph.edges.map(edge => [edge.id, edge]))

  for (const result of analysisResults) {
    for (const node of result.nodes) {
      const existing = graph.nodes.get(node.id)
      if (node.type === 'file' && existing?.type === 'file') {
        // Preserve scanner/Git metadata while retaining analyzer-derived layer hints.
        graph.nodes.set(node.id, { ...node, metadata: existing.metadata })
      } else {
        graph.nodes.set(node.id, node)
      }
    }
    for (const edge of result.edges) edgeMap.set(edge.id, edge)
  }

  for (const edge of edgeMap.values()) {
    if (!graph.nodes.has(edge.source)) graph.nodes.set(edge.source, makeStubNode(edge.source))
    if (!graph.nodes.has(edge.target)) graph.nodes.set(edge.target, makeStubNode(edge.target))
  }

  graph.edges = Array.from(edgeMap.values())
}

function removeUnreferencedPackages(graph: Graph): void {
  const referenced = new Set<string>()
  for (const edge of graph.edges) {
    referenced.add(edge.source)
    referenced.add(edge.target)
  }
  for (const [id, node] of graph.nodes) {
    if (node.type === 'package' && !referenced.has(id)) graph.nodes.delete(id)
  }
}

function markHotFiles(graph: Graph): void {
  const fileNodes = Array.from(graph.nodes.values()).filter(
    node => node.type === 'file' && typeof node.metadata?.['churnScore'] === 'number',
  )
  if (fileNodes.length === 0) return

  for (const node of fileNodes) {
    if (node.metadata?.['hot'] === true) {
      const { hot: _hot, ...metadata } = node.metadata
      node.metadata = metadata
    }
  }

  const churnValues = fileNodes.map(node => node.metadata!['churnScore'] as number).sort((a, b) => a - b)
  const threshold = churnValues[Math.max(0, Math.ceil(churnValues.length * 0.9) - 1)] ?? 0
  const maxChurn = churnValues[churnValues.length - 1] ?? 0
  const useStrictThreshold = maxChurn > threshold

  for (const node of fileNodes) {
    const churn = node.metadata!['churnScore'] as number
    const isHot = useStrictThreshold ? churn > threshold : churn >= threshold && churn > 0
    if (isHot) node.metadata = { ...node.metadata, hot: true }
  }
}

function mergeGitFileStats(
  existingStats: GitFileStats[],
  newStats: GitFileStats[],
): GitFileStats[] {
  const merged = new Map(existingStats.map(stats => [stats.filePath, { ...stats }]))
  for (const next of newStats) {
    const existing = merged.get(next.filePath)
    if (!existing) {
      merged.set(next.filePath, next)
      continue
    }
    // Existing rows intentionally retain only an author count, never author identifiers.
    // Therefore a precise cross-run union is impossible without weakening the privacy model;
    // keep the conservative lower bound while accumulating deterministic churn counts.
    merged.set(next.filePath, {
      filePath: next.filePath,
      commitCount: existing.commitCount + next.commitCount,
      churnScore: existing.churnScore + next.churnScore,
      authorCount: Math.max(existing.authorCount, next.authorCount),
      lastModifiedAt: existing.lastModifiedAt > next.lastModifiedAt
        ? existing.lastModifiedAt
        : next.lastModifiedAt,
    })
  }
  return Array.from(merged.values())
}

function countChangedEntries<T>(
  before: Map<string, string>,
  after: Map<string, T>,
  encode: (value: T) => string,
): number {
  let count = 0
  for (const [id, value] of after) {
    const prior = before.get(id)
    if (prior !== undefined && prior !== encode(value)) count++
  }
  return count
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

  // `init` is a full rebuild, so the freshly built graph must be the whole truth. Without
  // this the saves below are pure upserts: nodes an earlier run produced but this one no
  // longer does (a renamed symbol, or a phantom from a since-fixed analyzer bug) survive
  // forever with nothing to ever remove them. Enrichments are preserved — see clearGraph.
  // Re-apply layers the LLM already worked out on a previous run. clearGraph() drops the
  // nodes those layers were written onto, but the enrichments themselves survive — so
  // without this a plain structural `debob init` silently throws away paid-for LLM output
  // and every file reverts to whatever the path heuristics can guess.
  const existingEnrichments = adapter.readSemanticEnrichments()
  let restoredLayers = 0
  for (const enrichment of existingEnrichments) {
    if (enrichment.field !== 'layer') continue
    const node = graph.nodes.get(enrichment.nodeId)
    if (!node) continue
    node.layer = enrichment.value as ArchitecturalLayer
    restoredLayers += 1
  }
  if (restoredLayers > 0) {
    const reinherited = inheritLayersFromFiles(graph.nodes)
    log('persist', `${restoredLayers} cached LLM layers restored, ${reinherited.length} inherited`)
  }

  adapter.clearGraph()

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

    // Propagate layer enrichments back to Node.layer so layerDistribution is accurate
    const layerEnrichments = enrichments.filter(e => e.field === 'layer')
    const updatedLayerNodes: Node[] = []
    for (const e of layerEnrichments) {
      const node = graph.nodes.get(e.nodeId)
      if (node) {
        node.layer = e.value as ArchitecturalLayer
        updatedLayerNodes.push(node)
      }
    }
    // The LLM classifies *files*. Symbols inherited a layer back when the graph was built,
    // which was before any of this ran — so re-run the inheritance now that file nodes
    // finally carry the LLM's answer, or every symbol stays unclassified.
    const inheritedNodes = inheritLayersFromFiles(graph.nodes)
    const layerNodesToSave = [...updatedLayerNodes, ...inheritedNodes]
    if (layerNodesToSave.length > 0) {
      adapter.saveNodes(layerNodesToSave)
    }
    log(
      'semantic',
      `${enrichments.length} enrichments saved, ${updatedLayerNodes.length} layers propagated, ` +
        `${inheritedNodes.length} symbols inherited a layer`,
    )
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

  const manifestData: Manifest = {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    initAt: now,
    repoPath: repoRoot,
    nodeCount,
    edgeCount,
    fileCount,
    commitCount,
    headCommit: gitMetadata.headCommit,
    semantic,
  }
  writeManifest(repoRoot, manifestData)
  log('manifest', 'written')

  try {
    writeAgentInstructions(repoRoot, manifestData)
    log('agents', 'AGENTS.md updated with DeBob discovery block')
  } catch (err) {
    log('agents', `could not update AGENTS.md: ${err instanceof Error ? err.message : String(err)}`)
  }

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

// ─── runUpdate ────────────────────────────────────────────────────────────────

/**
 * Incremental engine orchestrator for `debob update`.
 *
 * Pipeline:
 *   1. Validate DB exists; open it
 *   2. Read manifest — fall back to full runInit if schema version mismatches
 *   3. Diff scanned files against file_cache
 *   4. Re-analyze only added/changed files
 *   5. Extract incremental git metadata (since last headCommit)
 *   6. Purge removed files from graph and DB
 *   7. Merge new analysis into existing graph
 *   8. Merge git file stats; re-apply metadata; re-mark hot files
 *   9. Persist changes
 *  10. Optional semantic enrichment on re-analyzed nodes only
 *  11. adapter.close(); write manifest; return UpdateResult
 */
export async function runUpdate(
  repoRoot: string,
  options: UpdateOptions = {},
): Promise<UpdateResult> {
  const { maxCommits = 500, verbose = false, semantic = false, llm } = options
  const log = makeLogger(verbose)

  // ─── Step 1: Open existing DB ─────────────────────────────────────────────

  const dbPath = join(repoRoot, '.debob', 'context.db')
  if (!existsSync(dbPath)) {
    throw new Error("No graph found. Run 'debob init' first.")
  }

  const manifest = readManifest(repoRoot)

  // ─── Step 2: Schema version guard ─────────────────────────────────────────

  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION) {
    log('update', 'schema version mismatch — falling back to full init')
    const initResult = await runInit(repoRoot, options)
    return {
      addedNodes: initResult.nodeCount,
      removedNodes: 0,
      updatedNodes: 0,
      addedEdges: initResult.edgeCount,
      removedEdges: 0,
      reanalyzedFiles: [],
      skippedFiles: [],
      dbPath: initResult.dbPath,
    }
  }

  const { db, dbPath: resolvedDbPath } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, resolvedDbPath)

  // ─── Step 3: Diff scanned files against cache ─────────────────────────────

  log('scan', 'starting...')
  const files = await scanRepository(repoRoot)
  log('scan', `${files.length} files found`)

  const cacheEntries = adapter.readFileCacheEntries()
  const cacheMap = new Map(cacheEntries.map(e => [e.filePath, e]))

  const registry = await buildAnalyzerRegistry(repoRoot)

  const addedFiles: typeof files = []
  const changedFiles: typeof files = []
  const unchangedFiles: typeof files = []

  for (const file of files) {
    const cached = cacheMap.get(file.relativePath)
    if (!cached) {
      addedFiles.push(file)
    } else if (
      cached.contentHash !== file.contentHash ||
      cached.schemaVersion !== SCHEMA_VERSION ||
      cached.analyzerVersion !== (registry.get(file.extension)?.version ?? 'none')
    ) {
      changedFiles.push(file)
    } else {
      unchangedFiles.push(file)
    }
  }

  const currentPaths = new Set(files.map(f => f.relativePath))
  const removedPaths = cacheEntries
    .map(e => e.filePath)
    .filter(p => !currentPaths.has(p))

  log(
    'diff',
    `added=${addedFiles.length} changed=${changedFiles.length} removed=${removedPaths.length} unchanged=${unchangedFiles.length}`,
  )

  // ─── Step 4: Analyze added + changed files ────────────────────────────────

  const reanalyzedFiles = [...addedFiles, ...changedFiles]
  const analysisResults: AnalysisResult[] = []

  for (const file of reanalyzedFiles) {
    const analyzer = registry.get(file.extension)
    if (!analyzer) continue
    try {
      const source = readFileSync(file.path, 'utf8')
      const result = analyzer.analyze(file.relativePath, source)
      analysisResults.push(result)
    } catch {
      // Skip unparseable files
    }
  }
  log('analyze', `${analysisResults.length} files re-analyzed`)

  // ─── Step 5: Incremental git metadata ────────────────────────────────────

  log('git', 'extracting incremental metadata...')
  const fromCommit = manifest.headCommit
  const newGitMetadata = await extractGitMetadata(repoRoot, {
    maxCommits,
    fromCommit: fromCommit || undefined,
  })
  log('git', `${newGitMetadata.commits.length} new commits`)

  // ─── Step 6: Load existing graph; purge removed files ────────────────────

  log('update', 'loading existing graph...')
  const graph = adapter.readGraph()

  const nodesBefore = graph.nodes.size
  const edgesBefore = graph.edges.length

  if (removedPaths.length > 0) {
    // Collect all node ids belonging to removed files (file nodes + symbol nodes)
    const removedNodeIds: string[] = []
    for (const [id, node] of graph.nodes) {
      if (removedPaths.includes(node.filePath)) removedNodeIds.push(id)
    }
    for (const id of removedNodeIds) graph.nodes.delete(id)
    graph.edges = graph.edges.filter(
      e => graph.nodes.has(e.source) && graph.nodes.has(e.target),
    )

    adapter.deleteNodesByFilePaths(removedPaths)
    adapter.deleteEdgesByNodeIds(removedNodeIds)
    adapter.deleteFileCacheEntries(removedPaths)
    adapter.deleteSemanticEnrichments(removedNodeIds)
    log('purge', `${removedNodeIds.length} nodes, ${removedPaths.length} cache entries removed`)
  }

  // Also purge nodes/edges for changed files before re-merging
  if (changedFiles.length > 0) {
    const changedPaths = changedFiles.map(f => f.relativePath)
    const changedNodeIds: string[] = []
    for (const [id, node] of graph.nodes) {
      if (changedPaths.includes(node.filePath)) changedNodeIds.push(id)
    }
    for (const id of changedNodeIds) graph.nodes.delete(id)
    graph.edges = graph.edges.filter(
      e => graph.nodes.has(e.source) && graph.nodes.has(e.target),
    )
    adapter.deleteNodesByFilePaths(changedPaths)
    adapter.deleteEdgesByNodeIds(changedNodeIds)
    adapter.deleteSemanticEnrichments(changedNodeIds)
  }

  // ─── Step 7: Merge new analysis into existing graph ───────────────────────

  // Seed the graph with file nodes for newly added/changed files
  for (const file of reanalyzedFiles) {
    if (!graph.nodes.has(file.relativePath)) {
      graph.nodes.set(file.relativePath, makeFileNode(file))
    }
  }

  mergeAnalysisResults(graph, analysisResults)
  removeUnreferencedPackages(graph)

  // ─── Step 8: Merge git stats; re-apply metadata; re-mark hot files ────────

  const existingGitStats = adapter.readGitFileStats()
  const mergedGitStats = mergeGitFileStats(existingGitStats, newGitMetadata.fileStats)
  const gitStatsMap = new Map(mergedGitStats.map(s => [s.filePath, s]))

  for (const file of files) {
    const node = graph.nodes.get(file.relativePath)
    if (!node) continue
    applyFileMetadata(node, file, gitStatsMap.get(file.relativePath))
  }
  markHotFiles(graph)

  // ─── Step 9: Persist ──────────────────────────────────────────────────────

  const allNodes = Array.from(graph.nodes.values())
  adapter.saveNodes(allNodes)
  adapter.saveEdges(graph.edges)
  if (newGitMetadata.commits.length > 0) {
    adapter.saveGitCommits(newGitMetadata.commits)
  }
  adapter.saveGitFileStats(mergedGitStats)

  const now = new Date().toISOString()
  const updatedCacheEntries: FileCacheEntry[] = reanalyzedFiles.map(file => ({
    filePath: file.relativePath,
    contentHash: file.contentHash,
    analyzerVersion: registry.get(file.extension)?.version ?? 'none',
    schemaVersion: SCHEMA_VERSION,
    lastAnalyzedAt: now,
    lastGitCommit: newGitMetadata.headCommit || manifest.headCommit || '',
  }))
  if (updatedCacheEntries.length > 0) {
    adapter.saveFileCache(updatedCacheEntries)
  }
  log(
    'persist',
    `${allNodes.length} nodes, ${graph.edges.length} edges saved`,
  )

  // ─── Step 10: Semantic enrichment (re-analyzed nodes only) ────────────────

  if (semantic && llm && reanalyzedFiles.length > 0) {
    log('semantic', 'running LLM enrichment on re-analyzed nodes...')
    const enrichments: SemanticEnrichment[] = []
    const provider = (llm as unknown as { provider?: string }).provider ?? 'unknown'
    const modelId = (llm as unknown as { modelId?: string }).modelId ?? 'unknown'

    const reanalyzedIds = new Set(reanalyzedFiles.map(f => f.relativePath))
    for (const node of graph.nodes.values()) {
      if (node.type !== 'file' || !reanalyzedIds.has(node.id)) continue
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
        // Skip nodes that fail enrichment
      }
    }
    adapter.saveSemanticEnrichments(enrichments)

    // Propagate layer enrichments back to Node.layer
    const layerEnrichments = enrichments.filter(e => e.field === 'layer')
    const updatedLayerNodes: Node[] = []
    for (const e of layerEnrichments) {
      const node = graph.nodes.get(e.nodeId)
      if (node) {
        node.layer = e.value as ArchitecturalLayer
        updatedLayerNodes.push(node)
      }
    }
    // The LLM classifies *files*. Symbols inherited a layer back when the graph was built,
    // which was before any of this ran — so re-run the inheritance now that file nodes
    // finally carry the LLM's answer, or every symbol stays unclassified.
    const inheritedNodes = inheritLayersFromFiles(graph.nodes)
    const layerNodesToSave = [...updatedLayerNodes, ...inheritedNodes]
    if (layerNodesToSave.length > 0) {
      adapter.saveNodes(layerNodesToSave)
    }
    log(
      'semantic',
      `${enrichments.length} enrichments saved, ${updatedLayerNodes.length} layers propagated, ` +
        `${inheritedNodes.length} symbols inherited a layer`,
    )
  }

  // ─── Step 11: Close DB; write manifest ────────────────────────────────────

  adapter.close()
  log('persist', `database saved to ${resolvedDbPath}`)

  const pkg = _require('../../package.json') as { version: string }
  const manifestData: Manifest = {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    initAt: manifest.initAt,
    updatedAt: now,
    repoPath: repoRoot,
    nodeCount: graph.nodes.size,
    edgeCount: graph.edges.length,
    fileCount: files.length,
    commitCount: (manifest.commitCount ?? 0) + newGitMetadata.commits.length,
    headCommit: newGitMetadata.headCommit || manifest.headCommit || '',
    semantic: manifest.semantic || (semantic && llm !== undefined),
  }
  writeManifest(repoRoot, manifestData)
  log('manifest', 'written')

  try {
    writeAgentInstructions(repoRoot, manifestData)
    log('agents', 'AGENTS.md updated with DeBob discovery block')
  } catch (err) {
    log('agents', `could not update AGENTS.md: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ─── Build UpdateResult ───────────────────────────────────────────────────

  const nodesAfter = graph.nodes.size
  const edgesAfter = graph.edges.length

  return {
    addedNodes: Math.max(0, nodesAfter - nodesBefore + removedPaths.length),
    removedNodes: removedPaths.length,
    updatedNodes: changedFiles.length,
    addedEdges: Math.max(0, edgesAfter - edgesBefore),
    removedEdges: Math.max(0, edgesBefore - edgesAfter),
    reanalyzedFiles: reanalyzedFiles.map(f => f.relativePath),
    skippedFiles: unchangedFiles.map(f => f.relativePath),
    dbPath: resolvedDbPath,
  }
}
