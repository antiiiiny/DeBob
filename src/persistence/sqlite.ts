import initSqlJs, { type Database } from 'sql.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { createRequire } from 'node:module'
import { join } from 'path'
import type { Node, Edge, Graph } from '../graph/types.js'
import type {
  PersistenceAdapter,
  GitCommit,
  GitFileStats,
  FileCacheEntry,
  SemanticEnrichment,
} from './interface.js'
import { SCHEMA_DDL } from './schema.js'

// ─── Manifest Types ───────────────────────────────────────────────────────────

export interface Manifest {
  version: string
  schemaVersion: number
  initAt: string
  updatedAt?: string
  repoPath: string
  nodeCount: number
  edgeCount: number
  fileCount: number
  commitCount: number
  semantic: boolean
}

// ─── Singleton WASM init ──────────────────────────────────────────────────────

let _SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null
const _require = createRequire(import.meta.url)

async function getSql(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (_SQL) return _SQL
  // Resolve from the installed package so both source and independently built
  // modules find the WASM asset (rather than assuming a particular dist layout).
  const wasmPath = _require.resolve('sql.js/dist/sql-wasm.wasm')
  _SQL = await initSqlJs({ locateFile: () => wasmPath })
  return _SQL
}

// ─── Open / Initialize Database ──────────────────────────────────────────────

/**
 * Open (or create) the .debob/context.db database for the given repository root.
 * Creates the .debob/ directory if it does not exist.
 * Runs the schema DDL (CREATE TABLE IF NOT EXISTS — idempotent).
 * Returns a { db, dbPath } tuple. Caller must call saveDb(db, dbPath) after mutations.
 */
export async function openDb(repoRoot: string): Promise<{ db: Database; dbPath: string }> {
  const debobDir = join(repoRoot, '.debob')
  mkdirSync(debobDir, { recursive: true })

  const dbPath = join(debobDir, 'context.db')
  const SQL = await getSql()

  let db: Database
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath)
    db = new SQL.Database(fileBuffer)
  } else {
    db = new SQL.Database()
  }

  // Run schema (all CREATE IF NOT EXISTS — safe to re-run)
  db.run(SCHEMA_DDL)

  return { db, dbPath }
}

/**
 * Persist the in-memory sql.js database to disk.
 * Must be called after all mutations before the process exits.
 */
export function saveDb(db: Database, dbPath: string): void {
  const data = db.export()
  writeFileSync(dbPath, Buffer.from(data))
}

// ─── Manifest helpers ─────────────────────────────────────────────────────────

