import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { inheritLayersFromFiles } from '../graph/builder.js'
import type { ArchitecturalLayer, Node } from '../graph/types.js'
import type { SemanticEnrichment } from '../persistence/interface.js'
import { openDb, readManifest, SqlitePersistenceAdapter, writeManifest } from '../persistence/sqlite.js'
import { buildModuleContext } from '../query/index.js'
import { writeAgentInstructions } from './agentInstructions.js'

// ─── Public Types ─────────────────────────────────────────────────────────────

/** The valid layer values an importer will accept. */
export const ARCHITECTURAL_LAYERS: readonly ArchitecturalLayer[] = [
  'presentation',
  'business',
  'data',
  'config',
  'test',
  'infra',
]

/** One module handed to an agent for description. */
export interface EnrichmentTask {
  nodeId: string
  filePath: string
  imports: string[]
  exports: string[]
  declarations: Array<{ name: string; type: string; startLine?: number }>
  gitStats?: { churnScore?: number; authorCount?: number; lastModifiedAt?: string }
  /** Layer already assigned by path heuristics, if any — a hint, not an answer. */
  currentLayer?: ArchitecturalLayer
}

/** The file `debob enrich --export` writes. */
export interface EnrichmentExport {
  schemaVersion: number
  repoPath: string
  generatedAt: string
  instructions: string
  validLayers: readonly ArchitecturalLayer[]
  tasks: EnrichmentTask[]
}

/** One filled-in answer, as an agent writes it back. */
export interface EnrichmentAnswer {
  nodeId: string
  responsibility?: string
  layer?: string
}

export interface EnrichExportOptions {
  outFile: string
  /** Only export modules that have no responsibility yet. Default: true. */
  onlyMissing?: boolean
}

export interface EnrichImportOptions {
  inFile: string
  /** Recorded as the enrichment's modelId, for provenance. Default: 'claude-code'. */
  model?: string
  /** Recorded as the enrichment's llmProvider. Default: 'agent'. */
  provider?: string
}

export interface EnrichExportResult {
  outFile: string
  taskCount: number
  skippedAlreadyEnriched: number
}

export interface EnrichImportResult {
  responsibilitiesWritten: number
  layersWritten: number
  symbolsInheritedLayer: number
  skipped: Array<{ nodeId: string; reason: string }>
}

const EXPORT_SCHEMA_VERSION = 1

const INSTRUCTIONS = [
  'Fill in one entry per task in the "tasks" array and write the result as JSON.',
  'For each task produce: { "nodeId": <copied verbatim>, "responsibility": <1-3 sentences>, "layer": <one of validLayers> }.',
  'The responsibility should say what the module is FOR — its role in the system — not restate its imports.',
  'Base it on the graph facts given (imports, exports, declarations, churn). Read the source file only if the graph facts are genuinely insufficient.',
  'Output shape: either a bare JSON array of answers, or { "answers": [ ... ] }. Nothing else in the file.',
  'Then run: debob enrich --import <file>',
].join('\n')

// ─── Export ───────────────────────────────────────────────────────────────────

/**
 * Write every file module's graph context to a JSON file for an agent to describe.
 *
 * This is the API-key-free half of semantic enrichment: rather than DeBob calling a
 * hosted model, whatever coding agent is already running (Claude Code, Cursor, …) reads
 * the exported context, writes the summaries, and hands them back via `runEnrichImport`.
 * Same destination table as `--semantic`, same shape, no credentials.
 */
export async function runEnrichExport(
  repoRoot: string,
  options: EnrichExportOptions,
): Promise<EnrichExportResult> {
  const { outFile, onlyMissing = true } = options
  requireGraph(repoRoot)

  const { db, dbPath } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)
  try {
    const graph = adapter.readGraph()
    const existing = new Set(
      adapter
        .readSemanticEnrichments()
        .filter(e => e.field === 'responsibility' && e.value.trim() !== '')
        .map(e => e.nodeId),
    )

    const tasks: EnrichmentTask[] = []
    let skipped = 0
    for (const node of graph.nodes.values()) {
      if (node.type !== 'file') continue
      if (node.metadata?.['stub'] === true) continue
      if (onlyMissing && existing.has(node.id)) {
        skipped += 1
        continue
      }
      const context = buildModuleContext(node, graph)
      tasks.push({
        nodeId: node.id,
        filePath: context.filePath,
        imports: context.imports,
        exports: context.reExports,
        declarations: context.declarations,
        gitStats: context.gitStats,
        currentLayer: node.layer,
      })
    }

    const payload: EnrichmentExport = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      repoPath: repoRoot,
      generatedAt: new Date().toISOString(),
      instructions: INSTRUCTIONS,
      validLayers: ARCHITECTURAL_LAYERS,
      tasks,
    }
    writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8')

    return { outFile, taskCount: tasks.length, skippedAlreadyEnriched: skipped }
  } finally {
    // Read-only, but sql.js holds the database in memory regardless.
    adapter.close()
  }
}

// ─── Import ───────────────────────────────────────────────────────────────────

