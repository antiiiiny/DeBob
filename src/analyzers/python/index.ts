import Parser from 'web-tree-sitter'
import { createRequire } from 'module'
import { dirname, relative, resolve } from 'path'
import { existsSync } from 'fs'
import type { LanguageAnalyzer, AnalysisResult } from '../interface.js'
import type { Node, Edge } from '../../graph/types.js'

type SyntaxNode = Parser.SyntaxNode

const _require = createRequire(import.meta.url)

// ─── WASM Paths ───────────────────────────────────────────────────────────────
// Mirrors src/analyzers/typescript/index.ts — same web-tree-sitter runtime, different grammar.

function wasmDir(pkg: string): string {
  return dirname(_require.resolve(`${pkg}/package.json`)).replace(/\\/g, '/')
}

function resolveWasmPath(filename: string): string {
  if (filename === 'tree-sitter.wasm') {
    return `${wasmDir('web-tree-sitter')}/${filename}`
  }
  return `${wasmDir('tree-sitter-wasms')}/out/${filename}`
}

// ─── Module Resolution ────────────────────────────────────────────────────────

/** Walk up `level - 1` directories from `dirname(filePath)` — Python relative-import semantics. */
function resolvePythonBaseDir(level: number, filePath: string, repoRoot: string): string {
  let dir = dirname(resolve(repoRoot, filePath))
  for (let i = 1; i < level; i++) dir = dirname(dir)
  return dir
}

/**
 * Resolve `from .submodule import x` / `from ..pkg import y` against the filesystem, the same
 * way the TS analyzer resolves relative specifiers: probe `<path>.py` then `<path>/__init__.py`.
 * Falls back to the computed (unresolved) path — the graph builder turns that into a stub node,
 * same as an unresolved TS relative import.
 */
function resolvePythonRelativeImport(
  level: number,
  submodule: string | null,
  filePath: string,
  repoRoot: string,
): string {
  const baseDir = resolvePythonBaseDir(level, filePath, repoRoot)
  const targetAbs = submodule ? resolve(baseDir, ...submodule.split('.')) : baseDir
  const relBase = relative(repoRoot, targetAbs).replace(/\\/g, '/')
  for (const candidate of [`${relBase}.py`, `${relBase}/__init__.py`]) {
    if (existsSync(resolve(repoRoot, candidate))) return candidate
  }
  return `${relBase}.py`
}

/** Absolute dotted import (`import os.path`, `from typing import X`) → external package stub. */
function packageIdForDottedName(dottedName: string): string {
  return `pkg::${dottedName.split('.')[0]}`
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkEdgeId(source: string, type: string, target: string): string {
  return `${source}::${type}::${target}`
}

function symbolNodeId(filePath: string, name: string): string {
  return `${filePath}::${name}`
}

function walkTree(node: SyntaxNode, visitor: (n: SyntaxNode) => boolean | void): void {
  if (visitor(node) === false) return
  for (const child of node.children) {
    walkTree(child, visitor)
  }
}

/** Name of the class a definition sits inside, or null when it's a module-level function. */
function enclosingClassName(node: SyntaxNode): string | null {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (cur.type === 'class_definition') return cur.childForFieldName('name')?.text ?? null
  }
  return null
}

/** Extract the dotted-name text from a `dotted_name` or `aliased_import` node. */
function dottedNameText(node: SyntaxNode): string | null {
  if (node.type === 'dotted_name') return node.text
  if (node.type === 'aliased_import') {
    const inner = node.children.find(c => c.type === 'dotted_name')
    return inner?.text ?? null
  }
  return null
}

// ─── Python Analyzer ───────────────────────────────────────────────────────────

/**
 * Shallow V1 LanguageAnalyzer for Python — proves DeBob's LanguageAnalyzer plugin interface is
 * genuinely language-agnostic, not TS-only. Deliberately shallow (breadth of demo claim over
 * depth): imports, function/class nodes only. No base-class edges — the TS analyzer's
 * extends/implements edges use unqualified raw-text targets with no cross-file resolution,
 * which produces phantom stub nodes for colliding class names; skipping that here avoids
 * inheriting the same bug into a second language.
 *
 * Extracts per file:
 *   - One `file` node
 *   - `function` nodes (function_definition, including nested methods)
 *   - `class` nodes (class_definition) — no base-class edges
 *   - `imports` edges: `import x`, `import x.y as z`, `from x import y`, `from .rel import y`
 *
 * Use the static factory: await PythonAnalyzer.create(repoRoot)
 */
export class PythonAnalyzer implements LanguageAnalyzer {
  readonly language = 'python'
  readonly extensions = ['.py']
  // Bumped from py-1.0 for `declares` edges + class-qualified method ids.
  readonly version = 'py-1.1'

