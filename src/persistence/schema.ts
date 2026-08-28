/**
 * SQLite schema definitions for DeBob's context.db.
 *
 * SCHEMA_VERSION is incremented whenever a breaking schema change is made.
 * The version is stored in manifest.json so future `debob update` runs can
 * detect when a full re-analysis is needed due to schema migration.
 */

export const SCHEMA_VERSION = 1

/**
 * All CREATE TABLE statements for context.db.
 * All tables use INSERT OR REPLACE for idempotent upserts keyed on stable ids.
 */
export const SCHEMA_DDL = `
-- Graph nodes: files, functions, classes, interfaces, packages
CREATE TABLE IF NOT EXISTS nodes (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  name            TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  start_line      INTEGER,
  end_line        INTEGER,
  layer           TEXT,
  responsibility  TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  data_source     TEXT NOT NULL DEFAULT 'static',
  metadata_json   TEXT
);

-- Typed relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  target          TEXT NOT NULL,
  type            TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  data_source     TEXT NOT NULL DEFAULT 'static',
  metadata_json   TEXT
);

-- Git commit history (author emails stored as SHA-256 hashes — never plaintext)
CREATE TABLE IF NOT EXISTS git_commits (
  hash              TEXT PRIMARY KEY,
  author_name       TEXT NOT NULL,
  author_email_hash TEXT NOT NULL,
  date              TEXT NOT NULL,
  subject           TEXT NOT NULL,
  files_changed_json TEXT NOT NULL
);

-- Per-file Git statistics aggregated from commit history
CREATE TABLE IF NOT EXISTS git_file_stats (
  file_path       TEXT PRIMARY KEY,
  commit_count    INTEGER NOT NULL DEFAULT 0,
  churn_score     REAL NOT NULL DEFAULT 0,
  author_count    INTEGER NOT NULL DEFAULT 0,
  last_modified_at TEXT NOT NULL
);

-- File content hash + analyzer version cache for incremental updates.
-- On debob update: files whose content_hash or last_git_commit differs from
-- stored values are re-analyzed; unchanged files are skipped.
CREATE TABLE IF NOT EXISTS file_cache (
  file_path        TEXT PRIMARY KEY,
  content_hash     TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  last_analyzed_at TEXT NOT NULL,
  last_git_commit  TEXT NOT NULL
);

-- LLM-generated semantic enrichments stored separately from static facts.
-- Every row carries llm_provider and model_id for full provenance tracing.
-- Upserted on (node_id, field) so re-running --semantic updates values in place.
CREATE TABLE IF NOT EXISTS semantic_enrichments (
  node_id      TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT NOT NULL,
  llm_provider TEXT NOT NULL,
  model_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (node_id, field)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes (file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes (type);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges (type);
CREATE INDEX IF NOT EXISTS idx_semantic_node ON semantic_enrichments (node_id);
`
