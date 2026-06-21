---
name: sequences
model: inherit
effort: high
agents: []
description: >
  Use to add Mermaid sequenceDiagram blocks to the SAD's runtime view (sad.md §6) — one per
  critical flow, showing how a request moves between participants with happy + error paths.
  Triggers on "sequences for {slug}", "sequence diagram for {slug}", "draw the runtime flow",
  "add a sequence to the SAD", "/sdd:sequences {slug}", "діаграми послідовності {slug}",
  "sequence для {slug}", "намалюй потік {slug}". Reads sad.md §5 for participants, drafts each
  flow from templates/sequence.md with generic participants, walks them Socratically one flow at
  a time, and writes confirmed blocks into sad.md §6 — they inform data-model indexes downstream.
  Hard-refuse if sad.md is missing → run `design {slug}` first.
---

# Skill: sequences

Draws the **runtime view** of an already-designed feature: for each critical flow it produces a Mermaid `sequenceDiagram` block — generic participants, happy path plus the error branches the spec demands — and writes them into `docs/features/<slug>/sad.md §6`. One flow at a time, user confirms each. The diagrams are the bridge between the static design (§5 building blocks) and the data layer: every persist/read step you draw becomes a hint for the indexes `data-model` will need.

This skill keeps only its own machinery. Question phrasing is **shared** → [`../_shared/ask-style.md`](../_shared/ask-style.md). **Flow count is driven by the spec, not a cap** — every §4 user story / §5 acceptance criterion is covered (size may collapse *detail*, never *coverage*) → [`../_shared/size-matrix.md`](../_shared/size-matrix.md). Each diagram is **confirmed in prose, never as raw Mermaid** → [`../_shared/diagram-presentation.md`](../_shared/diagram-presentation.md); whether each flow is confirmed per-diagram or written-and-summarized follows the interview-depth setting → [`../_shared/interview-depth.md`](../_shared/interview-depth.md).

## Owner

Tech Lead (drives the runtime decomposition). The PM confirms that each drawn flow matches a real user story; a backend engineer flags persist steps that imply a new index.

## Inputs

