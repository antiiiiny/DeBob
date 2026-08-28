import { createHash } from 'crypto'
import simpleGit from 'simple-git'
import type { GitCommit, GitFileStats, GitMetadata } from '../persistence/interface.js'

export type { GitCommit, GitFileStats, GitMetadata } from '../persistence/interface.js'

// ─── Options ──────────────────────────────────────────────────────────────────

export interface GitExtractOptions {
  /** Maximum number of commits to analyze. Default: 500. */
  maxCommits?: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

// ─── Extractor ───────────────────────────────────────────────────────────────

/**
 * Extract Git metadata from a repository.
 *
 * Returns:
 * - Recent commits (up to maxCommits) with author emails SHA-256 hashed
 * - Per-file stats: commit count, churn score, author count, last modified date
 * - HEAD commit hash for use in file_cache incremental update tracking
 *
 * Returns empty metadata gracefully if the directory is not a Git repository.
 *
 * Privacy: raw author emails are NEVER stored — only SHA-256 hex digests.
 */
export async function extractGitMetadata(
  repoRoot: string,
  options: GitExtractOptions = {},
): Promise<GitMetadata> {
  const maxCommits = options.maxCommits ?? 500
  const empty: GitMetadata = { commits: [], fileStats: [], headCommit: '' }

  const git = simpleGit(repoRoot)

  try {
    const isRepo = await git.checkIsRepo()
    if (!isRepo) return empty
  } catch {
    return empty
  }

  // ── HEAD commit ─────────────────────────────────────────────────────────
  let headCommit = ''
  try {
    headCommit = (await git.revparse(['HEAD'])).trim()
  } catch {
    // Empty repo / no commits yet
    return empty
  }

  // ── Fetch commit log ─────────────────────────────────────────────────────
  // Use porcelain log format to get both metadata and changed files
  let rawLog = ''
  try {
    rawLog = await git.raw([
      'log',
      `--max-count=${maxCommits}`,
      '--name-only',
      '--format=COMMIT_START%n%H%n%an%n%ae%n%aI%n%s',
      '--no-merges',
    ])
  } catch {
    return { commits: [], fileStats: [], headCommit }
  }

  // ── Parse log output ─────────────────────────────────────────────────────
  const commits: GitCommit[] = []

  const blocks = rawLog.split('COMMIT_START\n').filter(Boolean)

  for (const block of blocks) {
    const lines = block.split('\n')
    const hash = lines[0]?.trim() ?? ''
    const authorName = lines[1]?.trim() ?? ''
    const authorEmail = lines[2]?.trim() ?? ''
    const date = lines[3]?.trim() ?? ''
    const subject = lines[4]?.trim() ?? ''

    if (!hash) continue

    // Files start after a blank line following the subject line
    const filesChanged: string[] = []
    let inFiles = false
    for (let i = 5; i < lines.length; i++) {
      const line = lines[i]?.trim() ?? ''
      if (line === '') {
        inFiles = true
        continue
      }
      if (inFiles && line) {
        filesChanged.push(line)
      }
    }

    commits.push({
      hash,
      authorName,
      authorEmailHash: hashEmail(authorEmail),
      date,
      subject,
      filesChanged,
    })
  }

  // ── Aggregate per-file stats ─────────────────────────────────────────────
  const fileMap = new Map<
    string,
    { commitCount: number; authorHashes: Set<string>; lastModifiedAt: string }
  >()

  for (const commit of commits) {
    for (const filePath of commit.filesChanged) {
      if (!filePath) continue
      const normalized = filePath.replace(/\\/g, '/')
      const existing = fileMap.get(normalized)
      if (existing) {
        existing.commitCount++
        existing.authorHashes.add(commit.authorEmailHash)
        // Keep the most recent date (commits are in reverse-chronological order,
        // so the first time we see a file is its most recent modification)
      } else {
        fileMap.set(normalized, {
          commitCount: 1,
          authorHashes: new Set([commit.authorEmailHash]),
          lastModifiedAt: commit.date,
        })
      }
    }
  }

  const fileStats: GitFileStats[] = Array.from(fileMap.entries()).map(([filePath, stats]) => ({
    filePath,
    commitCount: stats.commitCount,
    churnScore: stats.commitCount, // churnScore = raw commit count in V1
    authorCount: stats.authorHashes.size,
    lastModifiedAt: stats.lastModifiedAt,
  }))

  return { commits, fileStats, headCommit }
}