/**
 * Read agent-written answers back into `semantic_enrichments`, then propagate layers
 * onto file nodes and let their symbols inherit — the same post-processing `--semantic`
 * does, so an agent-enriched graph is indistinguishable downstream from a watsonx one
 * apart from its `llmProvider` tag.
 */
export async function runEnrichImport(
  repoRoot: string,
  options: EnrichImportOptions,
): Promise<EnrichImportResult> {
  const { inFile, model = 'claude-code', provider = 'agent' } = options
  requireGraph(repoRoot)

  if (!existsSync(inFile)) {
    throw new Error(`Answers file not found: ${inFile}`)
  }

  const answers = parseAnswers(readFileSync(inFile, 'utf8'))
  if (answers.length === 0) {
    throw new Error(
      'No answers found in the file. Expected a JSON array of { nodeId, responsibility, layer } ' +
        'objects, or an object with an "answers" array.',
    )
  }

  const { db, dbPath } = await openDb(repoRoot)
  const adapter = new SqlitePersistenceAdapter(db, dbPath)
  try {
    const graph = adapter.readGraph()
    const now = new Date().toISOString()
    const enrichments: SemanticEnrichment[] = []
    const skipped: EnrichImportResult['skipped'] = []
    const changedNodes = new Map<string, Node>()
    let responsibilitiesWritten = 0
    let layersWritten = 0

    for (const answer of answers) {
      const node = graph.nodes.get(answer.nodeId)
      if (!node) {
        // Guard against a stale answers file, or a hallucinated node id.
        skipped.push({ nodeId: answer.nodeId, reason: 'no such node in the graph' })
        continue
      }

      const responsibility = answer.responsibility?.trim()
      if (responsibility) {
        enrichments.push({
          nodeId: node.id,
          field: 'responsibility',
          value: responsibility,
          llmProvider: provider,
          modelId: model,
          createdAt: now,
        })
        responsibilitiesWritten += 1
      }

      const layer = answer.layer?.trim().toLowerCase()
      if (layer) {
        if (!ARCHITECTURAL_LAYERS.includes(layer as ArchitecturalLayer)) {
          skipped.push({ nodeId: answer.nodeId, reason: `invalid layer "${answer.layer}"` })
        } else {
          enrichments.push({
            nodeId: node.id,
            field: 'layer',
            value: layer,
            llmProvider: provider,
            modelId: model,
            createdAt: now,
          })
          node.layer = layer as ArchitecturalLayer
          changedNodes.set(node.id, node)
          layersWritten += 1
        }
      }

      if (!responsibility && !layer) {
        skipped.push({ nodeId: answer.nodeId, reason: 'neither responsibility nor layer supplied' })
      }
    }

    adapter.saveSemanticEnrichments(enrichments)

    // Layers land on file nodes; symbols inherit from the file that declares them.
    const inherited = inheritLayersFromFiles(graph.nodes)
    for (const node of inherited) changedNodes.set(node.id, node)
    if (changedNodes.size > 0) adapter.saveNodes(Array.from(changedNodes.values()))

    // The graph now has enrichments, so the manifest flag — and the AGENTS.md block it
    // words itself from — must stop telling agents there are none. Non-fatal: a failure
    // here must not lose the enrichments we just wrote.
    if (responsibilitiesWritten > 0) {
      try {
        const manifest = readManifest(repoRoot)
        if (manifest) {
          const updated = { ...manifest, semantic: true }
          writeManifest(repoRoot, updated)
          writeAgentInstructions(repoRoot, updated)
        }
      } catch {
        // Manifest/AGENTS.md refresh is best-effort.
      }
    }

    return {
      responsibilitiesWritten,
      layersWritten,
      symbolsInheritedLayer: inherited.length,
      skipped,
    }
  } finally {
    adapter.close()
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function requireGraph(repoRoot: string): void {
  if (!existsSync(join(repoRoot, '.debob', 'context.db'))) {
    throw new Error("No graph found. Run 'debob init' first.")
  }
}

/**
 * Accept the shapes an agent plausibly writes: a bare array, or an object with an
 * `answers` (or `tasks`) array. Being liberal here costs nothing and saves a round-trip
 * of "wrong wrapper key".
 */
function parseAnswers(raw: string): EnrichmentAnswer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Answers file is not valid JSON: ${message}`)
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['answers'])
      ? parsed['answers']
      : isRecord(parsed) && Array.isArray(parsed['tasks'])
        ? parsed['tasks']
        : null

  if (list === null) {
    throw new Error(
      'Expected a JSON array of answers, or an object with an "answers" array.',
    )
  }

  const answers: EnrichmentAnswer[] = []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    const nodeId = entry['nodeId']
    if (typeof nodeId !== 'string' || nodeId === '') continue
    answers.push({
      nodeId,
      responsibility: typeof entry['responsibility'] === 'string' ? entry['responsibility'] : undefined,
      layer: typeof entry['layer'] === 'string' ? entry['layer'] : undefined,
    })
  }
  return answers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
