/**
 * watch.ts — the path→frame classification, batch coalescing, and the watcher
 * state machine against injected fakes (no real filesystem, no real time).
 *
 * The real fs.watch contract (Bun, recursive on macOS/Linux) is deliberately
 * NOT exercised here — timing-dependent and flaky in CI; it is verified by a
 * live smoke run instead. Everything we wrote is covered deterministically.
 */
import { describe, it, expect } from 'bun:test'
import { classifyPath, coalesce, createDocsWatcher, type Classification, type Scheduler, type WatchImpl } from '../watch.ts'
import type { Frame } from '../channel.ts'

// ---- classifyPath ------------------------------------------------------------

describe('classifyPath', () => {
  it('maps feature paths to their slug, at any depth', () => {
    expect(classifyPath('features/checkout/spec.md')).toEqual({ scope: 'feature', slug: 'checkout' })
    expect(classifyPath('features/my-feature-2/contracts/api.yaml')).toEqual({
      scope: 'feature',
      slug: 'my-feature-2',
    })
    expect(classifyPath('features/x')).toEqual({ scope: 'feature', slug: 'x' })
  })

  it('maps docs-root files to root scope', () => {
    expect(classifyPath('roadmap.md')).toEqual({ scope: 'root' })
    expect(classifyPath('architecture-map.md')).toEqual({ scope: 'root' })
    expect(classifyPath('notes/scratch.md')).toEqual({ scope: 'root' })
    expect(classifyPath('features')).toEqual({ scope: 'root' }) // the dir itself
  })

  it('a null filename (fs.watch may omit it) conservatively refreshes everything', () => {
    expect(classifyPath(null)).toEqual({ scope: 'root' })
  })

  it('ignores editor/OS noise', () => {
    expect(classifyPath('features/x/.spec.md.swp')).toBeNull()
    expect(classifyPath('features/x/.spec.md.swx')).toBeNull()
    expect(classifyPath('features/x/spec.md~')).toBeNull()
    expect(classifyPath('features/x/spec.tmp')).toBeNull()
    expect(classifyPath('.DS_Store')).toBeNull()
    expect(classifyPath('features/x/.DS_Store')).toBeNull()
    expect(classifyPath('features/x/4913')).toBeNull() // vim write-probe
    expect(classifyPath('features/x/.#spec.md')).toBeNull() // emacs lock
    expect(classifyPath('features/x/#spec.md#')).toBeNull() // emacs autosave
  })

  it('ignores anything under .git', () => {
    expect(classifyPath('.git/index')).toBeNull()
    expect(classifyPath('features/x/.git/HEAD')).toBeNull()
  })

  it('rejects an invalid slug', () => {
    expect(classifyPath('features/Bad Slug/spec.md')).toBeNull()
    expect(classifyPath('features/-leading/spec.md')).toBeNull()
    expect(classifyPath('features/UPPER/spec.md')).toBeNull()
  })

  it('handles windows-style separators', () => {
    expect(classifyPath('features\\x\\spec.md')).toEqual({ scope: 'feature', slug: 'x' })
  })
})

// ---- coalesce ------------------------------------------------------------------

describe('coalesce', () => {
  const feat = (slug: string): Classification => ({ scope: 'feature', slug })
  const root: Classification = { scope: 'root' }

  it('one slug → one slug-scoped refresh', () => {
    expect(coalesce([feat('x'), feat('x'), feat('x')])).toEqual([{ type: 'refresh', slug: 'x' }])
  })

  it('two slugs → one slugless refresh (reload everything)', () => {
    expect(coalesce([feat('x'), feat('y')])).toEqual([{ type: 'refresh' }])
  })

  it('root + slug → slugless refresh', () => {
    expect(coalesce([root, feat('x')])).toEqual([{ type: 'refresh' }])
    expect(coalesce([root])).toEqual([{ type: 'refresh' }])
  })

  it('empty batch → no frames', () => {
    expect(coalesce([])).toEqual([])
  })
})

// ---- createDocsWatcher (injected fakes) ------------------------------------------

function fakeScheduler() {
  let nextId = 1
  const queue: Array<{ id: number; fn: () => void; ms: number }> = []
  const schedule: Scheduler = {
    setTimeout(fn, ms) {
      const id = nextId++
      queue.push({ id, fn, ms })
      return id
    },
    clearTimeout(handle) {
      const i = queue.findIndex((t) => t.id === handle)
      if (i >= 0) queue.splice(i, 1)
    },
  }
  // Run everything currently queued (timers scheduled DURING a flush stay queued).
  const flush = () => {
    for (const t of queue.splice(0)) t.fn()
  }
  return { schedule, queue, flush }
}

type FakeWatcher = {
  dir: string
  closed: boolean
  emit: (filename: string | null) => void
  fail: (err: unknown) => void
}

