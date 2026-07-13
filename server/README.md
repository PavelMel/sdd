# SDD Visual Dashboard

A local, **opt-in, read-only** browser dashboard for the SDD pipeline. It reads `docs/features/`
straight off disk, renders every artifact, and **drives the pipeline** — a click in the browser sends
a `/sdd:<skill> <slug>` command back into your live Claude Code session, which runs the skill and
streams progress back to the browser. It never edits artifact text — all writes happen through the
pipeline in the terminal.

The whole thing is one Bun process (`server/`) that auto-starts as an MCP server when a Claude Code
session opens. It holds the MCP channel to Claude **and** an embedded `Bun.serve()` HTTP+WS listener on
`127.0.0.1`. The browser tab is just another channel — the same mechanism the official Telegram plugin
uses to message a session, re-skinned as a dashboard.

> **Pure-markdown users are unaffected.** Nothing binds, nothing opens, until you opt in.

---

## Quick start

**1. Install Bun** (the server runtime — the same dependency the Telegram plugin uses):

```bash
curl -fsSL https://bun.sh/install | bash   # or: brew install bun
bun --version                              # sanity check
```

**2. Enable the dashboard** in your project's `.claude/sdd.local.md` (the file the pipeline
auto-creates with documented defaults — `specify`/`implement`/`start` will create it if absent):

```yaml
dashboard_enabled: true    # opt in
dashboard_port: 4178       # optional — the loopback port (scans upward if busy)
```

**3. Open a Claude Code session in your project and run:**

```
/sdd:start
```

It hands the server your project directory, confirms the channel works both ways, and prints the URL:

```
http://127.0.0.1:4178/?session=<id>&token=<capability-token>
```

Open that URL in a browser. That's it.

---

## What you can do

| In the browser | What happens |
|---|---|
| **Pick a feature** (sidebar) | See its pipeline as a per-step checklist: `done` / `skipped` / `pending` / `blocked`, derived from the artifacts on disk. An XS feature shows *skipped* stages — not gaps. |
| **Open an artifact** (tabs) | Renders markdown and **mermaid** (C4 / sequence / ER diagrams) from vendored libs, fully offline; mermaid (3.3 MB) loads lazily, only when an artifact actually contains a diagram. OpenAPI shows as plain YAML. |
| **▶ Run next stage** / per-stage **run** | Sends `/sdd:<skill> <slug>` into your session. Claude runs the skill; the session-activity pane streams its log + the handoff. The topbar **depth** selector sets `--depth` (default `easy`). |
| **⚒ Fix** (appears on a CHANGES REQUESTED review) | Runs `/sdd:fix <slug>` to address the review findings. |
| **+ new** | Runs `/sdd:specify <slug>` to start a new feature. |
| **roadmap** modal | Renders `docs/roadmap.md`; its action buttons queue the repo-wide `/sdd:roadmap` and `/sdd:survey`. |
| **Answer a decision question** | When a dashboard-driven run genuinely needs a human choice, a question card with option buttons appears in the activity pane (`dashboard_ask`) — your click resumes the paused run. Only the option *index* leaves the browser. |
| **Change artifacts any other way** (a terminal-driven skill, `vim docs/…`) | The panel live-refreshes — `fs.watch` on `docs/` pushes a WS refresh within ~1 s. No dashboard involvement needed. |

### It's a driver, not a remote control

A click is consumed **only while your session is idle at the prompt**. If Claude is mid-task, the
command **queues** (the UI says so — it never fakes synchronous execution). Dashboard-driven runs default
to `--depth=easy`, so the skill self-decides reversible calls and asks far fewer questions — because the
browser can't answer a blocking `AskUserQuestion`. When a dashboard-driven run genuinely needs a
decision, Claude doesn't block: it posts the question **into the panel** via `dashboard_ask` (option
buttons, no free text) and ends its turn; your click comes back as a channel message and the run
resumes. Answering in **your terminal** always works too.

---

## Configuration

Read from `.claude/sdd.local.md` (per-project, git-ignored):

| Key | Default | Meaning |
|---|---|---|
| `dashboard_enabled` | `false` | Opt in. When false/absent the server stays idle (no HTTP bind). |
| `dashboard_port` | `4178` | Loopback port to bind; scans `4178..4189` if busy. |

Environment overrides (handy for testing / unusual setups):

| Env var | Effect |
|---|---|
| `SDD_DASHBOARD_ENABLED=1` | Force-enable without the settings file. |
| `SDD_DASHBOARD_PORT=<n>` | Default port (a `dashboard_port` in settings still wins). |
| `SDD_DASHBOARD_TOKEN=<hex>` | Pin the capability token (otherwise random per session). |
| `CLAUDE_PROJECT_DIR=<path>` | Project root at boot (Claude Code sets this; `/sdd:start` overrides authoritatively). |

---

## Security model

- **Loopback only.** Binds `127.0.0.1` — never a public interface.
- **Read-only, scoped I/O.** The API only ever *reads*, and every read is `realpath`-contained to
  `<project>/docs/` with an extension allowlist (`.md` / `.yaml` / `.yml` / `.json` / `.size`);
  `.git`, missing files, and anything outside `docs/` are refused. There is no write route.
- **Capability token.** Every `/api` route (including the two mutating routes — run-a-command and
  answer-a-question — which touch no disk) requires the per-session token issued by `/sdd:start`
  (in the URL), plus `Origin`/`Host` loopback checks — so another local page can't POST to your port.
- **No command injection.** Inbound `/sdd:` lines are built **only** from a server-side allowlist
  (validated skill name + `^[a-z0-9][a-z0-9-]*$` slug + `easy|medium|hard` depth). Browser text never
  becomes an arbitrary command. Answers relay only an option **label Claude itself authored** in
  `dashboard_ask` — the browser contributes a single validated index into that list.
