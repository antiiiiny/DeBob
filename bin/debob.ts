import { createRequire } from 'module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { Command } from 'commander'

// ─── Load .env (if present) ───────────────────────────────────────────────────
// Node >=20.6 supports --env-file but we target >=18. Parse manually so that
// `npx debob` picks up credentials without requiring the user to export vars.

try {
  const envPath = join(process.cwd(), '.env')
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (key && !(key in process.env)) {
        process.env[key] = val
      }
    }
  }
} catch {
  // silently ignore — .env is optional
}
import chalk from 'chalk'
import ora from 'ora'
import open from 'open'
import { runInit, runUpdate } from '../src/engine/index.js'
import { runReview } from '../src/engine/review.js'
import { runExplain } from '../src/engine/explain.js'
import { runEnrichExport, runEnrichImport } from '../src/engine/enrich.js'
import { createLLMAdapter } from '../src/llm/index.js'
import type { LLMAdapter, TokenUsage } from '../src/llm/adapter.js'
import { startVisualiserServer } from '../src/visualiser/server.js'

// ─── Package metadata ─────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url)
const sourcePackagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const builtPackagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
const pkg = _require(existsSync(sourcePackagePath) ? sourcePackagePath : builtPackagePath) as {
  version: string
  description: string
}

// ─── LLM credential resolution ─────────────────────────────────────────────────
//
// Shared by every command that can call watsonx. 'warn' mode (init/update --semantic) treats
// missing/broken credentials as non-fatal — the command continues without LLM enrichment.
// 'error' mode (review/explain) treats the LLM as mandatory and exits the process.

/** Rough chars-per-token ratio used only for the not-sent counterfactual. */
const CHARS_PER_TOKEN = 4

/**
 * Render provider-reported token spend beside the counterfactual: what sending the raw
 * source would have cost. This is the evidence for DeBob's central claim, so the two halves
 * are labelled differently on purpose — the sent side is exact, the not-sent side is an
 * estimate and is always marked `~` with its assumption stated.
 *
 * Prints nothing when the provider reported no usage; "not measured" must never render as 0.
 */
function printTokenUsage(usage: TokenUsage | undefined, sourceBytes: number): void {
  if (!usage) return

  const n = (value: number): string => value.toLocaleString('en-US')
  console.log(chalk.bold('  Token usage:'))
  console.log(`    Prompt        : ${chalk.bold(n(usage.promptTokens))}  ${chalk.gray('graph slices actually sent')}`)
  console.log(`    Completion    : ${chalk.bold(n(usage.completionTokens))}  ${chalk.gray('includes hidden reasoning tokens')}`)
  const callLabel = usage.callCount === 1 ? '1 call' : `${n(usage.callCount)} calls`
  console.log(`    Total         : ${chalk.bold(n(usage.totalTokens))}  ${chalk.gray(`across ${callLabel}`)}`)

  if (sourceBytes > 0 && usage.promptTokens > 0) {
    const estimated = Math.round(sourceBytes / CHARS_PER_TOKEN)
    const megabytes = (sourceBytes / (1024 * 1024)).toFixed(2)
    const ratio = estimated / usage.promptTokens
    console.log(
      `    Raw source    : ${chalk.dim('~' + n(estimated))}  ${chalk.gray(`est. from ${megabytes} MB scanned at ~${CHARS_PER_TOKEN} chars/token`)}`,
    )
    console.log(
      `    ${chalk.green('Reduction')}     : ${chalk.green.bold('~' + ratio.toFixed(1) + '×')}  ${chalk.gray('vs. sending the source itself')}`,
    )
  }
  console.log()
}

/** Clamped so a stray `--concurrency 500` can't turn a run into a rate-limit storm. */
function parseEnrichConcurrency(raw: string): number {
  const parsed = parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1) return 6
  return Math.min(parsed, 24)
}

