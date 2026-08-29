/**
 * Core graph type definitions for DeBob.
 *
 * All deterministic (static analysis / git) data carries confidence: 1.0 and dataSource: "static" | "git".
 * LLM-inferred data carries confidence < 1.0 and dataSource: "llm".
 */

// ─── Node Types ──────────────────────────────────────────────────────────────

/**
 * All possible node types in the DeBob graph.
 * String union (not enum) so new values can be added without breaking existing consumers.
 */
export type NodeType =
  | 'file'
  | 'function'
  | 'class'
  | 'interface'
  | 'variable'
  | 'route'
  | 'package'

// ─── Edge Types ──────────────────────────────────────────────────────────────

/**
 * All possible edge types in the DeBob graph.
 * String union — extensible without breaking changes.
 */
export type EdgeType =
  | 'imports'
  | 'exports'
  /** Structural containment: a file declares a symbol, a class declares a method. */
  | 'declares'
  | 'calls'
  | 'depends_on'
  | 'extends'
  | 'implements'
  | 'instantiates'
  | 'exposes'
  | 'handles'
  | 'tests'
  | 'reads_from'
  | 'writes_to'
  | 'communicates_with'
  | 'configured_by'
  | 'related_to'

// ─── Data Source ─────────────────────────────────────────────────────────────

/** Origin of a node or edge: deterministic analysis, git metadata, or LLM inference. */
export type DataSource = 'static' | 'git' | 'llm'

// ─── Architectural Layers ────────────────────────────────────────────────────

export type ArchitecturalLayer =
  | 'presentation'
  | 'business'
  | 'data'
  | 'config'
  | 'test'
  | 'infra'

// ─── Node ────────────────────────────────────────────────────────────────────

export interface Node {
  /** Stable canonical id. For files: relative path. For symbols: "relativePath::SymbolName". */
  id: string
  type: NodeType
  name: string
  /** Relative path from repo root. */
  filePath: string
  startLine?: number
  endLine?: number
  /**
   * Architectural layer assignment.
   * Heuristically inferred from path patterns (confidence: 1.0) or by LLM (confidence < 1.0).
   */
  layer?: ArchitecturalLayer
  /**
   * Human-readable module responsibility summary.
   * Populated by LLM semantic enrichment; stored separately in semantic_enrichments table.
   */
  responsibility?: string
  /** 1.0 = deterministic static analysis; < 1.0 = LLM inference */
  confidence: number
  /** Where this node's data came from. */
  dataSource: DataSource
  /**
   * Arbitrary additional metadata.
   * For file nodes: churnScore, lastModifiedAt, authorCount, contentHash, hot.
   */
  metadata?: Record<string, unknown>
}

// ─── Edge ────────────────────────────────────────────────────────────────────

export interface Edge {
  /**
   * Deterministic id: "${source}::${type}::${target}".
   * Ensures deduplication across multiple analysis passes.
   */
  id: string
  /** Source node id. */
  source: string
  /** Target node id. */
  target: string
  type: EdgeType
  /** 1.0 = deterministic; < 1.0 = LLM inference */
  confidence: number
  dataSource: DataSource
  metadata?: Record<string, unknown>
}

// ─── Graph ───────────────────────────────────────────────────────────────────

export interface Graph {
  /** Nodes indexed by id for O(1) lookup. */
  nodes: Map<string, Node>
  /** Edges as a flat array (deduped by id). */
  edges: Edge[]
}