function fakeWatchImpl() {
  const watchers: FakeWatcher[] = []
  let failNext: Error | null = null
  const impl: WatchImpl = (dir, onEvent, onError) => {
    if (failNext) {
      const e = failNext
      failNext = null
      throw e
    }
    const w: FakeWatcher = {
      dir,
      closed: false,
      emit: onEvent,
      fail: onError,
    }
    watchers.push(w)
    return {
      close() {
        w.closed = true
      },
    }
  }
  return { impl, watchers, setFailNext: (e: Error) => (failNext = e) }
}

function harness() {
  const frames: Frame[] = []
  const logs: string[] = []
  const timers = fakeScheduler()
  const fw = fakeWatchImpl()
  const watcher = createDocsWatcher({
    broadcast: (f) => frames.push(f),
    log: (m) => logs.push(m),
    watchImpl: fw.impl,
    schedule: timers.schedule,
  })
  return { watcher, frames, logs, timers, fw }
}

describe('createDocsWatcher', () => {
  it('watches <project>/docs and pushes a slug-scoped refresh after the batch window', () => {
    const h = harness()
    h.watcher.arm('/proj')
    expect(h.fw.watchers).toHaveLength(1)
    expect(h.fw.watchers[0].dir).toBe('/proj/docs')

    h.fw.watchers[0].emit('features/x/spec.md')
    expect(h.frames).toEqual([]) // nothing until the window closes
    h.timers.flush()
    expect(h.frames).toEqual([{ type: 'refresh', slug: 'x' }])
  })

  it('batches a burst into one frame; mixed slugs go slugless', () => {
    const h = harness()
    h.watcher.arm('/proj')
    const w = h.fw.watchers[0]
    w.emit('features/x/spec.md')
    w.emit('features/x/design.md')
    w.emit('features/y/spec.md')
    expect(h.timers.queue).toHaveLength(1) // one pending flush, window not reset
    h.timers.flush()
    expect(h.frames).toEqual([{ type: 'refresh' }])
  })

  it('ignored paths schedule nothing', () => {
    const h = harness()
    h.watcher.arm('/proj')
    h.fw.watchers[0].emit('features/x/.spec.md.swp')
    h.fw.watchers[0].emit('.git/index')
    expect(h.timers.queue).toHaveLength(0)
    h.timers.flush()
    expect(h.frames).toEqual([])
  })

  it('retries when docs/ is missing (ENOENT) and arms once it appears', () => {
    const h = harness()
    h.fw.setFailNext(new Error('ENOENT'))
    h.watcher.arm('/proj')
    expect(h.fw.watchers).toHaveLength(0)
    expect(h.timers.queue).toHaveLength(1) // retry pending

    h.timers.flush() // retry fires → open succeeds
    expect(h.fw.watchers).toHaveLength(1)
    expect(h.fw.watchers[0].dir).toBe('/proj/docs')
    expect(h.frames).toEqual([]) // first open is not a resync
  })

  it('arm is idempotent for the same project dir', () => {
    const h = harness()
    h.watcher.arm('/proj')
    h.watcher.arm('/proj')
    h.watcher.arm('/proj/')
    expect(h.fw.watchers).toHaveLength(1)
    expect(h.fw.watchers[0].closed).toBe(false)
  })

  it('re-arms onto a different project dir, closing the old watcher', () => {
    const h = harness()
    h.watcher.arm('/proj-a')
    h.watcher.arm('/proj-b')
    expect(h.fw.watchers).toHaveLength(2)
    expect(h.fw.watchers[0].closed).toBe(true)
    expect(h.fw.watchers[1].dir).toBe('/proj-b/docs')
  })

  it('a dying watcher re-arms and pushes one slugless refresh to cover the gap', () => {
    const h = harness()
    h.watcher.arm('/proj')
    h.fw.watchers[0].fail(new Error('EPERM'))
    expect(h.fw.watchers[0].closed).toBe(true)
    expect(h.frames).toEqual([]) // resync only after the re-open succeeds

    h.timers.flush() // retry fires → reopen
    expect(h.fw.watchers).toHaveLength(2)
    expect(h.frames).toEqual([{ type: 'refresh' }])

    // and the new watcher works
    h.fw.watchers[1].emit('features/z/tasks.json')
    h.timers.flush()
    expect(h.frames).toEqual([{ type: 'refresh' }, { type: 'refresh', slug: 'z' }])
  })

  it('stop() closes the watcher and cancels pending timers', () => {
    const h = harness()
    h.watcher.arm('/proj')
    h.fw.watchers[0].emit('features/x/spec.md') // pending flush
    h.watcher.stop()
    expect(h.fw.watchers[0].closed).toBe(true)
    expect(h.timers.queue).toHaveLength(0)
    h.timers.flush()
    expect(h.frames).toEqual([])

    h.watcher.arm('/proj') // stop is terminal
    expect(h.fw.watchers).toHaveLength(1)
  })
})
