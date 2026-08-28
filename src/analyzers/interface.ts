import type { Node, Edge } from '../graph/types.js'

// ─── Analysis Result ─────────────────────────────────────────────────────────

/**
 * The result of running a LanguageAnalyzer over a single source file.
 * All nodes and edges must have confidence: 1.0 and dataSource: "static".
 */
export interface AnalysisResult {
  nodes: Node[]
  edges: Edge[]
}

// ─── Language Analyzer Plugin Interface ──────────────────────────────────────

/**
 * Plugin interface for language-specific static analyzers.
 *
 * V1 implements TypeScript/JavaScript via tree-sitter (web-tree-sitter + WASM grammar).
 * Future analyzers (Python, Rust, Go, etc.) implement this interface and register
 * their extensions with the engine — no other code changes required.
 *
 * @example
 * ```ts
 * class PythonAnalyzer implements LanguageAnalyzer {
 *   readonly language = 'python'
 *   readonly extensions = ['.py']
 *   readonly version = 'py-1.0'
 *   analyze(filePath, source) { ... }
 * }
 * ```
 */
export interface LanguageAnalyzer {
  /** Human-readable language name (e.g. "typescript"). */
  readonly language: string
  /** File extensions handled by this analyzer (e.g. [".ts", ".tsx", ".js"]). */
  readonly extensions: string[]
  /**
   * Analyzer version string. Stored in file_cache so future schema/analyzer
   * changes can be detected and trigger re-analysis of affected files.
   * Format: "{language}-{major}.{minor}" e.g. "ts-1.0"
   */
  readonly version: string
  /**
   * Analyze a single source file and return nodes + edges.
   * Synchronous — tree-sitter WASM operates synchronously after initialization.
   * All returned nodes/edges must have confidence: 1.0 and dataSource: "static".
   */
  analyze(filePath: string, source: string): AnalysisResult
}