export function writeManifest(repoRoot: string, manifest: Manifest): void {
  const debobDir = join(repoRoot, '.debob')
  mkdirSync(debobDir, { recursive: true })
  writeFileSync(join(debobDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

export function readManifest(repoRoot: string): Manifest | null {
  const manifestPath = join(repoRoot, '.debob', 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as Manifest
  } catch {
    return null
  }
}

// ─── SqlitePersistenceAdapter ────────────────────────────────────────────────

/**
 * V1 implementation of PersistenceAdapter backed by sql.js (WASM SQLite).
 *
 * The engine constructs this via:
 *   const { db, dbPath } = await openDb(repoRoot)
 *   const adapter = new SqlitePersistenceAdapter(db, dbPath)
 *   // ... mutations ...
 *   adapter.close() // saves to disk
 */
export class SqlitePersistenceAdapter implements PersistenceAdapter {
  private readonly db: Database
  private readonly dbPath: string

  constructor(db: Database, dbPath: string) {
    this.db = db
    this.dbPath = dbPath
  }

  // ── Nodes ──────────────────────────────────────────────────────────────────

  saveNodes(nodes: Node[]): void {
    if (nodes.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, type, name, file_path, start_line, end_line, layer, responsibility, confidence, data_source, metadata_json)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const n of nodes) {
      stmt.run([
        n.id,
        n.type,
        n.name,
        n.filePath,
        n.startLine ?? null,
        n.endLine ?? null,
        n.layer ?? null,
        n.responsibility ?? null,
        n.confidence,
        n.dataSource,
        n.metadata ? JSON.stringify(n.metadata) : null,
      ])
    }
    stmt.free()
  }

  // ── Edges ──────────────────────────────────────────────────────────────────

  saveEdges(edges: Edge[]): void {
    if (edges.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO edges
        (id, source, target, type, confidence, data_source, metadata_json)
      VALUES
        (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of edges) {
      stmt.run([
        e.id,
        e.source,
        e.target,
        e.type,
        e.confidence,
        e.dataSource,
        e.metadata ? JSON.stringify(e.metadata) : null,
      ])
    }
    stmt.free()
  }

  // ── Git Commits ────────────────────────────────────────────────────────────

  saveGitCommits(commits: GitCommit[]): void {
    if (commits.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO git_commits
        (hash, author_name, author_email_hash, date, subject, files_changed_json)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `)
    for (const c of commits) {
      stmt.run([
        c.hash,
        c.authorName,
        c.authorEmailHash,
        c.date,
        c.subject,
        JSON.stringify(c.filesChanged),
      ])
    }
    stmt.free()
  }

  // ── Git File Stats ─────────────────────────────────────────────────────────

  saveGitFileStats(stats: GitFileStats[]): void {
    if (stats.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO git_file_stats
        (file_path, commit_count, churn_score, author_count, last_modified_at)
      VALUES
        (?, ?, ?, ?, ?)
    `)
    for (const s of stats) {
      stmt.run([
        s.filePath,
        s.commitCount,
        s.churnScore,
        s.authorCount,
        s.lastModifiedAt,
      ])
    }
    stmt.free()
  }

  // ── File Cache ─────────────────────────────────────────────────────────────

  saveFileCache(entries: FileCacheEntry[]): void {
    if (entries.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO file_cache
        (file_path, content_hash, analyzer_version, schema_version, last_analyzed_at, last_git_commit)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `)
    for (const e of entries) {
      stmt.run([
        e.filePath,
        e.contentHash,
        e.analyzerVersion,
        e.schemaVersion,
        e.lastAnalyzedAt,
        e.lastGitCommit,
      ])
    }
    stmt.free()
  }

  // ── Semantic Enrichments ──────────────────────────────────────────────────

  saveSemanticEnrichments(enrichments: SemanticEnrichment[]): void {
    if (enrichments.length === 0) return
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO semantic_enrichments
        (node_id, field, value, llm_provider, model_id, created_at)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `)
    for (const e of enrichments) {
      stmt.run([
        e.nodeId,
        e.field,
        e.value,
        e.llmProvider,
        e.modelId,
        e.createdAt,
      ])
    }
    stmt.free()
  }

  // ── Read Graph ────────────────────────────────────────────────────────────

  readGraph(): Graph {
    const nodes = new Map<string, Node>()
    const edges: Edge[] = []

    // Read nodes
    const nodeStmt = this.db.prepare('SELECT * FROM nodes')
    while (nodeStmt.step()) {
      const row = nodeStmt.getAsObject() as Record<string, unknown>
      const node: Node = {
        id: row['id'] as string,
        type: row['type'] as Node['type'],
        name: row['name'] as string,
        filePath: row['file_path'] as string,
        startLine: row['start_line'] != null ? Number(row['start_line']) : undefined,
        endLine: row['end_line'] != null ? Number(row['end_line']) : undefined,
        layer: row['layer'] as Node['layer'] ?? undefined,
        responsibility: row['responsibility'] as string ?? undefined,
        confidence: Number(row['confidence']),
        dataSource: row['data_source'] as Node['dataSource'],
        metadata: row['metadata_json']
          ? (JSON.parse(row['metadata_json'] as string) as Record<string, unknown>)
          : undefined,
      }
      nodes.set(node.id, node)
    }
    nodeStmt.free()

    // Read edges
    const edgeStmt = this.db.prepare('SELECT * FROM edges')
    while (edgeStmt.step()) {
      const row = edgeStmt.getAsObject() as Record<string, unknown>
      const edge: Edge = {
        id: row['id'] as string,
        source: row['source'] as string,
        target: row['target'] as string,
        type: row['type'] as Edge['type'],
        confidence: Number(row['confidence']),
        dataSource: row['data_source'] as Edge['dataSource'],
        metadata: row['metadata_json']
          ? (JSON.parse(row['metadata_json'] as string) as Record<string, unknown>)
          : undefined,
      }
      edges.push(edge)
    }
    edgeStmt.free()

    return { nodes, edges }
  }

  // ── Read File Cache ───────────────────────────────────────────────────────

  readFileCacheEntries(): FileCacheEntry[] {
    const entries: FileCacheEntry[] = []
    const stmt = this.db.prepare('SELECT * FROM file_cache')
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
      entries.push({
        filePath: row['file_path'] as string,
        contentHash: row['content_hash'] as string,
        analyzerVersion: row['analyzer_version'] as string,
        schemaVersion: Number(row['schema_version']),
        lastAnalyzedAt: row['last_analyzed_at'] as string,
        lastGitCommit: row['last_git_commit'] as string,
      })
    }
    stmt.free()
    return entries
  }

  // ── Close ─────────────────────────────────────────────────────────────────

  /**
   * Save the in-memory database to disk and release resources.
   * Must be called after all mutations are complete.
   */
  close(): void {
    saveDb(this.db, this.dbPath)
    this.db.close()
  }
}
