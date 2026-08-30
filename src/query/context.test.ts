import { describe, expect, it } from 'vitest'
import type { Edge, Graph, Node } from '../graph/types.js'
import { buildModuleContext } from './index.js'

/**
 * `buildModuleContext` assembles the only thing the LLM ever sees for a module, so a defect
 * here is invisible in tests but degrades every enrichment. The `reExports` case below is a
 * regression guard: the field was previously called `exports` and documented as "exported
 * symbol names" while actually holding re-export module paths — so a file doing
 * `export function foo()` was described to the model as exporting nothing.
 */

const FILE = 'src/graph/builder.ts'

function fileNode(partial: Partial<Node> = {}): Node {
  return {
    id: FILE,
    type: 'file',
    name: 'builder.ts',
    filePath: FILE,
    confidence: 1,
    dataSource: 'static',
    ...partial,
  }
}

function symbol(name: string, partial: Partial<Node> = {}): Node {
  return {
    id: `${FILE}::${name}`,
    type: 'function',
    name,
    filePath: FILE,
    confidence: 1,
    dataSource: 'static',
    ...partial,
  }
}

function edge(source: string, target: string, type: Edge['type']): Edge {
  return { id: `${source}::${type}::${target}`, source, target, type, confidence: 1, dataSource: 'static' }
}

function graphOf(nodes: Node[], edges: Edge[] = []): Graph {
  return { nodes: new Map(nodes.map(n => [n.id, n])), edges }
}

describe('buildModuleContext', () => {
  it('lists declared symbols regardless of re-exports', () => {
    const graph = graphOf([fileNode(), symbol('buildGraph')])
    const ctx = buildModuleContext(fileNode(), graph)
    expect(ctx.declarations.map(d => d.name)).toContain('buildGraph')
    expect(ctx.reExports).toEqual([])
  })

  it('puts re-export module paths in reExports, not alongside declarations', () => {
    const graph = graphOf(
      [fileNode(), symbol('buildGraph')],
      [edge(FILE, 'src/graph/types.ts', 'exports')],
    )
    const ctx = buildModuleContext(fileNode(), graph)
    expect(ctx.reExports).toEqual(['src/graph/types.ts'])
    expect(ctx.declarations.map(d => d.name)).toEqual(['buildGraph'])
  })

  it('surfaces outgoing calls to other modules', () => {
    const graph = graphOf(
      [fileNode(), symbol('buildGraph')],
      [edge(`${FILE}::buildGraph`, 'src/scanner/index.ts::scanRepository', 'calls')],
    )
    const ctx = buildModuleContext(fileNode(), graph)
    expect(ctx.calls).toEqual(['scanRepository (src/scanner/index.ts)'])
  })

  it('surfaces incoming calls from other modules', () => {
    const graph = graphOf(
      [fileNode(), symbol('buildGraph')],
      [edge('src/engine/index.ts::runInit', `${FILE}::buildGraph`, 'calls')],
    )
    const ctx = buildModuleContext(fileNode(), graph)
    expect(ctx.calledBy).toEqual(['runInit (src/engine/index.ts)'])
  })

  it('ignores calls that stay inside the module', () => {
    // Internal wiring says nothing about the module's role in the wider system.
    const graph = graphOf(
      [fileNode(), symbol('buildGraph'), symbol('makeStubNode')],
      [edge(`${FILE}::buildGraph`, `${FILE}::makeStubNode`, 'calls')],
    )
    const ctx = buildModuleContext(fileNode(), graph)
    expect(ctx.calls).toBeUndefined()
    expect(ctx.calledBy).toBeUndefined()
  })

  it('caps the call lists so a hub module cannot dominate the prompt', () => {
    const callers = Array.from({ length: 30 }, (_, i) =>
      edge(`src/m${i}.ts::caller${i}`, `${FILE}::buildGraph`, 'calls'),
    )
    const graph = graphOf([fileNode(), symbol('buildGraph')], callers)
    expect(buildModuleContext(fileNode(), graph).calledBy).toHaveLength(12)
  })

  it('carries doc comments through from node metadata', () => {
    const graph = graphOf([
      fileNode({ metadata: { doc: 'Merges scanner, analyzer and git output.' } }),
      symbol('buildGraph', { metadata: { doc: 'Stubs dangling endpoints.' } }),
    ])
    const ctx = buildModuleContext(fileNode({ metadata: { doc: 'Merges scanner, analyzer and git output.' } }), graph)
    expect(ctx.doc).toBe('Merges scanner, analyzer and git output.')
    expect(ctx.declarations[0]?.doc).toBe('Stubs dangling endpoints.')
  })

  it('includes the layer so summaries can be framed by it', () => {
    const graph = graphOf([fileNode({ layer: 'business' })])
    expect(buildModuleContext(fileNode({ layer: 'business' }), graph).layer).toBe('business')
  })
})
