import { describe, expect, it } from 'vitest'
import type { AnalysisResult } from '../analyzers/interface.js'
import type { GitMetadata } from '../persistence/interface.js'
import type { ScannedFile } from '../scanner/types.js'
import type { Edge, Node } from './types.js'
import { buildGraph } from './builder.js'

const NO_GIT: GitMetadata = { commits: [], fileStats: [], headCommit: '' }

function scanned(relativePath: string): ScannedFile {
  return {
    path: `/repo/${relativePath}`,
    relativePath,
    extension: '.ts',
    language: 'typescript',
    sizeBytes: 1,
    contentHash: 'hash-' + relativePath,
  }
}

function symbol(id: string, filePath: string, partial: Partial<Node> = {}): Node {
  return {
    id,
    type: 'function',
    name: id.split('::').pop() ?? id,
    filePath,
    confidence: 1.0,
    dataSource: 'static',
    ...partial,
  }
}

function edge(source: string, target: string, type: Edge['type'] = 'calls'): Edge {
  return { id: `${source}::${type}::${target}`, source, target, type, confidence: 1.0, dataSource: 'static' }
}

function result(nodes: Node[], edges: Edge[] = []): AnalysisResult {
  return { nodes, edges }
}

describe('layer inheritance', () => {
  it('gives a symbol the layer of the file that declares it', () => {
    const file: Node = {
      id: 'src/services/auth.ts',
      type: 'file',
      name: 'auth.ts',
      filePath: 'src/services/auth.ts',
      layer: 'business',
      confidence: 1.0,
      dataSource: 'static',
    }
    const graph = buildGraph(
      [scanned('src/services/auth.ts')],
      [result([file, symbol('src/services/auth.ts::login', 'src/services/auth.ts')])],
      NO_GIT,
    )
    expect(graph.nodes.get('src/services/auth.ts::login')?.layer).toBe('business')
  })

  it('does not overwrite a layer the symbol already carries', () => {
    const file: Node = {
      id: 'src/a.ts',
      type: 'file',
      name: 'a.ts',
      filePath: 'src/a.ts',
      layer: 'business',
      confidence: 1.0,
      dataSource: 'static',
    }
    const graph = buildGraph(
      [scanned('src/a.ts')],
      [result([file, symbol('src/a.ts::helper', 'src/a.ts', { layer: 'data' })])],
      NO_GIT,
    )
    expect(graph.nodes.get('src/a.ts::helper')?.layer).toBe('data')
  })

  it('leaves a symbol unclassified when its file is too', () => {
    const graph = buildGraph(
      [scanned('src/a.ts')],
      [result([symbol('src/a.ts::helper', 'src/a.ts')])],
      NO_GIT,
    )
    expect(graph.nodes.get('src/a.ts::helper')?.layer).toBeUndefined()
  })
})

describe('missing edge endpoints', () => {
  it('drops an edge to an unresolved symbol rather than inventing a node', () => {
    // Stubbing here is what used to fabricate a `file` node named after a TypeScript type.
    const graph = buildGraph(
      [scanned('src/a.ts')],
      [result([symbol('src/a.ts::caller', 'src/a.ts')], [edge('src/a.ts::caller', 'src/a.ts::ghost')])],
      NO_GIT,
    )
    expect(graph.nodes.has('src/a.ts::ghost')).toBe(false)
    expect(graph.edges).toHaveLength(0)
  })

  it('still stubs an unscanned file, which is a real thing', () => {
    const graph = buildGraph(
      [scanned('src/a.ts')],
      [result([], [edge('src/a.ts', 'src/ignored.ts', 'imports')])],
      NO_GIT,
    )
    expect(graph.nodes.get('src/ignored.ts')?.metadata?.['stub']).toBe(true)
    expect(graph.edges).toHaveLength(1)
  })

  it('still stubs an external package', () => {
    const graph = buildGraph(
      [scanned('src/a.ts')],
      [result([], [edge('src/a.ts', 'pkg::express', 'imports')])],
      NO_GIT,
    )
    expect(graph.nodes.get('pkg::express')?.type).toBe('package')
    expect(graph.edges).toHaveLength(1)
  })
})
