/**
 * state.ts — disk → pipeline derivation, tested through the public API only
 * (listFeatures / getFeatureDetail / getRoadmap) against committed fixture trees.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'bun:test'
import { join } from 'path'
import { setProjectDir } from '../paths.ts'
import { listFeatures, getFeatureDetail, getRoadmap, type FeatureSummary } from '../state.ts'

const PROJECT_A = join(import.meta.dir, 'fixtures', 'project-a')
const PROJECT_EMPTY = join(import.meta.dir, 'fixtures', 'project-empty')

function bySlug(features: FeatureSummary[], slug: string): FeatureSummary {
  const f = features.find((x) => x.slug === slug)
  if (!f) throw new Error(`fixture feature missing: ${slug}`)
  return f
}

function stageStatus(f: FeatureSummary, id: string): string {
  const s = f.stages.find((x) => x.id === id)
  if (!s) throw new Error(`stage missing: ${id}`)
  return s.status
}

describe('project-a', () => {
  let features: FeatureSummary[]

  beforeAll(() => {
    setProjectDir(PROJECT_A)
    features = listFeatures()
  })

  // Bun hoists every beforeAll in the file ahead of the first test, so another
  // describe's hook can steal the module-level project dir — re-pin it per test.
  beforeEach(() => {
    setProjectDir(PROJECT_A)
  })

  it('lists every fixture feature, sorted by slug', () => {
    expect(features.map((f) => f.slug)).toEqual([
      'billing-export',
      'designed',
      'fresh-idea',
      'in-progress',
      'reviewed-changes',
      'reviewed-pass',
      'skipped-mid',
      'spec-only',
    ])
  })

  describe('signal → stage table', () => {
    it('fresh-idea: nothing but .size → created; specify pending, rest blocked', () => {
      const f = bySlug(features, 'fresh-idea')
      expect(f.stage).toBe('created')
      expect(f.size).toBe('XS')
      expect(stageStatus(f, 'specify')).toBe('pending')
      expect(stageStatus(f, 'design')).toBe('blocked')
      expect(stageStatus(f, 'ship')).toBe('blocked')
    })

    it('spec-only: spec.md → specify done; frontmatter status + H1 title read', () => {
      const f = bySlug(features, 'spec-only')
      expect(f.stage).toBe('specify')
      expect(f.specStatus).toBe('draft')
      expect(f.title).toBe('Spec-only feature title')
      expect(stageStatus(f, 'specify')).toBe('done')
      expect(stageStatus(f, 'clarify')).toBe('pending')
      expect(stageStatus(f, 'design')).toBe('pending')
      // design (non-skippable) not done → everything after is blocked
      expect(stageStatus(f, 'sequences')).toBe('blocked')
    })

    it('designed: sad.md without sequenceDiagram → design done, sequences pending', () => {
      const f = bySlug(features, 'designed')
      expect(f.stage).toBe('design')
      expect(f.surfaces).toEqual(['backend-service'])
      expect(stageStatus(f, 'design')).toBe('done')
      expect(stageStatus(f, 'sequences')).toBe('pending')
    })

    it('in-progress: sequenceDiagram in sad → sequences done; contracts + data-model detected', () => {
      const f = bySlug(features, 'in-progress')
      expect(stageStatus(f, 'sequences')).toBe('done')
      expect(stageStatus(f, 'data-model')).toBe('done')
      expect(stageStatus(f, 'api')).toBe('done')
      expect(f.stage).toBe('implement')
      expect(f.surfaces).toEqual(['backend-service', 'web-frontend'])
    })
  })

  describe('skipped vs pending', () => {
    it('skipped-mid: optional stages behind the furthest artifact are skipped, not pending', () => {
      const f = bySlug(features, 'skipped-mid')
      expect(f.stage).toBe('tasks')
      expect(stageStatus(f, 'clarify')).toBe('skipped')
      expect(stageStatus(f, 'sequences')).toBe('skipped')
      expect(stageStatus(f, 'data-model')).toBe('skipped')
      expect(stageStatus(f, 'api')).toBe('skipped')
      // ahead of the furthest stage nothing is "skipped" — it's pending/blocked
      expect(stageStatus(f, 'plan-tests')).toBe('pending')
      expect(stageStatus(f, 'implement')).toBe('pending')
      expect(stageStatus(f, 'review')).toBe('blocked')
    })

    it('designed: clarify (no disk signal) behind design counts as skipped', () => {
      const f = bySlug(features, 'designed')
      expect(stageStatus(f, 'clarify')).toBe('skipped')
    })
  })

  describe('tracker parsing', () => {
    it('counts T-rows only, normalizes states, ignores the — placeholder row', () => {
      const f = bySlug(features, 'in-progress')
      // T1 done + T2 Done = 2 done; T3 "in progress" + T4 todo counted; T5 "—" ignored
      expect(f.progress).toEqual({ done: 2, total: 4, pct: 50 })
      expect(stageStatus(f, 'implement')).toBe('done') // started ⇒ implement detected
    })
  })

  describe('review verdict', () => {
    it('CHANGES REQUESTED wins over a PASS mention in the same file', () => {
      const f = bySlug(features, 'reviewed-changes')
      expect(f.reviewVerdict).toBe('CHANGES REQUESTED')
    })

    it('the latest review file wins', () => {
      const f = bySlug(features, 'reviewed-pass')
      expect(f.reviewVerdict).toBe('PASS')
    })
  })

  describe('shipped (roadmap regex)', () => {
    it('a features/<slug>/ link in the Shipped section marks the feature shipped', () => {
      const f = bySlug(features, 'billing-export')
      expect(f.shipped).toBe(true)
      expect(f.stage).toBe('ship')
      expect(stageStatus(f, 'ship')).toBe('done')
    })

    it('a link in the Now section does NOT mark it shipped', () => {
      const f = bySlug(features, 'in-progress')
      expect(f.shipped).toBe(false)
    })

    it('getRoadmap returns the markdown + the shipped slugs', () => {
      const r = getRoadmap()
      expect(r.exists).toBe(true)
      expect(r.shipped).toEqual(['billing-export'])
      expect(r.markdown).toContain('## Shipped')
    })
  })

  describe('feature detail (artifacts)', () => {
    it('orders well-known artifacts first and excludes migrations/*.sql', () => {
      const d = getFeatureDetail('in-progress')
      expect(d).not.toBeNull()
      const paths = d!.artifacts.map((a) => a.path)
      expect(paths[0]).toBe('.size')
      expect(paths).toContain('spec.md')
      expect(paths).toContain('contracts/openapi.yaml')
      expect(paths.some((p) => p.includes('migrations'))).toBe(false)
    })

    it('labels the openapi contract (plain text — no in-browser API console)', () => {
      const d = getFeatureDetail('in-progress')!
      const oa = d.artifacts.find((a) => a.path === 'contracts/openapi.yaml')!
      expect(oa.kind).toBe('text')
      expect(oa.label).toBe('OpenAPI contract')
    })

    it('returns null for an unknown slug', () => {
      expect(getFeatureDetail('no-such-feature')).toBeNull()
    })
  })
})

describe('project-empty', () => {
  it('no features dir → empty list; no roadmap → exists:false', () => {
    setProjectDir(PROJECT_EMPTY)
    expect(listFeatures()).toEqual([])
    expect(getRoadmap()).toEqual({ exists: false, markdown: '', shipped: [] })
  })
})