function resolveLLMAdapter(mode: 'warn'): LLMAdapter | undefined
function resolveLLMAdapter(mode: 'error'): LLMAdapter
function resolveLLMAdapter(mode: 'warn' | 'error'): LLMAdapter | undefined {
  const apiKey = process.env['WATSONX_API_KEY']
  const projectId = process.env['WATSONX_PROJECT_ID']
  const url = process.env['WATSONX_URL']
  const modelId = process.env['WATSONX_MODEL_ID']

  if (!apiKey || !projectId || !url || !modelId) {
    const missing = 'WATSONX_API_KEY, WATSONX_PROJECT_ID, WATSONX_URL, and WATSONX_MODEL_ID'
    if (mode === 'error') {
      console.error(
        chalk.red(`\n✖  This command requires ${missing}.\n   Set them in a .env file at the repository root.`),
      )
      process.exit(1)
    }
    console.warn(chalk.yellow(`⚠  --semantic was set but ${missing} is missing — skipping LLM enrichment.`))
    return undefined
  }

  try {
    return createLLMAdapter('watsonx', { provider: 'watsonx', apiKey, projectId, url, modelId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (mode === 'error') {
      console.error(chalk.red(`\n✖  LLM adapter could not be created: ${msg}`))
      process.exit(1)
    }
    console.warn(chalk.yellow(`⚠  LLM adapter could not be created: ${msg} — skipping LLM enrichment.`))
    return undefined
  }
}

// ─── Program ──────────────────────────────────────────────────────────────────

const program = new Command()

program
  .name('debob')
  .version(pkg.version)
  .description(pkg.description)

// ─── init command ─────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scan a repository and build the persistent knowledge graph')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--max-commits <n>', 'Maximum number of Git commits to analyze', '500')
  .option('--semantic', 'Run LLM semantic enrichment after structural extraction')
  .option('--concurrency <n>', 'Enrichment calls to keep in flight', '6')
  .option('--verbose', 'Show detailed progress output')
  .action(async (opts: { repo: string; maxCommits: string; semantic?: boolean; concurrency: string; verbose?: boolean }) => {
    try {
      const repoRoot = opts.repo
      const maxCommits = parseInt(opts.maxCommits, 10)
      const semantic = opts.semantic ?? false
      const verbose = opts.verbose ?? false

      // ─── Resolve LLM adapter (--semantic) ──────────────────────────────────

      const llm: LLMAdapter | undefined = semantic ? resolveLLMAdapter('warn') : undefined

      // ─── Run engine ────────────────────────────────────────────────────────

      const spinner = ora('Initializing DeBob…').start()

      let result
      try {
        result = await runInit(repoRoot, {
          maxCommits,
          semantic: semantic && llm !== undefined,
          llm,
          verbose,
          enrichConcurrency: parseEnrichConcurrency(opts.concurrency),
        })
        spinner.succeed(chalk.green('Repository analysis complete'))
      } catch (err) {
        spinner.fail(chalk.red('Analysis failed'))
        throw err
      }

      // ─── Render summary ────────────────────────────────────────────────────

      console.log()
      console.log(chalk.bold('─── DeBob Init Summary ──────────────────────────────────'))
      console.log()

      // Core counts
      console.log(chalk.cyan('  Files scanned :'), result.fileCount)
      console.log(chalk.cyan('  Nodes         :'), result.nodeCount)
      console.log(chalk.cyan('  Edges         :'), result.edgeCount)
      console.log(chalk.cyan('  Git commits   :'), result.commitCount)
      console.log()

      // Layer distribution
      if (Object.keys(result.layerDistribution).length > 0) {
        console.log(chalk.bold('  Layer distribution:'))
        const sortedLayers = Object.entries(result.layerDistribution).sort((a, b) => b[1] - a[1])
        for (const [layer, count] of sortedLayers) {
          console.log(`    ${chalk.magenta(layer.padEnd(20))} ${count}`)
        }
        console.log()
      }

      // Hot files (top churn)
      if (result.hotFiles.length > 0) {
        console.log(chalk.bold('  🔥 Hot files (top churn):'))
        const top5 = result.hotFiles.slice(0, 5)
        for (const node of top5) {
          const churn = node.metadata?.['churnScore'] != null
            ? chalk.gray(` (churn: ${(node.metadata['churnScore'] as number).toFixed(2)})`)
            : ''
          console.log(`    ${chalk.yellow(node.id)}${churn}`)
        }
        console.log()
      }

      // External package dependencies
      if (result.packageDependencies.length > 0) {
        const pkgNames = result.packageDependencies.map(id => id.replace(/^pkg::/, ''))
        console.log(chalk.bold(`  External packages (${pkgNames.length}):`))
        const display = pkgNames.slice(0, 10)
        console.log(`    ${display.map(p => chalk.blue(p)).join(', ')}${pkgNames.length > 10 ? chalk.gray(` … +${pkgNames.length - 10} more`) : ''}`)
        console.log()
      }

      printTokenUsage(result.tokenUsage, result.sourceBytes)

      // DB path
      console.log(chalk.cyan('  Database      :'), chalk.underline(result.dbPath))
      console.log()
      console.log(chalk.bold('─────────────────────────────────────────────────────────'))
      console.log()

      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`\n✖  ${msg}`))
      process.exit(1)
    }
  })

