import Parser from 'web-tree-sitter'
import { createRequire } from 'module'
import { dirname, relative, extname, resolve } from 'path'
import { existsSync } from 'fs'
import type { LanguageAnalyzer, AnalysisResult } from '../interface.js'
import type { Node, Edge, ArchitecturalLayer } from '../../graph/types.js'

// In web-tree-sitter@0.22.x the SyntaxNode type lives under Parser.SyntaxNode
type SyntaxNode = Parser.SyntaxNode

const _require = createRequire(import.meta.url)

// ─── WASM Paths ───────────────────────────────────────────────────────────────

function wasmDir(pkg: string): string {
  return dirname(_require.resolve(`${pkg}/package.json`)).replace(/\\/g, '/')
}

function resolveWasmPath(filename: string): string {
  if (filename === 'tree-sitter.wasm') {
    return `${wasmDir('web-tree-sitter')}/${filename}`
  }
  return `${wasmDir('tree-sitter-wasms')}/out/${filename}`
}

// ─── Layer Detection ──────────────────────────────────────────────────────────

const LAYER_PATTERNS: Array<{ pattern: RegExp; layer: ArchitecturalLayer }> = [
  { pattern: /[/\\](tests?|spec|__tests?__|e2e)[/\\]/i, layer: 'test' },
  { pattern: /\.(test|spec)\.[tj]sx?$/, layer: 'test' },
  { pattern: /[/\\](routes?|controllers?|handlers?|pages?|views?)[/\\]/i, layer: 'presentation' },
  { pattern: /[/\\](services?|usecases?|use-cases?|domain)[/\\]/i, layer: 'business' },
  { pattern: /[/\\](models?|entities|schema|schemas|migrations?|repositories?|repos?)[/\\]/i, layer: 'data' },
  { pattern: /[/\\](config|configs?|settings?)[/\\]/i, layer: 'config' },
  { pattern: /[/\\](middleware|middlewares?|guards?|interceptors?|infra|infrastructure)[/\\]/i, layer: 'infra' },
]

function inferLayer(filePath: string): ArchitecturalLayer | undefined {
  for (const { pattern, layer } of LAYER_PATTERNS) {
    if (pattern.test(filePath)) return layer
  }
  return undefined
}

// ─── Module Resolution ────────────────────────────────────────────────────────

/**
 * ESM-TS convention: source files import relative specifiers with the *compiled* extension
 * (`import './foo.js'`) even though the file on disk is `./foo.ts` — that's what this very
 * codebase does throughout (`import { X } from '../scanner/index.js'`). Map each compiled
 * extension to the source extensions it could actually resolve to, in probe order.
 */
const COMPILED_TO_SOURCE_EXT: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}

function resolveImportTarget(
  specifier: string,
  importingFilePath: string,
  repoRoot: string,
): { id: string; isPackage: boolean } {
  if (specifier.startsWith('.')) {
    const importingDir = dirname(resolve(repoRoot, importingFilePath))
    const resolved = resolve(importingDir, specifier)
    let rel = relative(repoRoot, resolved).replace(/\\/g, '/')
    rel = rel.split('?')[0]!.split('#')[0]!
    const ext = extname(rel)

    // `./foo.js` style specifier: prefer a literal .js file if one really exists (plain-JS
    // projects), otherwise remap to the .ts/.tsx source that actually produced it — without
    // this, every relative import in an ESM-TS codebase resolves to a disconnected phantom
    // stub node instead of the real, already-analyzed file node.
    if (ext && COMPILED_TO_SOURCE_EXT[ext]) {
      if (existsSync(resolve(repoRoot, rel))) return { id: rel, isPackage: false }
      const base = rel.slice(0, -ext.length)
      for (const sourceExt of COMPILED_TO_SOURCE_EXT[ext]) {
        if (existsSync(resolve(repoRoot, base + sourceExt))) {
          return { id: base + sourceExt, isPackage: false }
        }
      }
    }

    if (!ext) {
      for (const probeExt of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.js']) {
        if (existsSync(resolve(repoRoot, rel + probeExt))) {
          return { id: rel + probeExt, isPackage: false }
        }
      }
    }
    return { id: rel, isPackage: false }
  }
  const pkgName = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]!
  return { id: `pkg::${pkgName}`, isPackage: true }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkEdgeId(source: string, type: string, target: string): string {
  return `${source}::${type}::${target}`
}

function symbolNodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`
}

function childText(node: SyntaxNode, fieldName: string): string | null {
  return node.childForFieldName(fieldName)?.text ?? null
}

function walkTree(node: SyntaxNode, visitor: (n: SyntaxNode) => boolean | void): void {
  if (visitor(node) === false) return
  for (const child of node.children) {
    walkTree(child, visitor)
  }
}

// ─── TypeScript Analyzer ─────────────────────────────────────────────────────

/**
 * V1 LanguageAnalyzer for TypeScript and JavaScript.
 *
 * Uses web-tree-sitter@0.22.x (WASM) with tree-sitter-wasms grammars.
 * No native compilation required.
 *
 * Initialization is async (loads WASM once); subsequent analyze() calls are synchronous.
 *
 * Extracts per file:
 *   - One `file` node
 *   - `function` nodes (function_declaration)
 *   - `class` nodes (class_declaration) + extends/implements edges
 *   - `interface` nodes (interface_declaration) + extends edges
 *   - `imports` edges to resolved repo-relative paths or pkg:: nodes
 *   - `exports` edges for re-export statements
 *
 * Use the static factory: await TypeScriptAnalyzer.create(repoRoot)
 */
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly language = 'typescript'
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
  readonly version = 'ts-1.0'

  private readonly tsParser: Parser
  private readonly tsxParser: Parser
  private readonly repoRoot: string

  private constructor(tsParser: Parser, tsxParser: Parser, repoRoot: string) {
    this.tsParser = tsParser
    this.tsxParser = tsxParser
    this.repoRoot = repoRoot
  }

  /**
   * Async factory — initializes WASM once per process.
   * Pass repository root so relative import paths are resolved correctly.
   */
  static async create(repoRoot: string): Promise<TypeScriptAnalyzer> {
    await Parser.init({
      locateFile: () => resolveWasmPath('tree-sitter.wasm'),
    })

    const tsLang = await Parser.Language.load(resolveWasmPath('tree-sitter-typescript.wasm'))
    const tsxLang = await Parser.Language.load(resolveWasmPath('tree-sitter-tsx.wasm'))

    const tsParser = new Parser()
    tsParser.setLanguage(tsLang)

    const tsxParser = new Parser()
    tsxParser.setLanguage(tsxLang)

    return new TypeScriptAnalyzer(tsParser, tsxParser, repoRoot)
  }

  // ── Public API ────────────────────────────────────────────────────────────

  analyze(filePath: string, source: string): AnalysisResult {
    const isTsx = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
    const parser = isTsx ? this.tsxParser : this.tsParser
    const tree = parser.parse(source)

    const nodes: Node[] = []
    const edgesMap = new Map<string, Edge>()
    const packageNodes = new Map<string, Node>()
    const layer = inferLayer(filePath)

    // ── File node (always emitted) ────────────────────────────────────────
    nodes.push({
      id: filePath,
      type: 'file',
      name: filePath.split('/').pop() ?? filePath,
      filePath,
      confidence: 1.0,
      dataSource: 'static',
      layer,
    })

    const ensurePackageNode = (pkgId: string): void => {
      if (!packageNodes.has(pkgId)) {
        packageNodes.set(pkgId, {
          id: pkgId,
          type: 'package',
          name: pkgId.replace('pkg::', ''),
          filePath: pkgId,
          confidence: 1.0,
          dataSource: 'static',
        })
      }
    }

    const addEdge = (e: Edge): void => {
      if (!edgesMap.has(e.id)) edgesMap.set(e.id, e)
    }

    // ── Walk AST ──────────────────────────────────────────────────────────
    walkTree(tree.rootNode, (node) => {
      switch (node.type) {

        // ── import_statement ────────────────────────────────────────────
        // tree-sitter-typescript uses 'import_statement' (not import_declaration)
        case 'import_statement': {
          const sourceNode = node.children.find(c => c.type === 'string')
          if (!sourceNode) break
          const raw = sourceNode.text.replace(/^['"]|['"]$/g, '')
          const { id: targetId, isPackage } = resolveImportTarget(raw, filePath, this.repoRoot)
          if (isPackage) ensurePackageNode(targetId)
          addEdge({
            id: mkEdgeId(filePath, 'imports', targetId),
            source: filePath,
            target: targetId,
            type: 'imports',
            confidence: 1.0,
            dataSource: 'static',
          })
          break
        }

        // ── export_statement (re-exports: export { x } from '...') ──────
        case 'export_statement': {
          const fromString = node.children.find(c => c.type === 'string')
          if (fromString) {
            const raw = fromString.text.replace(/^['"]|['"]$/g, '')
            const { id: targetId, isPackage } = resolveImportTarget(raw, filePath, this.repoRoot)
            if (isPackage) ensurePackageNode(targetId)
            addEdge({
              id: mkEdgeId(filePath, 'exports', targetId),
              source: filePath,
              target: targetId,
              type: 'exports',
              confidence: 1.0,
              dataSource: 'static',
            })
          }
          break
        }

        // ── function_declaration ────────────────────────────────────────
        case 'function_declaration': {
          const name = childText(node, 'name')
          if (!name) break
          nodes.push({
            id: symbolNodeId(filePath, name),
            type: 'function',
            name,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
            layer,
          })
          break
        }

        // ── class_declaration ───────────────────────────────────────────
        case 'class_declaration': {
          const name = childText(node, 'name')
          if (!name) break
          const nodeId = symbolNodeId(filePath, name)
          nodes.push({
            id: nodeId,
            type: 'class',
            name,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
            layer,
          })
          // Heritage clauses: class_heritage contains extends_clause + implements_clause
          for (const child of node.children) {
            if (child.type === 'class_heritage') {
              for (const clause of child.children) {
                if (clause.type === 'extends_clause') {
                  const base = clause.children.find(
                    c => c.type !== 'extends' && c.isNamed,
                  )?.text
                  if (base) {
                    addEdge({
                      id: mkEdgeId(nodeId, 'extends', base),
                      source: nodeId,
                      target: base,
                      type: 'extends',
                      confidence: 1.0,
                      dataSource: 'static',
                    })
                  }
                }
                if (clause.type === 'implements_clause') {
                  for (const typeNode of clause.children) {
                    if (typeNode.type === 'implements' || typeNode.type === ',') continue
                    if (typeNode.isNamed) {
                      addEdge({
                        id: mkEdgeId(nodeId, 'implements', typeNode.text),
                        source: nodeId,
                        target: typeNode.text,
                        type: 'implements',
                        confidence: 1.0,
                        dataSource: 'static',
                      })
                    }
                  }
                }
              }
            }
          }
          return true
        }

        // ── interface_declaration ───────────────────────────────────────
        case 'interface_declaration': {
          const name = childText(node, 'name')
          if (!name) break
          const nodeId = symbolNodeId(filePath, name)
          nodes.push({
            id: nodeId,
            type: 'interface',
            name,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
            layer,
          })
          // extends_type_clause: interface Foo extends Bar, Baz
          for (const child of node.children) {
            if (child.type === 'extends_type_clause') {
              for (const typeNode of child.children) {
                if (typeNode.type === 'extends' || typeNode.type === ',') continue
                if (typeNode.isNamed) {
                  addEdge({
                    id: mkEdgeId(nodeId, 'extends', typeNode.text),
                    source: nodeId,
                    target: typeNode.text,
                    type: 'extends',
                    confidence: 1.0,
                    dataSource: 'static',
                  })
                }
              }
            }
          }
          break
        }
      }
      return true
    })

    return {
      nodes: [...nodes, ...packageNodes.values()],
      edges: [...edgesMap.values()],
    }
  }
}
