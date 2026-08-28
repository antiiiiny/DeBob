import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { join, relative, extname } from 'path'
import { glob } from 'glob'
import type { ScannedFile } from './types.js'

export type { ScannedFile } from './types.js'

// ─── Language Detection ───────────────────────────────────────────────────────

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])

function detectLanguage(ext: string): ScannedFile['language'] {
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return 'typescript'
  if (JAVASCRIPT_EXTENSIONS.has(ext)) return 'javascript'
  return 'unknown'
}

// ─── Default Exclusion Patterns ──────────────────────────────────────────────

const DEFAULT_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.debob/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.nuxt/**',
  '**/__pycache__/**',
  '**/*.min.js',
  '**/*.min.mjs',
  '**/*.map',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
]

// ─── Content Hash ─────────────────────────────────────────────────────────────

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Additional glob patterns to ignore beyond the defaults. */
  extraIgnore?: string[]
}

/**
 * Scan a repository root and return all relevant source files.
 *
 * For each file:
 * - Computes a SHA-256 content hash (used for incremental update detection)
 * - Detects language from extension
 * - Records size in bytes
 *
 * Files with language "unknown" are included in the result so the engine can
 * still record them in file_cache, but they are not passed to any LanguageAnalyzer.
 */
export async function scanRepository(
  repoRoot: string,
  options: ScanOptions = {},
): Promise<ScannedFile[]> {
  const ignore = [...DEFAULT_IGNORE, ...(options.extraIgnore ?? [])]

  const absolutePaths = await glob('**/*', {
    cwd: repoRoot,
    nodir: true,
    absolute: true,
    ignore,
    dot: false, // skip dotfiles/dotdirs (catches .env, .eslintrc, etc.)
  })

  const files: ScannedFile[] = []

  for (const absolutePath of absolutePaths) {
    try {
      const stats = statSync(absolutePath)
      // Skip non-regular files (symlinks, etc.)
      if (!stats.isFile()) continue

      const relativePath = relative(repoRoot, absolutePath).replace(/\\/g, '/')
      const ext = extname(absolutePath).toLowerCase()
      const language = detectLanguage(ext)

      const content = readFileSync(absolutePath)
      const contentHash = sha256(content)

      files.push({
        path: absolutePath,
        relativePath,
        extension: ext,
        language,
        sizeBytes: stats.size,
        contentHash,
      })
    } catch {
      // Skip files we can't read (permissions, etc.)
    }
  }

  // Sort by relative path for deterministic ordering across runs
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  return files
}

// ─── Summary Helpers ──────────────────────────────────────────────────────────

/** Group scanned files by language and return counts. */
export function summarizeByLanguage(files: ScannedFile[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const f of files) {
    counts[f.language] = (counts[f.language] ?? 0) + 1
  }
  return counts
}
