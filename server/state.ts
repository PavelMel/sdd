/**
 * State derivation — disk is the source of truth.
 *
 * Each feature's pipeline is a per-step checklist (done / skipped / pending /
 * blocked), NOT a linear cursor: clarify / sequences / data-model / api /
 * plan-tests are legitimately N/A-skippable for XS/S, so a missing artifact is
 * labelled `skipped` (the pipeline moved past it) vs `pending` (it's next).
 *
 * The signal→stage table (from the plan):
 *   docs/features/<slug>/            → created
 *   .size                            → size badge
 *   spec.md (+ frontmatter status)   → specified
 *   sad.md (+ target_surfaces)       → designed
 *   sad.md has §6 sequenceDiagram    → sequenced
 *   data-model.md (+ migrations/)    → data-modeled
 *   contracts/* (openapi/cli/events) → api-defined
 *   tasks.json + tasks/tracker.md    → tasked (+ % from tracker rows)
 *   test-plan.md or inline ## Test plan → tests-planned
 *   tracker in_progress/done rows    → implementing / implemented
 *   _review/review-*.md              → reviewed (latest PASS / CHANGES REQUESTED)
 *   roadmap "Shipped" row            → shipped
 */

import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'fs'
import { join, extname, relative, sep } from 'path'
import { docsDir, featuresDir, ALLOWED_EXT } from './paths.ts'
import { frontmatter, parseList } from './frontmatter.ts'

export type StageStatus = 'done' | 'skipped' | 'pending' | 'blocked'

export interface Stage {
  id: string
  skill: string
  label: string
  status: StageStatus
  skippable: boolean
}

export interface FeatureSummary {
  slug: string
  title: string
  size: string | null
  specStatus: string | null
  stage: string // id of the furthest 'done' stage, or 'created'
  stages: Stage[]
  progress: { done: number; total: number; pct: number } | null
  reviewVerdict: 'PASS' | 'CHANGES REQUESTED' | null
  surfaces: string[]
  shipped: boolean
}

export interface Artifact {
  path: string // relative to the feature dir
  label: string
  kind: 'markdown' | 'json' | 'text'
}

export interface FeatureDetail extends FeatureSummary {
  artifacts: Artifact[]
}

// ---- low-level reads -------------------------------------------------------

