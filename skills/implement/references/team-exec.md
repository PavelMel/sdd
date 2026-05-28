# Agent-team execution (`team_mode: true`)

When the decision tree selects the team, the engine becomes a **lead** coordinating three roles through a shared task list, one git worktree per agent, with commits serialized by the lead. Use this for features with genuine parallel width and a desire for an independent review pass.

## Roles (the shipped subagents)

- **[`sdd-test-author`](../../../agents/sdd-test-author.md)** — RED only. Writes the failing test(s) for a task's `acs`, runs them, classifies the first run (GOOD/BAD/false-pass/NON-red per [`tdd-loop.md`](./tdd-loop.md)), and hands over the quoted failing line. Never writes production code.
- **[`sdd-implementer`](../../../agents/sdd-implementer.md)** — GREEN + REFACTOR + GATE. Takes a task with its red test, writes the minimal code to pass, refactors while green, runs the per-task gate. Never weakens the test.
- **[`sdd-reviewer`](../../../agents/sdd-reviewer.md)** — read-only. Two stages: stage-1 spec/AC compliance (does the change satisfy the `acs` it claims?), stage-2 quality (conventions, edge cases, anti-patterns). Has no write tools.

## Setup

1. Create the team (`TeamCreate`). Seed a shared **TaskList** from `tasks.json` — **the full task text goes in each task body** (title, `acs` text pulled from spec §5, `dod`, `files_hint`). Teammates do NOT read the plan or the conversation; the task body is their whole brief.
2. Give each agent its own git **worktree** under `.worktrees/<agent>` (`isolation: worktree` is required for the team — the guard enforces it). No two agents share a tree.
3. Set per-role **model + effort** from `model_*` / `effort_*` (roster defaults: test-author/implementer `sonnet`+`medium`, reviewer `opus`+`high` — see [`../../_shared/agent-roster.md`](../../_shared/agent-roster.md)). Apply the `.size` scaling (L/XL → execution effort `high`). Because the `effort:` frontmatter may be a no-op on some builds, also export `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_SUBAGENT_MODEL` for the dispatch. Print the resolved per-role model+effort in the banner.

## Flow per task

`sdd-test-author` (RED) → `sdd-implementer` (GREEN+REFACTOR+GATE) → `sdd-reviewer` (review). A task advances only when its `deps` are `done`. The lead pulls ready tasks off the DAG and assigns them; up to `max_parallel_agents` run at once.

## Serialization lanes (the lead enforces)

Even with worktrees, some tasks must not run concurrently:

- **`layer: migration`** — migrations are an ordered sequence (e.g. golang-migrate's numbered files); run them one at a time, in order.
- **Overlapping `files_hint`** — two tasks that touch the same file run in the same lane (serialized), or the second rebases on the first. Compute lanes from `files_hint` intersections up front.

Tasks in different lanes with satisfied deps run in parallel; tasks in the same lane queue.

## Commits

The lead **serializes commits in dependency order** regardless of when the work finished — pull each agent's worktree changes for a `done` task and commit them on the feature branch with the `SDD-Task`/`SDD-AC` trailers ([`tdd-loop.md`](./tdd-loop.md)). The history is linear and bisectable even though the work was concurrent.

## Don't over-orchestrate

- **<4 tasks → no team.** The eligibility check already forbids it; if you somehow got here with a tiny DAG, downgrade to sequential. Coordination overhead exceeds the gain.
- A red that survives escalation in one lane follows `stop_on_red`: halt the whole team, or drop that task + auto-block its dependents and let other lanes finish ([`escalation.md`](./escalation.md)).
- Tear the team down at the end; remove worktrees (they auto-clean if unchanged).
