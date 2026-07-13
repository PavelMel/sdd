/**
 * channel.ts — the command allowlist (the anti-injection chokepoint) and the
 * dashboard_* tool handlers against a fake broadcast.
 */
import { describe, it, expect } from 'bun:test'
import {
  buildCommand,
  handleDashboardTool,
  createAskRegistry,
  SKILL_NAMES,
  DASHBOARD_TOOLS,
  type Frame,
} from '../channel.ts'

describe('buildCommand allowlist', () => {
  it('builds a literal /sdd: line from validated parts, depth defaults to easy', () => {
    const b = buildCommand('specify', 'my-feature')
    expect(b).toEqual({
      content: '/sdd:specify my-feature --depth=easy',
      skill: 'specify',
      slug: 'my-feature',
    })
  })

  it('honours an explicit depth', () => {
    expect(buildCommand('design', 'x', { depth: 'hard' }).content).toBe(
      '/sdd:design x --depth=hard',
    )
  })

  it('rejects a skill outside the allowlist', () => {
    expect(() => buildCommand('rm', 'x')).toThrow(/not allowed/)
    expect(() => buildCommand('start', 'x')).toThrow(/not allowed/) // deliberately not driveable
    expect(SKILL_NAMES.has('implement')).toBe(true)
  })

  it('rejects injection through the skill name', () => {
    expect(() => buildCommand('specify; rm -rf /', 'x')).toThrow(/not allowed/)
    expect(() => buildCommand('specify --dangerously', 'x')).toThrow(/not allowed/)
  })

  it('rejects injection through the slug', () => {
    expect(() => buildCommand('specify', 'a b')).toThrow(/invalid slug/)
    expect(() => buildCommand('specify', 'x; rm')).toThrow(/invalid slug/)
    expect(() => buildCommand('specify', '../etc')).toThrow(/invalid slug/)
    expect(() => buildCommand('specify', '--depth=hard')).toThrow(/invalid slug/)
    expect(() => buildCommand('specify', '')).toThrow(/invalid slug/)
  })

  it('rejects injection through depth (the type lies — the value comes from a browser POST)', () => {
    const evil = 'easy --dangerously-skip-permissions' as 'easy'
    expect(() => buildCommand('specify', 'x', { depth: evil })).toThrow(/invalid depth/)
    expect(() => buildCommand('specify', 'x', { depth: '' as 'easy' })).toThrow(/invalid depth/)
  })
})

function fakeCtx() {
  const frames: Frame[] = []
  const asks = createAskRegistry()
  let n = 0
  return {
    frames,
    asks,
    ctx: { broadcast: (f: Frame) => frames.push(f), asks, askId: () => `ask-${++n}` },
  }
}

describe('handleDashboardTool', () => {
  it('dashboard_update broadcasts an update + a refresh', () => {
    const { frames, ctx } = fakeCtx()
    const res = handleDashboardTool(
      'dashboard_update',
      { slug: 's', stage: 'design', status: 'done' },
      ctx,
    )
    expect(res?.isError).toBeUndefined()
    expect(frames.map((f) => f.type)).toEqual(['update', 'refresh'])
    expect(frames[0]).toMatchObject({ slug: 's', stage: 'design', status: 'done' })
  })

  it('dashboard_log defaults level to info', () => {
    const { frames, ctx } = fakeCtx()
    handleDashboardTool('dashboard_log', { message: 'working…' }, ctx)
    expect(frames).toEqual([
      { type: 'log', message: 'working…', slug: null, stage: null, level: 'info' },
    ])
  })

  it('dashboard_done broadcasts the handoff + a refresh', () => {
    const { frames, ctx } = fakeCtx()
    const res = handleDashboardTool(
      'dashboard_done',
      { slug: 's', stage: 'review', summary: 'ok', verdict: 'PASS' },
      ctx,
    )
    expect(res?.content[0].text).toContain('handoff')
    expect(frames.map((f) => f.type)).toEqual(['done', 'refresh'])
    expect(frames[0]).toMatchObject({ verdict: 'PASS', review_files: [] })
  })

  it('returns null for a non-dashboard tool name', () => {
    const { frames, ctx } = fakeCtx()
    expect(handleDashboardTool('dashboard_handshake', {}, ctx)).toBeNull()
    expect(handleDashboardTool('something_else', {}, ctx)).toBeNull()
    expect(frames).toEqual([])
  })

  it('dashboard_chat is gone (read-only dashboard has no chat surface)', () => {
    const { frames, ctx } = fakeCtx()
    expect(DASHBOARD_TOOLS.map((t) => t.name)).toEqual([
      'dashboard_update',
      'dashboard_log',
      'dashboard_ask',
      'dashboard_done',
    ])
    expect(handleDashboardTool('dashboard_chat', { text: 'hi' }, ctx)).toBeNull()
    expect(frames).toEqual([])
  })
})

describe('dashboard_ask', () => {
  const OPTS = [{ label: 'REST' }, { label: 'GraphQL', description: 'heavier' }]

  it('registers the question and broadcasts an ask frame with the id + options', () => {
    const { frames, asks, ctx } = fakeCtx()
    const res = handleDashboardTool(
      'dashboard_ask',
      { question: 'API style?', options: OPTS, slug: 's', stage: 'design' },
      ctx,
    )
    expect(res?.isError).toBeUndefined()
    expect(res?.content[0].text).toContain('ask-1')
    expect(res?.content[0].text).toContain('END YOUR TURN')
    expect(frames).toEqual([
      {
        type: 'ask',
        ask_id: 'ask-1',
        question: 'API style?',
        options: OPTS,
        slug: 's',
        stage: 'design',
      },
    ])
    expect(asks.take('ask-1')).toMatchObject({ id: 'ask-1', question: 'API style?', slug: 's' })
  })

  it('rejects an empty question, missing labels, and option counts outside 2-4', () => {
    const { frames, asks, ctx } = fakeCtx()
    expect(() => handleDashboardTool('dashboard_ask', { question: '  ', options: OPTS }, ctx)).toThrow(/question/)
    expect(() => handleDashboardTool('dashboard_ask', { question: 'q', options: [{ label: 'a' }] }, ctx)).toThrow(/2-4/)
    expect(() =>
      handleDashboardTool(
        'dashboard_ask',
        { question: 'q', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }] },
        ctx,
      ),
    ).toThrow(/2-4/)
    expect(() => handleDashboardTool('dashboard_ask', { question: 'q', options: [{ label: 'a' }, {}] }, ctx)).toThrow(
      /label/,
    )
    expect(frames).toEqual([]) // nothing broadcast on any refusal
    expect(asks.size()).toBe(0) // nothing registered either
  })
})

describe('createAskRegistry', () => {
  const ask = (id: string) => ({ id, slug: null, stage: null, question: 'q', options: [{ label: 'a' }, { label: 'b' }] })

  it('take() is single-use', () => {
    const reg = createAskRegistry()
    reg.register(ask('a1'))
    expect(reg.take('a1')?.id).toBe('a1')
    expect(reg.take('a1')).toBeNull()
    expect(reg.take('nope')).toBeNull()
  })

  it('is bounded — the oldest pending question is evicted past the cap', () => {
    const reg = createAskRegistry()
    for (let i = 0; i < 25; i++) reg.register(ask(`a${i}`))
    expect(reg.size()).toBe(20)
    expect(reg.take('a0')).toBeNull() // evicted
    expect(reg.take('a24')?.id).toBe('a24') // newest survives
  })
})
