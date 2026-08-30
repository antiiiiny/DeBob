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

// Directory-segment patterns first, then filename patterns. Directory-only matching left
// most of a src/-organised codebase unclassified (debob's own src/llm, src/graph, src/engine
// matched nothing at all), so the filename rules below carry the common single-file cases.
const LAYER_PATTERNS: Array<{ pattern: RegExp; layer: ArchitecturalLayer }> = [
  { pattern: /[/\\](tests?|spec|__tests?__|e2e)[/\\]/i, layer: 'test' },
  { pattern: /\.(test|spec)\.[tj]sx?$/, layer: 'test' },
  { pattern: /[/\\](routes?|controllers?|handlers?|pages?|views?|components?|ui)[/\\]/i, layer: 'presentation' },
  { pattern: /[/\\](services?|usecases?|use-cases?|domain|engine|core)[/\\]/i, layer: 'business' },
  { pattern: /[/\\](models?|entities|schema|schemas|migrations?|repositories?|repos?|persistence|store|db)[/\\]/i, layer: 'data' },
  { pattern: /[/\\](config|configs?|settings?)[/\\]/i, layer: 'config' },
  { pattern: /[/\\](middleware|middlewares?|guards?|interceptors?|infra|infrastructure)[/\\]/i, layer: 'infra' },
  // Filename-level fallbacks
  { pattern: /\.(config|rc)\.[tj]sx?$/i, layer: 'config' },
  { pattern: /(^|[/\\])(tsconfig|tsup\.config|vite\.config|vitest\.config|webpack\.config)\b/i, layer: 'config' },
  { pattern: /\.(schema|model|entity|dto)\.[tj]sx?$/i, layer: 'data' },
  { pattern: /\.(route|controller|handler|page|view|component)\.[tj]sx?$/i, layer: 'presentation' },
  { pattern: /\.(service|usecase)\.[tj]sx?$/i, layer: 'business' },
  { pattern: /(^|[/\\])(bin|cli)[/\\]/i, layer: 'presentation' },
  { pattern: /\.tsx$/, layer: 'presentation' },
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

    // Probe when the specifier has no extension — and also when it has one we don't
    // recognise as a compiled extension. `./fetch-poems.api` makes extname() return
    // '.api', which is really part of the filename (`fetch-poems.api.ts`), a common
    // convention in Next.js/modern TS codebases (`*.api.ts`, `*.config.ts`, `*.types.ts`).
    // Treating that as a real extension skipped the probe entirely and produced a phantom
    // stub node per import — 13 of them on the nextjs-monorepo-example test repo.
    if (!ext || !COMPILED_TO_SOURCE_EXT[ext]) {
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

// ─── Doc Comments ─────────────────────────────────────────────────────────────

/**
 * Caps on extracted documentation. These bound what enrichment sends to the model:
 * comments are ~28% of this codebase by volume, so uncapped extraction would undo the
 * token efficiency the graph exists to provide. Sized so a typical JSDoc summary plus a
 * short step list survives, while an essay gets trimmed.
 */
const FILE_DOC_CAP = 500
const SYMBOL_DOC_CAP = 300
/** Total across all symbol docs in one file, so a heavily-documented module can't dominate. */
const MODULE_DOC_BUDGET = 2000

/** Strip comment syntax and collapse whitespace, so the model gets prose rather than markup. */
function cleanDocComment(raw: string, cap: number): string | undefined {
  const text = raw
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(line => line.replace(/^\s*(\*+|\/\/)\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (text === '') return undefined
  // Skip machine-oriented noise that tells a reader nothing about purpose.
  if (/^(eslint|prettier|@ts-|istanbul|c8|prettier-ignore)/i.test(text)) return undefined
  return text.length > cap ? text.slice(0, cap).trimEnd() + '…' : text
}

/** The file's own leading comment: the first top-level node, when it is a comment. */
function fileDocComment(root: SyntaxNode): string | undefined {
  const first = root.children[0]
  if (!first || first.type !== 'comment') return undefined
  return cleanDocComment(first.text, FILE_DOC_CAP)
}

/**
 * The doc comment immediately preceding a declaration.
 *
 * An exported declaration is wrapped in an `export_statement`, and the comment is a sibling
 * of *that*, not of the declaration — so walk up to the export wrapper before looking back.
 */
function docCommentFor(node: SyntaxNode): string | undefined {
  const anchor = node.parent?.type === 'export_statement' ? node.parent : node
  const previous = anchor.previousSibling
  if (!previous || previous.type !== 'comment') return undefined
  return cleanDocComment(previous.text, SYMBOL_DOC_CAP)
}

/** Method symbols are qualified by their class: `Foo.bar`, never a bare `bar`. */
function methodSymbolName(className: string, methodName: string): string {
  return `${className}.${methodName}`
}

/**
 * True when a `lexical_declaration`/`variable_declaration` sits at module top level.
 * `export const x = ...` nests the declaration inside an `export_statement`, so that
 * counts too. Locals inside functions are deliberately excluded — emitting a node per
 * local `const` would bury the graph.
 */
function isTopLevelDeclaration(node: SyntaxNode): boolean {
  const parent = node.parent
  if (!parent) return false
  if (parent.type === 'program') return true
  return parent.type === 'export_statement' && parent.parent?.type === 'program'
}

function enclosingClassName(node: SyntaxNode): string | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'class_declaration') return childText(cur, 'name')
  }
  return null
}

/**
 * Node id of the declaration a given AST node sits inside — i.e. the source end of a
 * `calls`/`instantiates` edge. Falls back to the file node for top-level statements.
 *
 * `walkTree` carries no parent context, but tree-sitter's `SyntaxNode.parent` does, so
 * this walks up rather than threading state through the visitor.
 */
function enclosingSymbolId(node: SyntaxNode, filePath: string): string {
  for (let cur = node.parent; cur; cur = cur.parent) {
    switch (cur.type) {
      case 'method_definition': {
        const name = childText(cur, 'name')
        const className = enclosingClassName(cur)
        if (name && className) return symbolNodeId(filePath, methodSymbolName(className, name))
        break
      }
      case 'function_declaration':
      case 'class_declaration':
      case 'interface_declaration': {
        const name = childText(cur, 'name')
        if (name) return symbolNodeId(filePath, name)
        break
      }
      case 'variable_declarator': {
        // Only top-level declarators become nodes, so only they can source an edge.
        const declaration = cur.parent
        if (declaration && isTopLevelDeclaration(declaration)) {
          const name = childText(cur, 'name')
          if (name) return symbolNodeId(filePath, name)
        }
        break
      }
    }
  }
  return filePath
}

/**
 * Map every binding one `import_statement` introduces to the node id it refers to:
 *   `import { Alpha, Beta as Gamma } from './mod.js'` → Alpha→mod.ts::Alpha, Gamma→mod.ts::Beta
 *   `import * as ns from 'pkg'`                       → ns→pkg::pkg
 *
 * Default and namespace imports bind to the *module* node rather than a symbol inside it —
 * which symbol a default export actually is can't be known from the import site, and
 * guessing would fabricate a node. Package imports likewise collapse onto the package node:
 * DeBob never analyses inside a dependency, so no symbol node exists there to point at.
 */
function collectImportBindings(
  clause: SyntaxNode,
  targetId: string,
  isPackage: boolean,
  bind: (localName: string, nodeId: string) => void,
): void {
  for (const child of clause.children) {
    if (child.type === 'identifier') {
      bind(child.text, targetId)
      continue
    }
    if (child.type === 'namespace_import') {
      const alias = child.children.find(c => c.type === 'identifier')
      if (alias) bind(alias.text, targetId)
      continue
    }
    if (child.type === 'named_imports') {
      for (const spec of child.children) {
        if (spec.type !== 'import_specifier') continue
        const name = childText(spec, 'name')
        if (!name) continue
        const alias = childText(spec, 'alias')
        bind(alias ?? name, isPackage ? targetId : symbolNodeId(targetId, name))
      }
    }
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
 *   - `function` nodes (function_declaration, top-level arrow/function consts, class methods)
 *   - `variable` nodes (top-level non-function const/let/var)
 *   - `class` nodes (class_declaration) + extends/implements edges
 *   - `interface` nodes (interface_declaration) + extends edges
 *   - `declares` edges: file → its symbols, class → its methods
 *   - `calls` / `instantiates` edges between resolved symbols (confidence 0.9)
 *   - `imports` edges to resolved repo-relative paths or pkg:: nodes
 *   - `exports` edges for re-export statements
 *
 * Identifier resolution runs off a per-file symbol table (local declarations + import
 * bindings) built in a first pass. Anything that doesn't resolve emits no edge at all —
 * see `resolveSymbol`.
 *
 * Known omission: calls through a member expression (`adapter.close()`) are not extracted,
 * since resolving the receiver needs type information.
 *
 * Use the static factory: await TypeScriptAnalyzer.create(repoRoot)
 */
export class TypeScriptAnalyzer implements LanguageAnalyzer {
  readonly language = 'typescript'
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
  // Bumped from ts-1.0: file_cache compares this, so a bump makes `debob update`
  // re-analyze every file with the new extraction.
  readonly version = 'ts-1.3'

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
    const fileDoc = fileDocComment(tree.rootNode)
    nodes.push({
      id: filePath,
      type: 'file',
      name: filePath.split('/').pop() ?? filePath,
      filePath,
      confidence: 1.0,
      dataSource: 'static',
      layer,
      ...(fileDoc ? { metadata: { doc: fileDoc } } : {}),
    })

    // Symbol docs draw from a shared per-file budget, spent in source order. Without it a
    // single exhaustively-documented module could crowd out every other module's context.
    let docBudget = MODULE_DOC_BUDGET
    const takeDoc = (node: SyntaxNode): { metadata: { doc: string } } | undefined => {
      if (docBudget <= 0) return undefined
      const doc = docCommentFor(node)
      if (!doc) return undefined
      docBudget -= doc.length
      return { metadata: { doc } }
    }

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

    /** file/class --declares--> symbol. A structural fact, so full confidence. */
    const addDeclares = (ownerId: string, symbolId: string): void => {
      addEdge({
        id: mkEdgeId(ownerId, 'declares', symbolId),
        source: ownerId,
        target: symbolId,
        type: 'declares',
        confidence: 1.0,
        dataSource: 'static',
      })
    }

    // ── Pass 1: symbol resolution table ───────────────────────────────────
    // Maps a bare identifier as written in this file to the node id it denotes, for both
    // locally declared and imported names. Everything below that turns an identifier into
    // an edge target goes through this. It must be built before the emit pass so that a
    // call to a function declared *later* in the file still resolves.
    const symbols = new Map<string, string>()
    const bindSymbol = (localName: string, nodeId: string): void => {
      if (!symbols.has(localName)) symbols.set(localName, nodeId)
    }

    walkTree(tree.rootNode, (node) => {
      switch (node.type) {
        case 'import_statement': {
          const sourceNode = node.children.find(c => c.type === 'string')
          if (!sourceNode) break
          const raw = sourceNode.text.replace(/^['"]|['"]$/g, '')
          const { id: targetId, isPackage } = resolveImportTarget(raw, filePath, this.repoRoot)
          const clause = node.children.find(c => c.type === 'import_clause')
          if (clause) collectImportBindings(clause, targetId, isPackage, bindSymbol)
          break
        }
        case 'function_declaration':
        case 'class_declaration':
        case 'interface_declaration': {
          const name = childText(node, 'name')
          if (name) bindSymbol(name, symbolNodeId(filePath, name))
          break
        }
        case 'lexical_declaration':
        case 'variable_declaration': {
          if (!isTopLevelDeclaration(node)) break
          for (const declarator of node.children) {
            if (declarator.type !== 'variable_declarator') continue
            const name = childText(declarator, 'name')
            if (name) bindSymbol(name, symbolNodeId(filePath, name))
          }
          break
        }
      }
      return true
    })

    /**
     * Resolve an identifier written in this file to a real node id, or null.
     * Returning null means "emit no edge" — never invent a target, or the graph builder
     * stubs a phantom node named after whatever the identifier happened to be.
     */
    const resolveSymbol = (name: string): string | null => symbols.get(name) ?? null

    // ── Pass 2: emit nodes and edges ──────────────────────────────────────
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
          const nodeId = symbolNodeId(filePath, name)
          nodes.push({
            id: nodeId,
            type: 'function',
            name,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
            layer,
            ...takeDoc(node),
          })
          addDeclares(filePath, nodeId)
          break
        }

        // ── lexical/var declarations at module top level ─────────────────
        // `export const Foo = () => {}` is the dominant modern style and produced no node
        // at all before this. An initialiser that is a function becomes a `function` node;
        // anything else becomes a `variable` node.
        case 'lexical_declaration':
        case 'variable_declaration': {
          if (!isTopLevelDeclaration(node)) break
          for (const declarator of node.children) {
            if (declarator.type !== 'variable_declarator') continue
            const name = childText(declarator, 'name')
            if (!name) continue
            const value = declarator.childForFieldName('value')
            const isFunction =
              value?.type === 'arrow_function' ||
              value?.type === 'function_expression' ||
              value?.type === 'function'
            const nodeId = symbolNodeId(filePath, name)
            nodes.push({
              id: nodeId,
              type: isFunction ? 'function' : 'variable',
              name,
              filePath,
              startLine: declarator.startPosition.row + 1,
              endLine: declarator.endPosition.row + 1,
              confidence: 1.0,
              dataSource: 'static',
              layer,
              // The comment sits before the whole declaration, not the individual declarator.
              ...takeDoc(node),
            })
            addDeclares(filePath, nodeId)
          }
          break
        }

        // ── method_definition ───────────────────────────────────────────
        case 'method_definition': {
          const name = childText(node, 'name')
          const className = enclosingClassName(node)
          if (!name || !className) break
          const qualified = methodSymbolName(className, name)
          const nodeId = symbolNodeId(filePath, qualified)
          nodes.push({
            id: nodeId,
            type: 'function',
            name: qualified,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
            layer,
            ...takeDoc(node),
          })
          // Owned by its class, not the file — the containment chain stays real.
          addDeclares(symbolNodeId(filePath, className), nodeId)
          break
        }

        // ── call_expression / new_expression ────────────────────────────
        // Only plain-identifier callees are resolved. A member_expression
        // (`adapter.close()`) needs the receiver's type to resolve; matching on the
        // property name alone would invent edges, so those are deliberately skipped.
        case 'call_expression':
        case 'new_expression': {
          const calleeField = node.type === 'call_expression' ? 'function' : 'constructor'
          const callee = node.childForFieldName(calleeField)
          if (!callee || callee.type !== 'identifier') break
          const target = resolveSymbol(callee.text)
          if (!target) break
          const source = enclosingSymbolId(node, filePath)
          if (source === target) break // self-recursion renders as a meaningless self-loop
          const edgeType = node.type === 'call_expression' ? 'calls' : 'instantiates'
          addEdge({
            id: mkEdgeId(source, edgeType, target),
            source,
            target,
            type: edgeType,
            // Name-based resolution is not sound under shadowing or overloads. Deliberately
            // below 1.0 so the graph stays honest about how it knows this.
            confidence: 0.9,
            dataSource: 'static',
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
            ...takeDoc(node),
          })
          addDeclares(filePath, nodeId)
          // Heritage clauses: class_heritage contains extends_clause + implements_clause.
          // Targets are resolved through the symbol table — using the raw source text (as
          // this did before) makes the graph builder stub a phantom `file` node named after
          // a TypeScript type. Unresolvable bases emit nothing.
          for (const child of node.children) {
            if (child.type === 'class_heritage') {
              for (const clause of child.children) {
                if (clause.type === 'extends_clause') {
                  const base = clause.childForFieldName('value')?.text
                  const target = base ? resolveSymbol(base) : null
                  if (target) {
                    addEdge({
                      id: mkEdgeId(nodeId, 'extends', target),
                      source: nodeId,
                      target,
                      type: 'extends',
                      confidence: 1.0,
                      dataSource: 'static',
                    })
                  }
                }
                if (clause.type === 'implements_clause') {
                  for (const typeNode of clause.children) {
                    if (typeNode.type === 'implements' || typeNode.type === ',') continue
                    if (!typeNode.isNamed) continue
                    const target = resolveSymbol(typeNode.text)
                    if (!target) continue
                    addEdge({
                      id: mkEdgeId(nodeId, 'implements', target),
                      source: nodeId,
                      target,
                      type: 'implements',
                      confidence: 1.0,
                      dataSource: 'static',
                    })
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
            ...takeDoc(node),
          })
          addDeclares(filePath, nodeId)
          // extends_type_clause: interface Foo extends Bar, Baz — resolved, not raw text.
          for (const child of node.children) {
            if (child.type === 'extends_type_clause') {
              for (const typeNode of child.children) {
                if (typeNode.type === 'extends' || typeNode.type === ',') continue
                if (!typeNode.isNamed) continue
                const target = resolveSymbol(typeNode.text)
                if (!target) continue
                addEdge({
                  id: mkEdgeId(nodeId, 'extends', target),
                  source: nodeId,
                  target,
                  type: 'extends',
                  confidence: 1.0,
                  dataSource: 'static',
                })
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