// ─── enrich command ────────────────────────────────────────────────────────

program
  .command('enrich')
  .description('Semantic enrichment without an API key: export module context for a coding agent to describe, then import its answers')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--export <file>', 'Write module contexts to <file> for an agent to fill in')
  .option('--import <file>', 'Read agent-written answers from <file> into the graph')
  .option('--all', 'Export every module, not just those with no responsibility yet')
  .option('--model <name>', 'Recorded as the enrichment modelId', 'claude-code')
  .action(async (opts: { repo: string; export?: string; import?: string; all?: boolean; model: string }) => {
    if (!opts.export && !opts.import) {
      console.error(chalk.red('\n✖  Specify --export <file> or --import <file>.'))
      console.log(chalk.dim('   debob enrich --export .debob/enrichment.json'))
      console.log(chalk.dim('   …fill it in with your coding agent, then:'))
      console.log(chalk.dim('   debob enrich --import .debob/enrichment.json'))
      process.exit(1)
    }
    if (opts.export && opts.import) {
      console.error(chalk.red('\n✖  Use --export or --import, not both at once.'))
      process.exit(1)
    }

    if (opts.export) {
      const spinner = ora('Building module contexts...').start()
      try {
        const result = await runEnrichExport(opts.repo, {
          outFile: opts.export,
          onlyMissing: !opts.all,
        })
        spinner.succeed(chalk.green('Enrichment tasks exported'))
        console.log()
        console.log('  Tasks written  : ' + chalk.bold(String(result.taskCount)))
        if (result.skippedAlreadyEnriched > 0) {
          console.log('  Already done   : ' + chalk.dim(String(result.skippedAlreadyEnriched) + ' (use --all to redo)'))
        }
        console.log('  File           : ' + chalk.cyan(result.outFile))
        if (result.taskCount === 0) {
          console.log()
          console.log(chalk.dim('  Everything is already enriched. Nothing to do.'))
          return
        }
        console.log()
        console.log(chalk.bold('  Next:'))
        console.log(chalk.dim('   1. Ask your coding agent: "enrich the debob graph" (it will find .bob/skills/debob-enrich)'))
        console.log(chalk.dim('      or hand it ' + result.outFile + ' and follow the "instructions" field inside.'))
        console.log(chalk.dim('   2. debob enrich --import ' + result.outFile))
      } catch (err) {
        spinner.fail(chalk.red('Export failed'))
        console.error(chalk.red('\n✖  ' + (err instanceof Error ? err.message : String(err))))
        process.exit(1)
      }
      return
    }

    const spinner = ora('Importing enrichment answers...').start()
    try {
      const result = await runEnrichImport(opts.repo, {
        inFile: opts.import!,
        model: opts.model,
      })
      spinner.succeed(chalk.green('Enrichment imported'))
      console.log()
      console.log('  Responsibilities : ' + chalk.bold(String(result.responsibilitiesWritten)))
      console.log('  Layers           : ' + chalk.bold(String(result.layersWritten)))
      console.log('  Symbols inherited: ' + chalk.bold(String(result.symbolsInheritedLayer)))
      if (result.skipped.length > 0) {
        console.log()
        console.log(chalk.yellow('  Skipped (' + result.skipped.length + '):'))
        for (const item of result.skipped.slice(0, 10)) {
          console.log(chalk.yellow('    ' + item.nodeId + ' — ' + item.reason))
        }
        if (result.skipped.length > 10) {
          console.log(chalk.dim('    … +' + (result.skipped.length - 10) + ' more'))
        }
      }
      console.log()
      console.log(chalk.dim('  Run `debob visualise` to see the summaries in the Node Inspector.'))
    } catch (err) {
      spinner.fail(chalk.red('Import failed'))
      console.error(chalk.red('\n✖  ' + (err instanceof Error ? err.message : String(err))))
      process.exit(1)
    }
  })