function readIf(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function lsIf(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function firstHeading(text: string): string | null {
  const m = text.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

// ---- tracker parsing -------------------------------------------------------

const TERMINAL_STATES = new Set(['done'])
const STARTED_STATES = new Set(['in_progress', 'done', 'review'])

function normState(s: string): string {
  return s.toLowerCase().trim().replace(/[\s-]+/g, '_')
}

interface Tracker {
  total: number
  done: number
  started: boolean
}

function parseTracker(text: string | null): Tracker | null {
  if (!text) return null
  let total = 0
  let done = 0
  let started = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').map((c) => c.trim())
    // | #  | Task | ... | Status |  → cells[0] and last are '' from edge pipes
    const inner = cells.slice(1, -1)
    if (inner.length < 2) continue
    const id = inner[0]
    if (!/^T\d+$/i.test(id)) continue // skip header + separator rows
    const status = normState(inner[inner.length - 1])
    if (!status || status === '—' || status === '-') continue
    total++
    if (TERMINAL_STATES.has(status)) done++
    if (STARTED_STATES.has(status)) started = true
  }
  if (total === 0) return null
  return { total, done, started }
}

// ---- review verdict --------------------------------------------------------

function latestReviewVerdict(reviewDir: string): 'PASS' | 'CHANGES REQUESTED' | null {
  const files = lsIf(reviewDir)
    .filter((f) => /^review-.*\.md$/.test(f))
    .sort()
  if (files.length === 0) return null
  const latest = files[files.length - 1]
  const text = readIf(join(reviewDir, latest)) ?? ''
  // "CHANGES REQUESTED" must be checked before "PASS" (a file may mention both;
  // the gate result line is what matters — prefer the explicit changes verdict).
  if (/CHANGES\s+REQUESTED/i.test(text)) return 'CHANGES REQUESTED'
  if (/\bPASS(ED)?\b/i.test(text)) return 'PASS'
  return null
}

// ---- roadmap (shipped set) -------------------------------------------------

export function getRoadmap(): { exists: boolean; markdown: string; shipped: string[] } {
  const path = join(docsDir(), 'roadmap.md')
  const text = readIf(path)
  if (text === null) return { exists: false, markdown: '', shipped: [] }
  return { exists: true, markdown: text, shipped: [...shippedSlugs(text)] }
}

function shippedSlugs(roadmap: string): Set<string> {
  const out = new Set<string>()
  const lower = roadmap.toLowerCase()
  const idx = lower.indexOf('## shipped')
  if (idx === -1) return out
  // From the Shipped header to the next top-level "## " (or EOF).
  let end = roadmap.indexOf('\n## ', idx + 3)
  if (end === -1) end = roadmap.length
  const section = roadmap.slice(idx, end)
  const re = /features\/([a-z0-9][a-z0-9-]*)\//g
  let m: RegExpExecArray | null
  while ((m = re.exec(section))) out.add(m[1])
  return out
}

// ---- stage detection -------------------------------------------------------

interface StageDef {
  id: string
  skill: string
  label: string
  skippable: boolean
}

const STAGE_DEFS: StageDef[] = [
  { id: 'specify', skill: 'specify', label: 'Spec', skippable: false },
  { id: 'clarify', skill: 'clarify', label: 'Clarify', skippable: true },
  { id: 'design', skill: 'design', label: 'Design', skippable: false },
  { id: 'sequences', skill: 'sequences', label: 'Sequences', skippable: true },
  { id: 'data-model', skill: 'data-model', label: 'Data model', skippable: true },
  { id: 'api', skill: 'api', label: 'API', skippable: true },
  { id: 'tasks', skill: 'tasks', label: 'Tasks', skippable: false },
  { id: 'plan-tests', skill: 'plan-tests', label: 'Test plan', skippable: true },
  { id: 'implement', skill: 'implement', label: 'Implement', skippable: false },
  { id: 'review', skill: 'review', label: 'Review', skippable: false },
  { id: 'ship', skill: 'ship', label: 'Ship', skippable: false },
]

interface Signals {
  spec: string | null
  sad: string | null
  hasDataModel: boolean
  hasContracts: boolean
  hasTasks: boolean
  tracker: Tracker | null
  hasTestPlan: boolean
  hasReview: boolean
  shipped: boolean
}

/** detected: true = artifact present, false = absent, null = no disk signal (clarify). */
function detect(def: StageDef, s: Signals): boolean | null {
  switch (def.id) {
    case 'specify':
      return s.spec !== null
    case 'clarify':
      return null
    case 'design':
      return s.sad !== null
    case 'sequences':
      return s.sad !== null && /\bsequenceDiagram\b/.test(s.sad)
    case 'data-model':
      return s.hasDataModel
    case 'api':
      return s.hasContracts
    case 'tasks':
      return s.hasTasks
    case 'plan-tests':
      return s.hasTestPlan || (s.spec !== null && /^##\s+Test plan/im.test(s.spec))
    case 'implement':
      return s.tracker !== null && s.tracker.started
    case 'review':
      return s.hasReview
    case 'ship':
      return s.shipped
    default:
      return false
  }
}

function deriveStages(s: Signals): { stages: Stage[]; furthest: string } {
  const detected = STAGE_DEFS.map((d) => detect(d, s))
  let lastDetected = -1
  detected.forEach((d, i) => {
    if (d === true) lastDetected = i
  })

  const status: StageStatus[] = new Array(STAGE_DEFS.length)
  // pass 1 — done + skipped (anything absent but already passed)
  for (let i = 0; i < STAGE_DEFS.length; i++) {
    if (detected[i] === true) status[i] = 'done'
    else if (i < lastDetected) status[i] = 'skipped'
    else status[i] = null as unknown as StageStatus // resolved in pass 2
  }
  // pass 2 — pending vs blocked for the not-yet-reached stages (left→right)
  for (let i = 0; i < STAGE_DEFS.length; i++) {
    if (status[i]) continue
    let blocked = false
    for (let j = 0; j < i; j++) {
      if (!STAGE_DEFS[j].skippable && status[j] !== 'done' && status[j] !== 'skipped') {
        blocked = true
        break
      }
    }
    status[i] = blocked ? 'blocked' : 'pending'
  }

  const stages: Stage[] = STAGE_DEFS.map((d, i) => ({
    id: d.id,
    skill: d.skill,
    label: d.label,
    skippable: d.skippable,
    status: status[i],
  }))
  const furthest = lastDetected >= 0 ? STAGE_DEFS[lastDetected].id : 'created'
  return { stages, furthest }
}

// ---- public API ------------------------------------------------------------

function readSignals(dir: string, slug: string, shipped: Set<string>): Signals {
  const spec = readIf(join(dir, 'spec.md'))
  const sad = readIf(join(dir, 'sad.md'))
  const contracts = lsIf(join(dir, 'contracts')).filter(
    (f) => /\.(yaml|yml|md|json)$/i.test(f),
  )
  return {
    spec,
    sad,
    hasDataModel: existsSync(join(dir, 'data-model.md')),
    hasContracts: contracts.length > 0,
    hasTasks: existsSync(join(dir, 'tasks.json')),
    tracker: parseTracker(readIf(join(dir, 'tasks', 'tracker.md'))),
    hasTestPlan: existsSync(join(dir, 'test-plan.md')),
    hasReview: lsIf(join(dir, '_review')).some((f) => /^review-.*\.md$/.test(f)),
    shipped: shipped.has(slug),
  }
}

function summarize(slug: string, shipped: Set<string>): FeatureSummary {
  const dir = join(featuresDir(), slug)
  const sig = readSignals(dir, slug, shipped)
  const { stages, furthest } = deriveStages(sig)

  const size = (readIf(join(dir, '.size')) ?? '').trim().split(/\s+/)[0] || null
  const specFm = sig.spec ? frontmatter(sig.spec) : {}
  const sadFm = sig.sad ? frontmatter(sig.sad) : {}
  const title =
    (sig.spec && firstHeading(sig.spec)) || specFm.title || slug
  const surfaces = parseList(sadFm.target_surfaces)
  const progress = sig.tracker
    ? {
        done: sig.tracker.done,
        total: sig.tracker.total,
        pct: Math.round((sig.tracker.done / sig.tracker.total) * 100),
      }
    : null

  return {
    slug,
    title,
    size: size && /^(XS|S|M|L|XL)$/i.test(size) ? size.toUpperCase() : size,
    specStatus: specFm.status ?? null,
    stage: furthest,
    stages,
    progress,
    reviewVerdict: latestReviewVerdict(join(dir, '_review')),
    surfaces,
    shipped: sig.shipped,
  }
}

export function listFeatures(): FeatureSummary[] {
  const root = featuresDir()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const shipped = shippedSlugs(readIf(join(docsDir(), 'roadmap.md')) ?? '')
  const out: FeatureSummary[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    let isDir = false
    try {
      isDir = statSync(join(root, name)).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    out.push(summarize(name, shipped))
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

const KIND_BY_NAME: Array<[RegExp, Artifact['kind'], string]> = [
  // openapi renders as plain text in the read-only dashboard (no redoc)
  [/^contracts\/openapi\.ya?ml$/i, 'text', 'OpenAPI contract'],
  [/\.ya?ml$/i, 'text', 'YAML'],
  [/\.json$/i, 'json', 'JSON'],
  [/(^|\/)\.size$/i, 'text', 'Size'],
]

function artifactMeta(rel: string): { kind: Artifact['kind']; label: string } {
  if (rel === 'tasks.json') return { kind: 'json', label: 'Tasks (JSON)' }
  for (const [re, kind, label] of KIND_BY_NAME) {
    if (re.test(rel)) return { kind, label }
  }
  // Friendly labels for the well-known markdown artifacts.
  const labels: Record<string, string> = {
    'spec.md': 'Spec',
    'sad.md': 'Architecture (SAD)',
    'data-model.md': 'Data model',
    'test-plan.md': 'Test plan',
    'CONTEXT.md': 'Glossary',
    'contracts/cli.md': 'CLI contract',
    'contracts/events.md': 'Events',
    'contracts/public-api.md': 'Public API',
    'tasks/_epic.md': 'Epic',
    'tasks/tracker.md': 'Tracker',
  }
  if (labels[rel]) return { kind: 'markdown', label: labels[rel] }
  if (rel.startsWith('adr/')) return { kind: 'markdown', label: `ADR · ${rel.slice(4)}` }
  if (rel.startsWith('_review/')) return { kind: 'markdown', label: `Review · ${rel.slice(8)}` }
  if (rel.startsWith('_fixes/')) return { kind: 'markdown', label: `Fix · ${rel.slice(7)}` }
  if (rel.startsWith('tasks/')) return { kind: 'markdown', label: `Task · ${rel.slice(6)}` }
  return { kind: 'markdown', label: rel }
}

function walkArtifacts(dir: string, base: string, depth: number, acc: Artifact[]): void {
  if (depth > 4) return
  for (const name of lsIf(dir)) {
    if (name === 'migrations') continue // *.sql is outside the served allowlist
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      walkArtifacts(abs, base, depth + 1, acc)
      continue
    }
    const rel = relative(base, abs).split(sep).join('/')
    const ext = extname(name).toLowerCase()
    const isSize = name === '.size'
    if (!isSize && !ALLOWED_EXT.has(ext)) continue
    const { kind, label } = artifactMeta(rel)
    acc.push({ path: rel, label, kind })
  }
}

const ARTIFACT_ORDER = [
  '.size',
  'spec.md',
  'CONTEXT.md',
  'sad.md',
  'data-model.md',
  'contracts/openapi.yaml',
  'contracts/cli.md',
  'contracts/events.md',
  'contracts/public-api.md',
  'tasks.json',
  'tasks/_epic.md',
  'tasks/tracker.md',
  'test-plan.md',
]

function artifactRank(rel: string): number {
  const i = ARTIFACT_ORDER.indexOf(rel)
  if (i !== -1) return i
  if (rel.startsWith('adr/')) return 100
  if (rel.startsWith('tasks/')) return 200
  if (rel.startsWith('_review/')) return 300
  if (rel.startsWith('_fixes/')) return 400
  return 500
}

export function getFeatureDetail(slug: string): FeatureDetail | null {
  const dir = join(featuresDir(), slug)
  if (!existsSync(dir)) return null
  const shipped = shippedSlugs(readIf(join(docsDir(), 'roadmap.md')) ?? '')
  const summary = summarize(slug, shipped)
  const artifacts: Artifact[] = []
  walkArtifacts(dir, dir, 0, artifacts)
  artifacts.sort((a, b) => artifactRank(a.path) - artifactRank(b.path) || a.path.localeCompare(b.path))
  return { ...summary, artifacts }
}
