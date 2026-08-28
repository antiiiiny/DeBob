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
import { runInit } from '../src/engine/index.js'
import { createLLMAdapter } from '../src/llm/index.js'
import type { LLMAdapter } from '../src/llm/adapter.js'
import { startVisualiserServer } from '../src/visualiser/server.js'

// ─── Package metadata ─────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url)
const sourcePackagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const builtPackagePath = fileURLToPath(new URL('../../package.json', import.meta.url))
const pkg = _require(existsSync(sourcePackagePath) ? sourcePackagePath : builtPackagePath) as {
  version: string
  description: string
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
  .option('--verbose', 'Show detailed progress output')
  .action(async (opts: { repo: string; maxCommits: string; semantic?: boolean; verbose?: boolean }) => {
    try {
      const repoRoot = opts.repo
      const maxCommits = parseInt(opts.maxCommits, 10)
      const semantic = opts.semantic ?? false
      const verbose = opts.verbose ?? false

      // ─── Resolve LLM adapter (--semantic) ──────────────────────────────────

      let llm: LLMAdapter | undefined
      if (semantic) {
        const apiKey = process.env['WATSONX_API_KEY']
        const projectId = process.env['WATSONX_PROJECT_ID']
        const url = process.env['WATSONX_URL']
        const modelId = process.env['WATSONX_MODEL_ID']

        if (!apiKey || !projectId || !url || !modelId) {
          console.warn(
            chalk.yellow(
              '⚠  --semantic was set but WATSONX_API_KEY, WATSONX_PROJECT_ID, WATSONX_URL, or WATSONX_MODEL_ID is missing — skipping LLM enrichment.',
            ),
          )
        } else {
          try {
            llm = createLLMAdapter('watsonx', { provider: 'watsonx', apiKey, projectId, url, modelId })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.warn(chalk.yellow(`⚠  LLM adapter could not be created: ${msg} — skipping LLM enrichment.`))
          }
        }
      }

      // ─── Run engine ────────────────────────────────────────────────────────

      const spinner = ora('Initializing DeBob…').start()

      let result
      try {
        result = await runInit(repoRoot, {
          maxCommits,
          semantic: semantic && llm !== undefined,
          llm,
          verbose,
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

// ─── review command (stub) ──────────────────────────────────────────────────

program
  .command('review')
  .description('Review a diff against the repository graph (coming soon)')
  .action(() => {
    console.log(chalk.yellow('debob review — coming soon'))
  })

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse()
