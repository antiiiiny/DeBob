import { describe, expect, it } from 'vitest'
import { parseModuleDescription } from './providers/watsonx.js'

/**
 * `describeModule` merges the summary and layer calls into one, which halves prompt spend
 * but makes enrichment depend on parsing model-authored JSON. These cover the shapes models
 * actually emit — a bare object is the happy path and everything else is the common reality.
 */
describe('parseModuleDescription', () => {
  it('reads a clean JSON object', () => {
    const r = parseModuleDescription('{"responsibility":"Builds the graph.","layer":"business"}')
    expect(r).toEqual({ responsibility: 'Builds the graph.', layer: 'business' })
  })

  it('reads through a markdown code fence', () => {
    const r = parseModuleDescription('```json\n{"responsibility":"Scans files.","layer":"data"}\n```')
    expect(r?.layer).toBe('data')
  })

  it('ignores lead-in prose before the object', () => {
    const r = parseModuleDescription('Here is the JSON:\n{"responsibility":"Parses AST.","layer":"infra"}')
    expect(r?.responsibility).toBe('Parses AST.')
  })

  it('normalises layer casing', () => {
    expect(parseModuleDescription('{"responsibility":"x","layer":"Business"}')?.layer).toBe('business')
  })

  it('keeps a good responsibility even when the layer is invalid', () => {
    // Losing the prose over a bad enum would be the wrong trade: layer can still be
    // supplied by path heuristics and inheritance, but nothing else can supply this text.
    const r = parseModuleDescription('{"responsibility":"Real text.","layer":"middleware-ish"}')
    expect(r).toEqual({ responsibility: 'Real text.', layer: 'unclassified' })
  })

  it('returns null on unparseable text so the caller can fall back', () => {
    expect(parseModuleDescription('I could not determine a responsibility.')).toBeNull()
  })

  it('returns null when the responsibility is missing or empty', () => {
    expect(parseModuleDescription('{"layer":"data"}')).toBeNull()
    expect(parseModuleDescription('{"responsibility":"   ","layer":"data"}')).toBeNull()
  })

  it('returns null on malformed JSON rather than throwing', () => {
    expect(parseModuleDescription('{"responsibility": "unterminated')).toBeNull()
  })
})
