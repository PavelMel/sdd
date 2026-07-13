/**
 * Live dashboard refresh — fs.watch on <PROJECT>/docs/ → WS `refresh` frames.
 *
 * Closes the gap the explicit refresh frames leave open: dashboard_update/done
 * push a refresh only when Claude calls them, so a terminal-driven run (or a
 * plain `vim docs/…`) never reached the browser. This watcher makes ANY change
 * under docs/ push a refresh — the same frame type the browser already handles,
 * no new protocol.
 *
 * The watcher never reads disk content — it only maps a changed path to a
 * refresh frame (slug-scoped when one feature changed, slugless otherwise).
 * All actual reads still go through the HTTP API and assertArtifactPath.
 *
 * fs.watch and the timers are injected so the whole state machine is
 * unit-testable without a real filesystem or real time (see tests/watch.test.ts).
 */

import { watch } from 'fs'
import { join } from 'path'
import { isValidSlug } from './paths.ts'
import type { Frame } from './channel.ts'

// ---- pure path → frame logic -------------------------------------------------

export type Classification = { scope: 'feature'; slug: string } | { scope: 'root' }

// Editor/OS noise that must never trigger a refresh: git internals, Finder
// droppings, backup/swap/lock files, vim's `4913` write-probe.
const IGNORED_BASENAME = /^(\.DS_Store|4913|#.*#)$|(~|\.sw[px]|\.tmp)$|^\.#/

/**
 * Map an fs.watch-relative path (relative to docs/) to a refresh scope.
 * Returns null for noise that should not refresh anything. A null filename
 * (fs.watch may omit it) conservatively refreshes everything.
 */
export function classifyPath(rel: string | null): Classification | null {
  if (rel == null) return { scope: 'root' }
  const segments = rel.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return { scope: 'root' }
  if (segments.includes('.git')) return null
  const base = segments[segments.length - 1]
  if (IGNORED_BASENAME.test(base)) return null
  if (segments[0] === 'features') {
    if (segments.length === 1) return { scope: 'root' } // the features/ dir itself
    const slug = segments[1]
    if (!isValidSlug(slug)) return null
    return { scope: 'feature', slug }
  }
  return { scope: 'root' } // roadmap.md, architecture-map.md, anything docs-root
}

/**
 * Collapse a batch window's classifications into at most one refresh frame:
 * exactly one feature touched → slug-scoped; anything wider → slugless (the
 * browser's refresh(undefined) reloads everything).
 */
export function coalesce(batch: Classification[]): Frame[] {
  if (batch.length === 0) return []
  const slugs = new Set<string>()
  let root = false
  for (const c of batch) {
    if (c.scope === 'feature') slugs.add(c.slug)
    else root = true
  }
  if (!root && slugs.size === 1) return [{ type: 'refresh', slug: slugs.values().next().value }]
  return [{ type: 'refresh' }]
}

// ---- injectable effects --------------------------------------------------------

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type WatchImpl = (
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: (err: unknown) => void,
) => { close(): void }

const defaultSchedule: Scheduler = {
  setTimeout(fn, ms) {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

const defaultWatchImpl: WatchImpl = (dir, onEvent, onError) => {
  // Bun supports {recursive:true} on macOS and Linux. Throws ENOENT if the dir
  // is missing — the caller's retry loop handles it.
  const w = watch(dir, { recursive: true }, (_event, filename) => {
    onEvent(filename == null ? null : String(filename))
  })
  w.on('error', onError)
  return {
    close() {
      try {
        w.close()
      } catch {}
    },
  }
}

// ---- the watcher state machine --------------------------------------------------

export interface DocsWatcher {
  /** Watch <projectDir>/docs. Idempotent for the same dir; re-arms for a new one. */
  arm(projectDir: string): void
  /** Terminal — close the watcher and cancel all timers. */
  stop(): void
}

export interface WatcherOpts {
  broadcast: (frame: Frame) => void
  log: (msg: string) => void
  /** Batch window: events within it collapse to one frame. Fixed, not resettable —
   *  a steady write stream (implement stage) must not starve the flush. */
  windowMs?: number
  /** Re-arm interval while docs/ is missing or after the watcher dies. */
  retryMs?: number
  watchImpl?: WatchImpl
  schedule?: Scheduler
}

export function createDocsWatcher(opts: WatcherOpts): DocsWatcher {
  const windowMs = opts.windowMs ?? 250
  const retryMs = opts.retryMs ?? 2000
  const watchImpl = opts.watchImpl ?? defaultWatchImpl
  const schedule = opts.schedule ?? defaultSchedule

  let armedDir: string | null = null
  let active: { close(): void } | null = null
  let retryTimer: unknown = null
  let batchTimer: unknown = null
  let batch: Classification[] = []
  let resyncOnOpen = false // after a watcher death, one slugless refresh covers the gap
  let stopped = false

  function clearRetry(): void {
    if (retryTimer != null) {
      schedule.clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function clearBatch(): void {
    if (batchTimer != null) {
      schedule.clearTimeout(batchTimer)
      batchTimer = null
    }
    batch = []
  }

  function flush(): void {
    batchTimer = null
    const frames = coalesce(batch)
    batch = []
    for (const frame of frames) opts.broadcast(frame)
  }

  function onEvent(filename: string | null): void {
    const c = classifyPath(filename)
    if (c == null) return
    batch.push(c)
    if (batchTimer == null) batchTimer = schedule.setTimeout(flush, windowMs)
  }

  function onError(err: unknown): void {
    if (stopped) return
    opts.log(`docs watcher died (${err}) — re-arming`)
    active?.close()
    active = null
    resyncOnOpen = true
    scheduleRetry()
  }

  function scheduleRetry(): void {
    if (stopped || retryTimer != null) return
    retryTimer = schedule.setTimeout(() => {
      retryTimer = null
      tryOpen()
    }, retryMs)
  }

  function tryOpen(): void {
    if (stopped || active != null || armedDir == null) return
    try {
      active = watchImpl(armedDir, onEvent, onError)
      opts.log(`watching ${armedDir}`)
      if (resyncOnOpen) {
        resyncOnOpen = false
        opts.broadcast({ type: 'refresh' }) // cover whatever changed while dead
      }
    } catch {
      // docs/ missing (pre-specify project) or transient — retry quietly.
      scheduleRetry()
    }
  }

  return {
    arm(projectDir: string): void {
      if (stopped) return
      const docs = join(projectDir, 'docs')
      if (docs === armedDir && active != null) return
      if (docs !== armedDir) {
        active?.close()
        active = null
        clearBatch()
        clearRetry()
        armedDir = docs
      }
      tryOpen()
    },
    stop(): void {
      stopped = true
      clearRetry()
      clearBatch()
      active?.close()
      active = null
    },
  }
}
