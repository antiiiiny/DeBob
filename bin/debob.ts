#!/usr/bin/env node
import { createRequire } from 'module'
import { Command } from 'commander'
import chalk from 'chalk'
import ora from 'ora'
import { runInit } from '../src/engine/index.js'
import { createLLMAdapter } from '../src/llm/index.js'
import type { LLMAdapter } from '../src/llm/adapter.js'

// ─── Package metadata ─────────────────────────────────────────────────────────

const _require = createRequire(import.meta.url)
const pkg = _require('../package.json') as { version: string; description: string }

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
        const endpoint = process.env['WATSONX_ENDPOINT']

        if (!apiKey || !projectId || !endpoint) {
          console.warn(
            chalk.yellow(
              '⚠  --semantic was set but WATSONX_API_KEY, WATSONX_PROJECT_ID, or WATSONX_ENDPOINT is missing — skipping LLM enrichment.',
            ),
          )
        } else {
          try {
            llm = createLLMAdapter('watsonx', { provider: 'watsonx', apiKey, projectId, endpoint })
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

// ─── review command (stub) ────────────────────────────────────────────────────

program
  .command('review')
  .description('Review a diff against the repository graph (coming soon)')
  .action(() => {
    console.log(chalk.yellow('debob review — coming soon'))
  })

// ─── Parse ────────────────────────────────────────────────────────────────────

program.parse()