  private readonly parser: Parser
  private readonly repoRoot: string

  private constructor(parser: Parser, repoRoot: string) {
    this.parser = parser
    this.repoRoot = repoRoot
  }

  static async create(repoRoot: string): Promise<PythonAnalyzer> {
    // Parser.init() memoizes its own WASM runtime init — safe to call again alongside
    // TypeScriptAnalyzer.create(), which also calls it.
    await Parser.init({
      locateFile: () => resolveWasmPath('tree-sitter.wasm'),
    })

    const lang = await Parser.Language.load(resolveWasmPath('tree-sitter-python.wasm'))
    const parser = new Parser()
    parser.setLanguage(lang)

    return new PythonAnalyzer(parser, repoRoot)
  }

  analyze(filePath: string, source: string): AnalysisResult {
    const tree = this.parser.parse(source)

    const nodes: Node[] = []
    const edgesMap = new Map<string, Edge>()
    const packageNodes = new Map<string, Node>()

    nodes.push({
      id: filePath,
      type: 'file',
      name: filePath.split('/').pop() ?? filePath,
      filePath,
      confidence: 1.0,
      dataSource: 'static',
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

    const addImportEdge = (targetId: string, isPackage: boolean): void => {
      if (isPackage) ensurePackageNode(targetId)
      const edge: Edge = {
        id: mkEdgeId(filePath, 'imports', targetId),
        source: filePath,
        target: targetId,
        type: 'imports',
        confidence: 1.0,
        dataSource: 'static',
      }
      if (!edgesMap.has(edge.id)) edgesMap.set(edge.id, edge)
    }

    /** file/class --declares--> symbol. A structural fact, so full confidence. */
    const addDeclares = (ownerId: string, symbolId: string): void => {
      const edge: Edge = {
        id: mkEdgeId(ownerId, 'declares', symbolId),
        source: ownerId,
        target: symbolId,
        type: 'declares',
        confidence: 1.0,
        dataSource: 'static',
      }
      if (!edgesMap.has(edge.id)) edgesMap.set(edge.id, edge)
    }

    walkTree(tree.rootNode, (node) => {
      switch (node.type) {

        // ── import_statement: `import os`, `import os.path as p`, `import a, b` ─
        case 'import_statement': {
          for (const child of node.children) {
            const dotted = dottedNameText(child)
            if (dotted) addImportEdge(packageIdForDottedName(dotted), true)
          }
          break
        }

        // ── import_from_statement: `from x import y`, `from . import y`, `from .foo import y`
        case 'import_from_statement': {
          const moduleNode = node.children.find(c => c.type === 'dotted_name' || c.type === 'relative_import')
          if (!moduleNode) break

          if (moduleNode.type === 'dotted_name') {
            addImportEdge(packageIdForDottedName(moduleNode.text), true)
          } else {
            // relative_import: import_prefix (dots) + optional dotted_name (submodule)
            const prefix = moduleNode.children.find(c => c.type === 'import_prefix')
            const level = prefix?.text.length ?? 1
            let submodule = moduleNode.children.find(c => c.type === 'dotted_name')?.text ?? null

            // Bare `from . import sibling` has no submodule on relative_import itself — the
            // first imported name after `import` is, in the overwhelmingly common case, a
            // submodule of the current package (`from . import sibling_module`).
            if (!submodule) {
              const importIdx = node.children.findIndex(c => c.type === 'import')
              const firstImported = node.children.slice(importIdx + 1).find(c => dottedNameText(c) !== null)
              submodule = firstImported ? dottedNameText(firstImported) : null
            }

            const targetId = resolvePythonRelativeImport(level, submodule, filePath, this.repoRoot)
            addImportEdge(targetId, false)
          }
          break
        }

        // ── function_definition (including nested methods) ─────────────────
        case 'function_definition': {
          const name = node.childForFieldName('name')?.text
          if (!name) break
          // A method is qualified by its class. A flat `file.py::save` would collide with a
          // top-level `save` in the same file and silently merge two different symbols.
          const className = enclosingClassName(node)
          const symbolName = className ? `${className}.${name}` : name
          const nodeId = symbolNodeId(filePath, symbolName)
          nodes.push({
            id: nodeId,
            type: 'function',
            name: symbolName,
            filePath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            confidence: 1.0,
            dataSource: 'static',
          })
          addDeclares(className ? symbolNodeId(filePath, className) : filePath, nodeId)
          break
        }

        // ── class_definition (no base-class edges — see class doc comment) ──
        case 'class_definition': {
          const name = node.childForFieldName('name')?.text
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
          })
          addDeclares(filePath, nodeId)
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
