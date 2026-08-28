/**
 * Central re-export of all DeBob shared types.
 *
 * Consumers can import from "debob/types" instead of individual module paths.
 */

// Graph primitives
export type {
  NodeType,
  EdgeType,
  DataSource,
  ArchitecturalLayer,
  Node,
  Edge,
  Graph,
} from '../graph/types.js'

// Analyzer plugin interface
export type { LanguageAnalyzer, AnalysisResult } from '../analyzers/interface.js'

// Persistence adapter + supporting types
export type {
  PersistenceAdapter,
  FileCacheEntry,
  SemanticEnrichment,
  GitCommit,
  GitFileStats,
  GitMetadata,
} from '../persistence/interface.js'

// Scanner
export type { ScannedFile } from '../scanner/types.js'

// LLM adapter + context types
export type {
  LLMAdapter,
  LLMConfig,
  ModuleContext,
  DiffContext,
  QueryContext,
} from '../llm/adapter.js'

// Engine
export type { InitResult, InitOptions } from '../engine/index.js'
