import type { Node, Edge, Graph } from '../graph/types.js'

// ─── File Cache Entry ─────────────────────────────────────────────────────────

/**
 * Stored per analyzed file. Drives incremental updates:
 * on `debob update`, files whose contentHash or lastGitCommit has changed
 * since lastAnalyzedAt are re-analyzed; unchanged files are skipped.
 */
export interface FileCacheEntry {
  /** Relative path from repo root. Primary key. */
  filePath: string
  /** SHA-256 hex digest of the file's UTF-8 content at time of analysis. */
  contentHash: string
  /** Analyzer version string (e.g. "ts-1.0"). Triggers re-analysis if changed. */
  analyzerVersion: string
  /** Schema version integer at time of analysis. Triggers re-analysis if schema migrated. */
  schemaVersion: number
  /** ISO timestamp of when this file was last analyzed. */
  lastAnalyzedAt: string
  /** Git commit hash of HEAD at time of analysis. Used for incremental git diff. */
  lastGitCommit: string
}

// ─── Semantic Enrichment ──────────────────────────────────────────────────────

/**
 * A single LLM-generated enrichment for a graph node.
 * Stored separately from static facts so the origin of every piece of information
 * is unambiguous. Consumers can filter by dataSource: "llm" vs "static"/"git".
 */
export interface SemanticEnrichment {
  /** Node id this enrichment applies to. */
  nodeId: string
  /** Field being enriched: "responsibility", "layer", "workflowDescription", etc. */
  field: string
  /** The enriched value (free-form string). */
  value: string
  /** LLM provider that produced this value (e.g. "watsonx"). */
  llmProvider: string
  /** Specific model id used (e.g. "ibm/granite-13b-instruct-v2"). */
  modelId: string
  /** ISO timestamp of when this enrichment was created. */
  createdAt: string
}

// ─── Persistence Adapter Interface ───────────────────────────────────────────

/**
 * Abstract persistence interface. The engine depends only on this interface —
 * never on better-sqlite3, sql.js, or any specific storage backend.
 *
 * V1 implementation: SqlitePersistenceAdapter in src/persistence/sqlite.ts
 * Future: could be backed by a graph DB, in-memory store for tests, etc.
 */
export interface PersistenceAdapter {
  /** Upsert nodes by id. */
  saveNodes(nodes: Node[]): void
  /** Upsert edges by id. */
  saveEdges(edges: Edge[]): void
  /** Upsert git commits by hash. */
  saveGitCommits(commits: GitCommit[]): void
  /** Upsert per-file git stats by filePath. */
  saveGitFileStats(stats: GitFileStats[]): void
  /** Upsert file cache entries by filePath. */
  saveFileCache(entries: FileCacheEntry[]): void
  /** Upsert semantic enrichments by (nodeId, field). */
  saveSemanticEnrichments(enrichments: SemanticEnrichment[]): void
  /** Delete every graph node declared by one of the supplied files. */
  deleteNodesByFilePaths(filePaths: string[]): void
  /** Delete edges whose source node is one of the supplied ids. */
  deleteEdgesBySourceIds(nodeIds: string[]): void
  /** Delete edges that reference one of the supplied node ids at either endpoint. */
  deleteEdgesByNodeIds(nodeIds: string[]): void
  /** Delete file-cache rows for files no longer present in the repository. */
  deleteFileCacheEntries(filePaths: string[]): void
  /** Delete LLM outputs for nodes that are about to be re-analyzed or removed. */
  deleteSemanticEnrichments(nodeIds: string[]): void
  /**
   * Drop every node and edge, so a full `debob init` is authoritative rather than an
   * upsert over whatever the last run happened to leave behind. Deliberately leaves
   * semantic_enrichments intact: LLM output is expensive, keyed by node id, and still
   * valid for every node the rebuild reproduces.
   */
  clearGraph(): void
  /** Read the full graph from storage. */
  readGraph(): Graph
  /** Read all file cache entries (used by engine to determine what needs re-analysis). */
  readFileCacheEntries(): FileCacheEntry[]
  /** Read the persisted per-file Git statistics. */
  readGitFileStats(): GitFileStats[]
  /** Read LLM enrichments, optionally limited to a set of node ids. */
  readSemanticEnrichments(nodeIds?: string[]): SemanticEnrichment[]
  /** Close and release database resources. */
  close(): void
}

// ─── Git Types (re-exported from persistence interface for convenience) ───────

export interface GitCommit {
  hash: string
  authorName: string
  /** SHA-256 hex digest of the author's email address. Raw email is never stored. */
  authorEmailHash: string
  /** ISO date string. */
  date: string
  subject: string
  /** List of relative file paths changed by this commit. */
  filesChanged: string[]
}

export interface GitFileStats {
  /** Relative path from repo root. */
  filePath: string
  /** Total number of commits that touched this file. */
  commitCount: number
  /** Raw churn score (= commitCount). Higher = more volatile. */
  churnScore: number
  /** Number of unique authors (based on hashed emails). */
  authorCount: number
  /** ISO date string of the most recent commit touching this file. */
  lastModifiedAt: string
}

export interface GitMetadata {
  commits: GitCommit[]
  fileStats: GitFileStats[]
  /** HEAD commit hash at time of extraction. Stored in file_cache for incremental diff. */
  headCommit: string
}