// ─── visualise command ─────────────────────────────────────────────────────

program
  .command('visualise')
  .alias('viz')
  .description('Open an interactive visualisation of the persisted repository graph')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--port <n>', 'Port to listen on', '7842')
  .action(async (opts: { repo: string; port: string }) => {
    const port = parseInt(opts.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(chalk.red('\n✖  Port must be an integer between 1 and 65535.'))
      process.exit(1)
    }

    const spinner = ora('Reading graph from .debob/context.db...').start()

    try {
      const { url, close } = await startVisualiserServer(opts.repo, { port })
      spinner.succeed(chalk.green('Graph visualiser ready'))
      console.log(chalk.green('Graph visualiser running at ' + url))
      console.log(chalk.dim('Press Ctrl+C to stop.'))

      void open(url).catch(() => {
        console.warn(chalk.yellow('Could not open the browser automatically. Open the URL above manually.'))
      })

      let stopping = false
      const stop = () => {
        if (stopping) return
        stopping = true
        close()
        console.log(chalk.dim('Server stopped.'))
        process.exit(0)
      }

      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    } catch (err) {
      spinner.fail(chalk.red('Could not start graph visualiser'))
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red('\n✖  ' + msg))
      process.exit(1)
    }
  })

// ─── update command ────────────────────────────────────────────────────────

program
  .command('update')
  .description('Incrementally re-analyze changed files and update the knowledge graph')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--semantic', 'Run LLM semantic enrichment on re-analyzed files')
  .option('--concurrency <n>', 'Enrichment calls to keep in flight', '6')
  .option('--verbose', 'Show detailed progress output')
  .action(async (opts: { repo: string; semantic?: boolean; concurrency: string; verbose?: boolean }) => {
    try {
      const repoRoot = opts.repo
      const semantic = opts.semantic ?? false
      const verbose = opts.verbose ?? false

      // ─── Resolve LLM adapter (--semantic) ──────────────────────────────────

      const llm: LLMAdapter | undefined = semantic ? resolveLLMAdapter('warn') : undefined

      // ─── Run engine ────────────────────────────────────────────────────────

      const spinner = ora('Updating DeBob graph…').start()

      let result
      try {
        result = await runUpdate(repoRoot, {
          semantic: semantic && llm !== undefined,
          llm,
          verbose,
          enrichConcurrency: parseEnrichConcurrency(opts.concurrency),
        })
        spinner.succeed(chalk.green('Incremental update complete'))
      } catch (err) {
        spinner.fail(chalk.red('Update failed'))
        throw err
      }

      // ─── Render summary ────────────────────────────────────────────────────

      console.log()
      console.log(chalk.bold('─── DeBob Update Summary ─────────────────────────────────'))
      console.log()
      console.log(chalk.cyan('  Files re-analyzed :'), result.reanalyzedFiles.length)
      console.log(chalk.cyan('  Files skipped     :'), result.skippedFiles.length)
      console.log(chalk.cyan('  Nodes added       :'), result.addedNodes)
      console.log(chalk.cyan('  Nodes removed     :'), result.removedNodes)
      console.log(chalk.cyan('  Nodes updated     :'), result.updatedNodes)
      console.log(chalk.cyan('  Edges added       :'), result.addedEdges)
      console.log(chalk.cyan('  Edges removed     :'), result.removedEdges)
      if (result.reanalyzedFiles.length > 0 && verbose) {
        console.log()
        console.log(chalk.bold('  Re-analyzed files:'))
        for (const f of result.reanalyzedFiles.slice(0, 10)) {
          console.log(`    ${chalk.yellow(f)}`)
        }
        if (result.reanalyzedFiles.length > 10) {
          console.log(chalk.gray(`    … +${result.reanalyzedFiles.length - 10} more`))
        }
      }
      console.log()
      printTokenUsage(result.tokenUsage, result.sourceBytes)

      console.log(chalk.cyan('  Database :'), chalk.underline(result.dbPath))
      console.log()
      console.log(chalk.bold('─────────────────────────────────────────────────────────'))
      console.log()

      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`\n✖  ${msg}`))
      process.exit(1)
    }
  })

