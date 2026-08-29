import { beforeAll, describe, expect, it } from 'vitest'
import type { AnalysisResult } from '../interface.js'
import type { Edge, Node } from '../../graph/types.js'
import { TypeScriptAnalyzer } from './index.js'

/**
 * These cover the extraction that `debob update` depends on. The arrow-function gap sat
 * undetected behind a "done" checkbox for a whole phase precisely because nothing here
 * asserted on it — so the cases below deliberately include the styles the analyzer used
 * to silently drop.
 */

const FILE = 'src/demo.ts'

let analyzer: TypeScriptAnalyzer

// WASM init is slow and process-wide; build the analyzer once for the whole suite.
beforeAll(async () => {
  analyzer = await TypeScriptAnalyzer.create(process.cwd())
}, 30_000)

function analyze(lines: string[]): AnalysisResult {
  return analyzer.analyze(FILE, lines.join('\n'))
}

function node(result: AnalysisResult, id: string): Node | undefined {
  return result.nodes.find(n => n.id === id)
}

function edges(result: AnalysisResult, type: Edge['type']): Edge[] {
  return result.edges.filter(e => e.type === type)
}

function hasEdge(result: AnalysisResult, type: Edge['type'], source: string, target: string): boolean {
  return result.edges.some(e => e.type === type && e.source === source && e.target === target)
}

describe('symbol extraction', () => {
  it('emits a function node for a plain declaration', () => {
    const r = analyze(['export function doThing() { return 1 }'])
    expect(node(r, `${FILE}::doThing`)?.type).toBe('function')
  })

  it('emits a function node for an arrow-function const', () => {
    const r = analyze(['export const Widget = (props) => props'])
    expect(node(r, `${FILE}::Widget`)?.type).toBe('function')
  })

  it('emits a function node for a function-expression const', () => {
    const r = analyze(['const legacy = function () { return 1 }'])
    expect(node(r, `${FILE}::legacy`)?.type).toBe('function')
  })

  it('emits a variable node for a non-function const', () => {
    const r = analyze(['export const MAX_RETRIES = 5'])
    expect(node(r, `${FILE}::MAX_RETRIES`)?.type).toBe('variable')
  })

  it('ignores locals declared inside a function body', () => {
    const r = analyze(['function outer() {', '  const scratch = 1', '  return scratch', '}'])
    expect(node(r, `${FILE}::scratch`)).toBeUndefined()
  })

  it('qualifies a class method by its class', () => {
    const r = analyze(['class Repo {', '  save() { return 1 }', '}'])
    expect(node(r, `${FILE}::Repo.save`)?.type).toBe('function')
    // A bare id would collide with a top-level function of the same name.
    expect(node(r, `${FILE}::save`)).toBeUndefined()
  })
})

describe('declares edges', () => {
  it('links a file to each symbol it declares', () => {
    const r = analyze(['export function a() {}', 'export class B {}', 'export interface C { x: number }'])
    expect(hasEdge(r, 'declares', FILE, `${FILE}::a`)).toBe(true)
    expect(hasEdge(r, 'declares', FILE, `${FILE}::B`)).toBe(true)
    expect(hasEdge(r, 'declares', FILE, `${FILE}::C`)).toBe(true)
  })

  it('links a class to its methods rather than the file', () => {
    const r = analyze(['class Repo {', '  save() {}', '}'])
    expect(hasEdge(r, 'declares', `${FILE}::Repo`, `${FILE}::Repo.save`)).toBe(true)
    expect(hasEdge(r, 'declares', FILE, `${FILE}::Repo.save`)).toBe(false)
  })

  it('carries full confidence, being a structural fact', () => {
    const r = analyze(['export function a() {}'])
    expect(edges(r, 'declares').every(e => e.confidence === 1)).toBe(true)
  })
})

describe('calls and instantiates edges', () => {
  it('links two functions in the same file', () => {
    const r = analyze(['function helper() {}', 'function caller() { return helper() }'])
    expect(hasEdge(r, 'calls', `${FILE}::caller`, `${FILE}::helper`)).toBe(true)
  })

  it('sources the edge from the enclosing method, not the file', () => {
    const r = analyze(['function helper() {}', 'class Repo {', '  save() { return helper() }', '}'])
    expect(hasEdge(r, 'calls', `${FILE}::Repo.save`, `${FILE}::helper`)).toBe(true)
  })

  it('resolves a call through an aliased import', () => {
    const r = analyze([
      "import { helper as aliased } from './other.js'",
      'function caller() { return aliased() }',
    ])
    expect(hasEdge(r, 'calls', `${FILE}::caller`, 'src/other.js::helper')).toBe(true)
  })

  it('emits instantiates for a new expression', () => {
    const r = analyze(['class Foo {}', 'function make() { return new Foo() }'])
    expect(hasEdge(r, 'instantiates', `${FILE}::make`, `${FILE}::Foo`)).toBe(true)
  })

  it('marks name-resolved calls below full confidence', () => {
    const r = analyze(['function helper() {}', 'function caller() { return helper() }'])
    expect(edges(r, 'calls')[0]?.confidence).toBe(0.9)
  })

  it('emits nothing for an unresolvable callee', () => {
    // The phantom-stub regression guard: an edge to an unknown name makes the graph
    // builder fabricate a file node named after whatever the identifier was.
    const r = analyze(['function caller() { return totallyUnknown() }'])
    expect(edges(r, 'calls')).toHaveLength(0)
  })

  it('skips member-expression calls rather than guessing the receiver', () => {
    const r = analyze(['function caller() { return adapter.close() }'])
    expect(edges(r, 'calls')).toHaveLength(0)
  })

  it('does not emit a self-loop for direct recursion', () => {
    const r = analyze(['function loop(n) { return loop(n - 1) }'])
    expect(edges(r, 'calls')).toHaveLength(0)
  })
})

describe('heritage edges', () => {
  it('resolves extends to a real node id', () => {
    const r = analyze(['class Base {}', 'class Child extends Base {}'])
    expect(hasEdge(r, 'extends', `${FILE}::Child`, `${FILE}::Base`)).toBe(true)
  })

  it('resolves implements to a real node id', () => {
    const r = analyze(['interface Shape { x: number }', 'class Box implements Shape { x = 1 }'])
    expect(hasEdge(r, 'implements', `${FILE}::Box`, `${FILE}::Shape`)).toBe(true)
  })

  it('resolves an interface extending an imported interface', () => {
    const r = analyze([
      "import { Base } from './base.js'",
      'export interface Derived extends Base { x: number }',
    ])
    expect(hasEdge(r, 'extends', `${FILE}::Derived`, 'src/base.js::Base')).toBe(true)
  })

  it('emits no edge when the base type cannot be resolved', () => {
    const r = analyze(['class Child extends SomethingUnknown {}'])
    expect(edges(r, 'extends')).toHaveLength(0)
  })
})

describe('imports', () => {
  it('maps a bare specifier to a package node', () => {
    const r = analyze(["import chalk from 'chalk'"])
    expect(node(r, 'pkg::chalk')?.type).toBe('package')
    expect(hasEdge(r, 'imports', FILE, 'pkg::chalk')).toBe(true)
  })

  it('scopes a namespaced package to its full name', () => {
    const r = analyze(["import { WatsonXAI } from '@ibm-cloud/watsonx-ai'"])
    expect(node(r, 'pkg::@ibm-cloud/watsonx-ai')).toBeDefined()
  })
})
