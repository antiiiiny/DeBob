import { Command } from 'commander'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string; description: string }

const program = new Command()

program
  .name('debob')
  .version(pkg.version)
  .description(pkg.description)

program
  .command('init')
  .description('Scan a repository and build the persistent knowledge graph')
  .option('--repo <path>', 'Path to the repository root', process.cwd())
  .option('--max-commits <n>', 'Maximum number of Git commits to analyze', '500')
  .option('--semantic', 'Run LLM semantic enrichment after structural extraction')
  .option('--verbose', 'Show detailed progress output')
  .action(async () => {
    console.log('debob init — not yet implemented (scaffold placeholder)')
  })

program
  .command('review')
  .description('Review a diff against the repository graph (coming soon)')
  .action(() => {
    console.log('debob review — coming soon')
  })

program.parse()
