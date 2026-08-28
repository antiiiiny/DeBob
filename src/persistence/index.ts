import { SCHEMA_VERSION } from './schema.js'

/**
 * Current schema version.
 * Re-exported for use in engine and file cache entries.
 */
export { SCHEMA_VERSION }

export type { PersistenceAdapter } from './interface.js'
export { SqlitePersistenceAdapter, openDb, writeManifest, readManifest } from './sqlite.js'
