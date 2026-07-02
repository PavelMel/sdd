/**
 * frontmatter.ts — the one shared parser (state.ts artifact frontmatter +
 * server.ts settings both go through it).
 */
import { describe, it, expect } from 'bun:test'
import { frontmatter, parseList, configValue } from '../frontmatter.ts'

describe('frontmatter', () => {
  it('parses flat scalar keys from a leading --- block', () => {
    const fm = frontmatter('---\nstatus: draft\nfeature_size: M\n---\n\n# Title\n')
    expect(fm).toEqual({ status: 'draft', feature_size: 'M' })
  })

  it('keeps values raw (quotes + inline comments preserved)', () => {
    const fm = frontmatter('---\nupdated_at: "2026-06-01"\nport: 4178   # loopback\n---\n')
    expect(fm.updated_at).toBe('"2026-06-01"')
    expect(fm.port).toBe('4178   # loopback')
  })

  it('returns {} when there is no frontmatter', () => {
    expect(frontmatter('# Just a doc\n')).toEqual({})
    expect(frontmatter('')).toEqual({})
  })

  it('returns {} for an unterminated block', () => {
    expect(frontmatter('---\nstatus: draft\n')).toEqual({})
  })

  it('ignores non key-value lines inside the block', () => {
    const fm = frontmatter('---\n# a yaml comment\nkey: v\n  nested: skipped\n---\n')
    expect(fm).toEqual({ key: 'v' })
  })
})

describe('parseList', () => {
  it('parses bracketed and bare comma lists, stripping quotes', () => {
    expect(parseList('[backend-service, web-frontend]')).toEqual([
      'backend-service',
      'web-frontend',
    ])
    expect(parseList('"a", \'b\'')).toEqual(['a', 'b'])
    expect(parseList('[]')).toEqual([])
    expect(parseList(undefined)).toEqual([])
  })
})

describe('configValue', () => {
  it('drops inline comments and outer quotes', () => {
    expect(configValue('true    # opt-in flag')).toBe('true')
    expect(configValue('"4178"')).toBe('4178')
    expect(configValue('   plain ')).toBe('plain')
    expect(configValue('')).toBe('')
  })
})