// ─── review command ────────────────────────────────────────────────────────────

program
  .command('review')
  .description('Explain the impact of a git diff against the repository graph')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--base <ref>', 'Git ref to diff against (default: uncommitted changes vs HEAD)')
  .option('--verbose', 'Show detailed progress output')
  .action(async (opts: { repo: string; base?: string; verbose?: boolean }) => {
    try {
      const repoRoot = opts.repo
      const verbose = opts.verbose ?? false

      // ─── Resolve LLM adapter (required for review) ─────────────────────────

      const llm = resolveLLMAdapter('error')

      // ─── Run review ────────────────────────────────────────────────────────

      const spinner = ora('Analyzing diff against repository graph…').start()

      let result
      try {
        result = await runReview(repoRoot, { base: opts.base, verbose, llm })
        spinner.succeed(chalk.green('Review complete'))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === 'No diff found. Nothing to review.') {
          spinner.stop()
        } else {
          spinner.fail(chalk.red('Review failed'))
        }
        throw err
      }

      // ─── Render output ─────────────────────────────────────────────────────

      console.log()
      console.log(chalk.bold('─── DeBob Review ─────────────────────────────────────────'))
      console.log()
      console.log(chalk.cyan('  Affected files    :'), result.affectedFiles.length)
      for (const f of result.affectedFiles) {
        console.log(`    ${chalk.yellow(f)}`)
      }
      console.log()
      console.log(chalk.cyan('  Layers touched    :'), result.affectedLayers.join(', ') || 'none')
      console.log(chalk.cyan('  Neighbourhood     :'), result.neighbourhoodSize, 'nodes')
      if (result.notes.length > 0) {
        console.log()
        for (const note of result.notes) {
          console.log(chalk.yellow('  ⚠  ' + note))
        }
      }
      console.log()
      console.log(chalk.bold('  Impact analysis:'))
      console.log()
      for (const line of result.explanation.split('\n')) {
        console.log('  ' + line)
      }
      console.log()
      // No counterfactual here — review deliberately sends the raw diff, so a
      // "vs. sending the source" ratio would be comparing unlike things.
      printTokenUsage(result.tokenUsage, 0)
      console.log(chalk.bold('─────────────────────────────────────────────────────────'))
      console.log()

      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg === 'No diff found. Nothing to review.') {
        console.log(chalk.dim(`\n  ${msg}`))
        process.exit(1)
      }
      console.error(chalk.red(`\n✖  ${msg}`))
      process.exit(1)
    }
  })

// ─── explain command ────────────────────────────────────────────────────────

program
  .command('explain <question>')
  .description('Answer a free-form question about the repository using the graph (quote multi-word questions)')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--verbose', 'Show detailed progress output')
  .action(async (question: string, opts: { repo: string; verbose?: boolean }) => {
    try {
      const repoRoot = opts.repo
      const verbose = opts.verbose ?? false

      // ─── Resolve LLM adapter (required for explain) ────────────────────────

      const llm = resolveLLMAdapter('error')

      // ─── Run explain ───────────────────────────────────────────────────────

      const spinner = ora('Querying repository graph…').start()

      let result
      try {
        result = await runExplain(repoRoot, { question, verbose, llm })
        spinner.succeed(chalk.green('Answer ready'))
      } catch (err) {
        spinner.fail(chalk.red('Explain failed'))
        throw err
      }

      // ─── Render output ─────────────────────────────────────────────────────

      console.log()
      console.log(chalk.bold('─── DeBob Explain ────────────────────────────────────────'))
      console.log()
      console.log(chalk.cyan('  Question :'), result.question)
      console.log(
        chalk.cyan('  Grounded in :'),
        result.relevantFiles.length > 0 ? result.relevantFiles.join(', ') : '(nothing relevant found)',
      )
      console.log()
      for (const line of result.answer.split('\n')) {
        console.log('  ' + line)
      }
      console.log()
      printTokenUsage(result.tokenUsage, 0)
      console.log(chalk.bold('─────────────────────────────────────────────────────────'))
      console.log()

      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`\n✖  ${msg}`))
      process.exit(1)
    }
  })

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse()