- `<slug>` — same feature slug used by every earlier stage.
- **Gate (hard-refuse if missing):** `docs/features/<slug>/sad.md`. The §5 building-block view names the participants; §6 is where flows are written. If `sad.md` is absent → STOP and point: «run `design <slug>` first — sequences are written into its §6».
- (Expected) `sad.md` frontmatter `target_surfaces` — picks the participant vocabulary (UI-driven flows for a UI surface). **Absent or empty → warn** («surfaces undeclared — re-run `design`, or proceeding as `backend-service`») **and treat as `[backend-service]`** (→ [`../_shared/surfaces.md`](../_shared/surfaces.md)); never silently guess a UI surface.
- **Strongly expected:** `docs/features/<slug>/spec.md` — §4 user stories tell you *which* flows exist; §5 acceptance criteria are the **coverage floor** — every AC must be shown by a flow, a branch, or an explicit non-runtime N/A (the step-7 coverage check). Present by this stage in the normal pipeline; if genuinely absent, fall back to §6/§5 of `sad.md` for the flow list and note that AC-coverage can't be verified.
- (Optional) `docs/features/<slug>/.size` — depth hint for *detail* (XS/S may collapse a flow's internal steps), never for *coverage*. Absent → default to M **and say so loudly in the handoff** — «size M (default — no `.size`; run `/sdd:classify-size <slug>`)».
- (Optional) `.claude/sdd.local.md` `interview_depth` (else medium) — governs only the diagram-confirmation UX (per-diagram prose+ask vs. write+summarize-and-proceed); `sequences` does **not** open its own depth question (it honors the setting, or a `--depth=` arg if passed).

## Protocol

1. **Gate.** `test -f docs/features/<slug>/sad.md` → fail = refuse with the pointer above. Then read §5 (participants) and §6 (any flows already drawn — this skill is additive, never rewrite an existing block).
2. **Pick the flows — spec-driven, no cap.** List the flows from `spec.md` **§4 user stories + §5 acceptance criteria** (absent the spec, from §6 itself): **one flow per critical user story / distinct runtime path**. There is **no fixed cap** — draw as many flows as the user stories and ACs need (the old "3–5" cap silently under-covered). Then **plan AC coverage**: map every §5 AC to where it will be shown — a **dedicated flow**, an **`alt`/`else` branch** inside the relevant flow, or **explicitly non-runtime** (e.g. a middleware-enforced 401, a build-time check) with a one-line reason. Size only collapses *detail* (XS/S may show fewer internal steps per flow), never *coverage*. Confirm the flow list **and the AC→flow map** with one `AskUserQuestion` before drawing — phrasing per [`../_shared/ask-style.md`](../_shared/ask-style.md).
3. **Map participants — generic only.** For each flow, draw participants from a fixed generic vocabulary: `<client>`, `<ui>`, `<service>`, `<data-store>`, `<external-system>`, `<message-bus>`. Do **not** invent concrete service or technology names — those are `design`/`data-model` decisions, not runtime-view ones. **When `sad.md` frontmatter `target_surfaces` declares a UI surface** (`web-frontend` / `mobile-app` / `desktop-app`), draw the flows it touches as **UI-driven** — `<user>` (actor) → `<ui>` → `<service>` → `<data-store>` — so the user-visible step is shown, not just the service call (→ [`../_shared/surfaces.md`](../_shared/surfaces.md)). A backend-only / `cli` / `worker` feature keeps the service-level vocabulary (no `<ui>`). `<ui>` stays generic, like every other participant — never a framework or component name. If a flow needs a participant §5 never declared, note it («flow needs `<message-bus>`, not in §5 — flag for design») and still draw it.
4. **Sync vs async.** If the spec describes a webhook, scheduled job, queued/event-driven step, or any third-party callback → async: add an idempotency-key check as the handler's first step, a retry note (`Note over <service>,<external-system>: retry N times with backoff`), and a dead-letter branch in an `alt` after N failures. Otherwise → sync (request → response).
5. **Draft each flow** from [`./templates/sequence.md`](./templates/sequence.md): a precondition note, the happy-path messages, an `alt`/`else` for the error branches the spec's acceptance criteria require, and a postcondition note. Mark every write as a generic persist note — `Note over <service>,<data-store>: persists <entity>` — so `data-model` sees what to index. Keep messages verb-first and free of HTTP verbs / status numbers / SQL.
6. **Present + confirm each flow, one at a time — in prose, never raw Mermaid.** Per [`../_shared/diagram-presentation.md`](../_shared/diagram-presentation.md): for each drafted flow, **write the block into §6** under a `### <flow name>` heading (so Obsidian renders it), **validate** it parses per [`../_shared/mermaid-check.md`](../_shared/mermaid-check.md), then **describe it in prose** — the happy path plus every `alt`/`else` branch in plain words. **Never paste the raw `sequenceDiagram` source as the question.** Confirm by prose, governed by the interview-depth setting: at **medium/hard**, one `AskUserQuestion` per flow with the 4-state actions from [`../_shared/ask-style.md`](../_shared/ask-style.md) (Accept / Fix / Save-as-OQ / Drop) — on **Fix**, regenerate + overwrite that one block, re-validate, re-describe (one round, second answer final); on **Drop**, remove the block again. At **easy**, write + a one-line prose summary into the assumptions ledger and proceed (no per-flow question). Never touch a flow already present in §6. Maintain the edits-log per [`../_shared/socratic-loop.md`](../_shared/socratic-loop.md).
7. **Use-case + AC → flow coverage check (before finalizing).** Two passes, surfaced as one coverage table:
   - **Use-case pass (§4).** List **every §4 user story** and the flow(s) that realize it. Every retained user story maps to **≥1 flow** (a US with no flow is a gap — draft + confirm one, or de-scope it back through `specify`/`clarify`, never silently skip). `specify` already guarantees every §4 US carries ≥1 AC and `clarify` re-catches a US with none, so this pass is the runtime-view echo of that floor — both ends now checked, not just transitively assumed.
   - **AC pass (§5).** List **every §5 AC** and where it is now shown — a **dedicated flow**, an **`alt`/`else` branch**, or an **explicit non-runtime N/A** (with its one-line reason, e.g. «AC-7: middleware-enforced 401, not a runtime flow»).
   If a `Drop`/`Save-as-OQ` during step 6 left a user story or an AC uncovered, draft + confirm the missing flow or branch (the step 5–6 mini-loop) before proceeding, or record the explicit N/A with the user. **No §4 user story and no §5 AC may be silently uncovered.** (Completeness is independent of depth + size; this gate holds even at easy/XS.)
8. **Finalize: order, validate, propose commit.** Order the §6 blocks to match §4. **Re-validate every `sequenceDiagram` block per [`../_shared/mermaid-check.md`](../_shared/mermaid-check.md)** as the backstop (balanced `alt`/`else`/`end`, declared participants; fix any that don't parse before committing). Append any flagged items (new participants, decisions worth an ADR) as a short note at the end of §6 — flag only, never auto-write an ADR. Propose commit `sequences: <slug> runtime flows`. Then **emit the stage-handoff block** per [`../_shared/handoff.md`](../_shared/handoff.md) — *What I did* + *Review* (`sad.md` §6) + *Run next* (`/clear`, then `/sdd:data-model <slug>`, which uses the persist notes to choose indexes; **for XS/S with no schema change** — no new entity/column/index in any drawn flow — **add the fast-lane alternative** `↳ or /sdd:api <slug>`, per the [size-matrix fast lane](../_shared/size-matrix.md)).

## Definition of Done

- `sad.md §6` holds a Mermaid `sequenceDiagram` for **every** critical user story / distinct runtime path — **no fixed cap**; size may collapse a flow's internal detail, never its coverage.
- **Every §4 user story maps to ≥1 flow, and every §5 AC maps to a flow, an `alt`/`else` branch, or an explicit non-runtime N/A** — the step-7 coverage check passed on both passes (use-case + AC); nothing is silently uncovered (holds at every depth + size).
- Each flow was **confirmed in prose** (medium/hard) or **written + summarized** (easy) — never by pasting raw `sequenceDiagram` source as the question.
- Every block uses **only** generic participants (`<client>` / `<ui>` / `<service>` / `<data-store>` / `<external-system>` / `<message-bus>`) — no concrete technology or service names. A declared UI surface uses `<ui>` in a UI-driven flow (`<user>` → `<ui>` → `<service>` → `<data-store>`); a backend-only feature omits it.
- Each flow shows the error branches its spec acceptance criteria require, not happy-path only; every mutating step carries a generic persist note for `data-model`.
- Every async flow has an idempotency-key step, a retry note, and a dead-letter branch.
- Pre-existing §6 blocks are untouched; new participants / ADR-worthy decisions are flagged, not silently added.

## Anti-patterns

- **Concrete participants.** `Postgres`, `content-api`, a specific broker — the legacy trap. Participants stay generic; naming the tech is the job of `design`/`data-model`.
- **Capping the flow count** (the old "3–5") and silently under-covering. Flow count is driven by §4/§5 — every AC is shown by a flow, a branch, or an explicit N/A. A dogfood run that drew only 2 flows for a spec with 6 ACs is the exact failure this skill now forbids.
- **Pasting raw Mermaid as the confirmation.** `sequenceDiagram` source in the terminal is unreadable — the user approves blind. Confirm in prose; let Obsidian render the written block (per [`../_shared/diagram-presentation.md`](../_shared/diagram-presentation.md)).
- **Happy path only** when the spec lists explicit error acceptance criteria. Each flow gets happy + the demanded error branches.
- **One mega-diagram** for the whole feature. Split per flow; a cross-cutting flow gets its own `### Cross-cutting: <name>` heading.
- **Auto-writing ADRs.** This skill only flags decisions (idempotency strategy, retry shape, sync-vs-async); ADRs come from `decide-adr` or a human.
- **Rewriting an existing §6 block.** Additive only — editing a drawn flow is a deliberate manual diff.
- **Inventing a participant §5 never declared without flagging it.** §5 is the source of truth; the flag lets `design` reconcile it.

## References & template

- [`../_shared/ask-style.md`](../_shared/ask-style.md) — canonical question/option phrasing for steps 2 and 6.
- [`../_shared/diagram-presentation.md`](../_shared/diagram-presentation.md) — how each flow is confirmed (write → validate → prose-describe → confirm/proceed); never raw Mermaid as the question.
- [`../_shared/interview-depth.md`](../_shared/interview-depth.md) — the depth setting that governs per-flow ask vs. write-and-summarize (read from settings; sequences asks no depth question of its own).
- [`../_shared/mermaid-check.md`](../_shared/mermaid-check.md) — parse-validation run on each block at step 6 and again as the step-8 backstop.
- [`../_shared/size-matrix.md`](../_shared/size-matrix.md) — collapses a flow's *detail* for XS/S (never its *coverage* — every AC is still shown).
- [`../_shared/surfaces.md`](../_shared/surfaces.md) — a declared UI surface adds `<ui>` to the vocabulary and draws UI-driven flows; read from `sad.md` `target_surfaces`.
- [`./templates/sequence.md`](./templates/sequence.md) — generic-participant `sequenceDiagram` scaffold (sync + async), embedded inline in sad.md §6.
