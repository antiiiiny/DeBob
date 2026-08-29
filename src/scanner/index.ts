import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { relative, extname } from 'path'
import { glob } from 'glob'
import ignore from 'ignore'
import type { ScannedFile } from './types.js'

export type { ScannedFile } from './types.js'

// ─── Language Detection ───────────────────────────────────────────────────────

const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs'])
const PYTHON_EXTENSIONS = new Set(['.py'])

function detectLanguage(ext: string): ScannedFile['language'] {
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return 'typescript'
  if (JAVASCRIPT_EXTENSIONS.has(ext)) return 'javascript'
  if (PYTHON_EXTENSIONS.has(ext)) return 'python'
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

// ─── Binary / Huge-File Guards ────────────────────────────────────────────────

/** Files larger than this are skipped before readFileSync. 1 MB. */
const MAX_FILE_BYTES = 1 * 1024 * 1024

/**
 * Extensions that are known to be text-based source or config formats.
 * Files whose extension is NOT in this set are skipped — they are either
 * binary (images, fonts, wasm, zip) or have no meaningful symbol content.
 * Files with language "unknown" still pass; the engine records them in
 * file_cache but no LanguageAnalyzer receives them.
 */
const TEXT_EXTENSIONS = new Set([
  // TypeScript / JavaScript
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  // Python
  '.py',
  // Data / config
  '.json', '.jsonc', '.yaml', '.yml', '.toml',
  // Markup / docs
  '.md', '.mdx', '.txt', '.html', '.htm', '.xml', '.svg',
  // Styles
  '.css', '.scss', '.sass', '.less',
  // Query / schema / infra
  '.graphql', '.gql', '.sql', '.prisma', '.proto',
  '.tf', '.hcl',
  // Shell
  '.sh', '.bash', '.zsh', '.fish',
  // Frontend frameworks
  '.vue', '.svelte', '.astro',
])

// ─── Content Hash ─────────────────────────────────────────────────────────────

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

// ─── Gitignore Helpers ────────────────────────────────────────────────────────

/**
 * Attempt to read a file as UTF-8 text.
 * Returns an empty string if the file does not exist or cannot be read.
 */
function tryReadText(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

export interface ScanOptions {
  /** Additional glob patterns to ignore beyond the defaults. */
  extraIgnore?: string[]
  /**
   * When true (default), the scanner reads `.gitignore` and `.debobignore`
   * from the repo root and excludes any paths they match.
   * Set to false to disable (e.g. in tests that scan temp directories).
   */
  respectGitignore?: boolean
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
 *
 * Files are excluded when they:
 * - Match DEFAULT_IGNORE glob patterns or extraIgnore patterns
 * - Match rules in .gitignore or .debobignore (unless respectGitignore is false)
 * - Exceed MAX_FILE_BYTES in size
 * - Have an extension not in TEXT_EXTENSIONS
 */
export async function scanRepository(
  repoRoot: string,
  options: ScanOptions = {},
): Promise<ScannedFile[]> {
  const { extraIgnore = [], respectGitignore = true } = options

  const ignorePatterns = [...DEFAULT_IGNORE, ...extraIgnore]

  const absolutePaths = await glob('**/*', {
    cwd: repoRoot,
    nodir: true,
    absolute: true,
    ignore: ignorePatterns,
    dot: false, // skip dotfiles/dotdirs (catches .env, .eslintrc, etc.)
  })

  // Build a gitignore-spec filter from .gitignore + .debobignore
  let gitignoreFilter: ((relativePath: string) => boolean) | null = null
  if (respectGitignore) {
    const ig = ignore()
    const gitignoreContent = tryReadText(`${repoRoot}/.gitignore`)
    const debobignoreContent = tryReadText(`${repoRoot}/.debobignore`)
    if (gitignoreContent) ig.add(gitignoreContent)
    if (debobignoreContent) ig.add(debobignoreContent)
    // Only attach the filter if at least one ignore file contributed rules
    if (gitignoreContent || debobignoreContent) {
      gitignoreFilter = (rel: string) => ig.ignores(rel)
    }
  }

  const files: ScannedFile[] = []

  for (const absolutePath of absolutePaths) {
    try {
      const relativePath = relative(repoRoot, absolutePath).replace(/\\/g, '/')

      // Sub-Task A: respect .gitignore / .debobignore
      if (gitignoreFilter?.(relativePath)) continue

      const ext = extname(absolutePath).toLowerCase()

      // Sub-Task B: extension allowlist — skip known-binary / unrecognised formats
      if (!TEXT_EXTENSIONS.has(ext)) continue

      const stats = statSync(absolutePath)
      // Skip non-regular files (symlinks, etc.)
      if (!stats.isFile()) continue

      // Sub-Task B: size cap — skip files over 1 MB before readFileSync
      if (stats.size > MAX_FILE_BYTES) continue

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
