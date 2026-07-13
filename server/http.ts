/**
 * HTTP layer of the SDD dashboard server — routing, token/origin gating, and
 * the read-only API. Extracted from server.ts so the whole surface is testable
 * with a plain fetch handler + a fake ctx (no MCP/stdio boot required).
 *
 * The API is READ-ONLY over docs/ (features, artifacts, roadmap) plus exactly
 * two mutating routes, neither of which touches disk: POST /api/command relays
 * a server-built, allowlisted /sdd: line into the live session; POST
 * /api/answer relays the picked option of a pending dashboard_ask question
 * (option label text authored by Claude itself — never browser free text).
 */

import { readFileSync, statSync } from 'fs'
import {
  getProjectDir,
  requireProjectDir,
  assertArtifactPath,
  contentTypeFor,
  safeStaticPath,
  isValidSlug,
} from './paths.ts'
import { listFeatures, getFeatureDetail, getRoadmap } from './state.ts'
import { buildCommand, type Frame, type AskRegistry } from './channel.ts'

export interface HttpCtx {
  token: string
  sessionId: string
  staticRoot: string
  boundPort: () => number | null
  readConfig: () => { enabled: boolean; port: number }
  broadcast: (frame: Frame) => void
  /** Push an inbound channel notification to the live session (MCP). */
  notify: (params: { content: string; meta: Record<string, unknown> }) => void
  /** Random id for command correlation (injected for determinism in tests). */
  requestId: () => string
  /** Pending dashboard_ask questions (registered by the MCP tool handler). */
  asks: AskRegistry
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function tokenOk(ctx: HttpCtx, url: URL, req: Request): boolean {
  const t = url.searchParams.get('token') || req.headers.get('x-sdd-token') || ''
  return t.length > 0 && t === ctx.token
}

export function loopbackOk(req: Request): boolean {
  // Host must be loopback (it always is — we bind 127.0.0.1 — but check anyway).
  const host = (req.headers.get('host') || '').split(':')[0]
  if (host && host !== '127.0.0.1' && host !== 'localhost') return false
  // Origin, when present, must be our own loopback origin (defence in depth for
  // mutating routes — a cross-site POST would carry a foreign Origin).
  const origin = req.headers.get('origin')
  if (origin) {
    try {
      const o = new URL(origin)
      if (o.hostname !== '127.0.0.1' && o.hostname !== 'localhost') return false
    } catch {
      return false
    }
  }
  return true
}

export type Upgrader = { upgrade: (r: Request, o: { data: { session: string | null } }) => boolean }

export function createFetchHandler(ctx: HttpCtx) {
  return async function handleHttp(req: Request, server: Upgrader): Promise<Response | undefined> {
    const url = new URL(req.url)
    const path = url.pathname

    // --- WebSocket upgrade (push channel) ---
    if (path === '/ws') {
      if (!tokenOk(ctx, url, req)) return new Response('unauthorized', { status: 401 })
      if (server.upgrade(req, { data: { session: url.searchParams.get('session') } })) return undefined
      return new Response('expected websocket', { status: 426 })
    }

    // --- API (token-gated) ---
    if (path.startsWith('/api/')) {
      if (!tokenOk(ctx, url, req)) return json({ error: 'unauthorized' }, 401)
      try {
        return await handleApi(ctx, req, url, path)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return json({ error: msg }, 400)
      }
    }

    // --- static dashboard assets (no token — just the app shell) ---
    if (req.method === 'GET' || req.method === 'HEAD') {
      const rel = path === '/' ? '/index.html' : path
      const file = safeStaticPath(ctx.staticRoot, rel)
      if (file) {
        return new Response(Bun.file(file), {
          headers: { 'cache-control': 'no-cache' },
        })
      }
    }
    return new Response('not found', { status: 404 })
  }
}

async function handleApi(ctx: HttpCtx, req: Request, url: URL, path: string): Promise<Response> {
  // GET /api/meta — connection sanity (project resolved? session?)
  if (path === '/api/meta' && req.method === 'GET') {
    const cfg = ctx.readConfig()
    return json({
      session_id: ctx.sessionId,
      project: getProjectDir(),
      enabled: cfg.enabled,
      port: ctx.boundPort(),
    })
  }

  // GET /api/features
  if (path === '/api/features' && req.method === 'GET') {
    requireProjectDir()
    return json({ project: getProjectDir(), features: listFeatures() })
  }

  // GET /api/roadmap
  if (path === '/api/roadmap' && req.method === 'GET') {
    requireProjectDir()
    return json(getRoadmap())
  }

  // GET /api/artifact?slug=&path=
  if (path === '/api/artifact' && req.method === 'GET') {
    requireProjectDir()
    const slug = url.searchParams.get('slug')
    const rel = url.searchParams.get('path')
    if (!rel) return json({ error: 'path required' }, 400)
    const abs = assertArtifactPath(slug && slug.length ? slug : null, rel)
    const data = readFileSync(abs)
    const st = statSync(abs)
    return new Response(data, {
      headers: {
        'content-type': contentTypeFor(abs),
        'x-sdd-mtime': String(Math.round(st.mtimeMs)),
        'cache-control': 'no-store',
      },
    })
  }

  // GET /api/feature/:slug
  const detailMatch = path.match(/^\/api\/feature\/([^/]+)$/)
  if (detailMatch && req.method === 'GET') {
    requireProjectDir()
    const slug = decodeURIComponent(detailMatch[1])
    if (!isValidSlug(slug)) return json({ error: 'invalid slug' }, 400)
    const detail = getFeatureDetail(slug)
    if (!detail) return json({ error: 'no such feature' }, 404)
    return json(detail)
  }

  // POST /api/command  { slug, command, depth? }  → inbound /sdd: line.
  // The ONLY mutating route — and it mutates nothing on disk; it relays a
  // server-built allowlisted command into the session.
  if (path === '/api/command' && req.method === 'POST') {
    if (!loopbackOk(req)) return json({ error: 'forbidden origin' }, 403)
    requireProjectDir()
    const body = (await req.json()) as { slug?: string; command?: string; depth?: 'easy' | 'medium' | 'hard' }
    const built = buildCommand(String(body.command ?? ''), String(body.slug ?? ''), { depth: body.depth })
    const requestId = ctx.requestId()
    const ts = new Date().toISOString()
    ctx.notify({
      content: built.content,
      meta: {
        source: 'sdd-dashboard',
        session_id: ctx.sessionId,
        slug: built.slug,
        stage: built.skill,
        request_id: requestId,
        ts,
      },
    })
    ctx.broadcast({
      type: 'command',
      slug: built.slug,
      stage: built.skill,
      command: built.content,
      request_id: requestId,
      status: 'queued',
    })
    return json({ ok: true, queued: true, request_id: requestId, command: built.content }, 202)
  }

  // POST /api/answer  { ask_id, option }  → the user's pick for a dashboard_ask
  // question. Touches no disk. The relayed content quotes the option LABEL that
  // Claude itself authored in dashboard_ask — the browser contributes only the
  // index, so this route cannot smuggle free text into the session.
  if (path === '/api/answer' && req.method === 'POST') {
    if (!loopbackOk(req)) return json({ error: 'forbidden origin' }, 403)
    const body = (await req.json()) as { ask_id?: string; option?: number }
    const ask = ctx.asks.take(String(body.ask_id ?? ''))
    if (!ask) return json({ error: 'no such pending question (already answered or expired)' }, 404)
    const idx = Number(body.option)
    if (!Number.isInteger(idx) || idx < 0 || idx >= ask.options.length) {
      ctx.asks.register(ask) // still unanswered — put it back
      return json({ error: 'invalid option index' }, 400)
    }
    const picked = ask.options[idx]
    const where = ask.slug ? ` (${ask.stage ?? 'stage'} ${ask.slug})` : ''
    ctx.notify({
      content:
        `Dashboard answer to question ${ask.id}${where}: "${picked.label}" — ` +
        `continue the paused run with this decision.`,
      meta: {
        source: 'sdd-dashboard',
        session_id: ctx.sessionId,
        kind: 'answer',
        ask_id: ask.id,
        slug: ask.slug,
        stage: ask.stage,
        option: idx,
        ts: new Date().toISOString(),
      },
    })
    ctx.broadcast({ type: 'answer', ask_id: ask.id, option: idx, label: picked.label })
    return json({ ok: true, ask_id: ask.id, option: idx }, 202)
  }

  return json({ error: 'not found' }, 404)
}
