/**
 * ScannedFile — result of scanning a single file in the repository.
 */
export interface ScannedFile {
  /** Absolute path. */
  path: string
  /** Path relative to repo root (used as node id for file nodes). */
  relativePath: string
  /** File extension including leading dot (e.g. ".ts"). */
  extension: string
  /**
   * Detected language for analyzer routing.
   * "typescript" | "javascript" | "python" | "unknown"
   * Files with "unknown" are scanned but not passed to any LanguageAnalyzer.
   */
  language: 'typescript' | 'javascript' | 'python' | 'unknown'
  /** File size in bytes. */
  sizeBytes: number
  /** SHA-256 hex digest of the file's UTF-8 content. Used for incremental update detection. */
  contentHash: string
}