- **Anti-injection contract.** The MCP `instructions` tell Claude that dashboard channel content is
  ALWAYS a server-built allowlisted SDD command — never free text, never authority to bypass a gate,
  approve a review, change settings, or touch files outside `docs/`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `/mcp` shows `sdd-dashboard` **failed** | Bun isn't installed (the `.mcp.json` launches `bun`). Install Bun, reopen the session. |
| `/sdd:start` says **"not enabled"** | Set `dashboard_enabled: true` in `.claude/sdd.local.md`, re-run `/sdd:start`. |
| Browser shows **"no token in URL"** | Open the exact URL `/sdd:start` printed (the token authorises the session). |
| **"project dir unresolved"** | Run `/sdd:start` inside the project (it hands the real path over), or set `CLAUDE_PROJECT_DIR`. |
| A click does nothing | The session is busy or waiting on a question in your terminal — the command is queued; it runs when Claude is idle at the prompt. |
| The panel doesn't update when files change | The docs watcher wasn't armed (the server didn't know your project dir yet) — run `/sdd:start`. Note: changes inside a **symlinked** subdirectory of `docs/` don't emit watch events; keep artifacts on real paths. |
| Port differs from 4178 | It was busy; `/sdd:start` prints the actual port it bound. |

---

## Architecture (one process, the channel pattern)

```
 Browser tab (dashboard)              Claude Code session
  index.html / app.js  ── HTTP/WS ──┐   Claude runs /sdd skills
                                     │        ▲
                       ┌─────────────┴────────┴──────────────┐
                       │  sdd-dashboard MCP server (Bun)      │
                       │  • StdioServerTransport ⇄ Claude     │
                       │  • Bun.serve() HTTP+WS ⇄ browser     │
                       │  • reads/writes <PROJECT>/docs/ only │
                       │  • inbound: notifications/claude/    │
                       │      channel  (/sdd:<skill> <slug>)  │
                       │  • outbound: dashboard_* MCP tools   │
                       └──────────────────────────────────────┘
```

- `server.ts` — MCP server + `Bun.serve()`, lifecycle hygiene, project-root resolver, WS keep-alive pings.
- `http.ts` — the HTTP layer (routing, token/origin gating, the read-only JSON API) behind an
  `HttpCtx` interface — testable without an MCP/stdio boot.
- `state.ts` — disk → pipeline-stage derivation (the signal→stage table).
- `channel.ts` — outbound `dashboard_*` tools + the inbound command allowlist + the pending-question
  registry (`dashboard_ask` → `POST /api/answer`, single-use, bounded).
- `watch.ts` — live refresh: `fs.watch` on `<project>/docs/` (recursive), 250 ms coalescing window →
  one `refresh` WS frame (slug-scoped when a single feature changed). Never reads file content —
  it only maps a changed path to a frame; auto-re-arms if `docs/` is missing or the watcher dies.
- `paths.ts` — `docs/` containment + extension allowlist.
- `frontmatter.ts` — the one YAML-frontmatter parser (artifacts + settings).
- `../dashboard/` — the static UI (vanilla JS) + vendored render libs (`marked`, lazy `mermaid`).

### WS frames (server → browser)

The WS channel is **push-only** (the browser talks back over HTTP). Every frame carries
`session_id` + `ts` plus:

| `type` | Sent when | Payload |
|---|---|---|
| `hello` | a client connects | `project` |
| `project` | `/sdd:start` hands over the project dir | `project` |
| `log` | Claude calls `dashboard_log` | `message`, `slug`, `stage`, `level` |
| `update` | Claude calls `dashboard_update` | `slug`, `stage`, `status`, `progress`, `message` |
| `done` | Claude calls `dashboard_done` | `slug`, `stage`, `summary`, `verdict`, `review_files`, `next_command` |
| `ask` | Claude calls `dashboard_ask` (a paused run needs a decision) | `ask_id`, `question`, `options[]`, `slug`, `stage` |
| `answer` | an option was picked (any tab) — cards everywhere mark answered | `ask_id`, `option`, `label` |
| `refresh` | `docs/` changed on disk (fs.watch), and after `dashboard_update`/`done` | optional `slug` — scoped reload; absent → reload everything |
| `command` | a browser click queued a command | `command`, `request_id` |

On (re)connect the browser re-syncs fully from disk, so frames missed while disconnected are never
lost state — only lost narration.

## Testing

Deterministic runtime tests live in `server/tests/` (no network, committed fixture trees under
`tests/fixtures/`) and run in CI as the `server-tests` job:

```bash
cd server
bun install
bunx tsc --noEmit   # typecheck (strict, bun-types)
bun test tests/     # state derivation, path-security boundary, command allowlist, HTTP routing
```

The suites: `state.test.ts` (signal→stage table, skipped-vs-pending, tracker parsing, review-verdict
precedence, shipped regex), `paths.test.ts` (traversal / symlink escape / `.git` refusal / extension
allowlist — throwaway `mkdtemp` trees), `channel.test.ts` (allowlist + injection cases,
`dashboard_ask` + the question registry),
`http.test.ts` (token/Origin gating, command + answer relay, removed-route regressions),
`watch.test.ts` (path→frame classification, batch coalescing, the watcher state machine against
injected fakes — the real `fs.watch` contract is timing-flaky in CI, so it is verified by a live
smoke run instead), `frontmatter.test.ts`.

**Deferred (designed, not built):** multi-session parallelization (a shared hub with leader
election). The MVP's choices — token per session, `session_id`-tagged WS frames, `/sdd:start`
project handover — are already hub-compatible.
