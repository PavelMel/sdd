# Settings — `.claude/sdd.local.md` (step 2)

The engine is configured per-project by a plugin-settings file with YAML frontmatter. On first run, **lazy-create** it with the defaults below and tell the user where it is; on later runs, read it.

## Lazy-create on first run

1. If `.claude/sdd.local.md` is absent, write it with the default frontmatter (below) + a one-line markdown body explaining it.
2. Patch `.gitignore` (create if absent) to include `.claude/*.local.md` and `.worktrees/` — these are per-developer and must not be committed.
3. Tell the user: «Wrote `.claude/sdd.local.md` with defaults — edit it to change how `implement` behaves.»

## Default frontmatter

```yaml
tdd: true                  # enforce red→green→refactor
team_mode: false           # true → agent team via TeamCreate
workflow_mode: auto        # auto → dynamic Workflow; off → never
max_parallel_agents: 3
isolation: worktree        # worktree | inplace (parallel>1 ⇒ forces worktree)
stop_on_red: true          # halt on a red that survives escalation, vs drop-and-continue
max_red_retries: 3
gate_lint: true
gate_vet: true
require_integration: auto  # auto | always | never (Docker-probed)
auto_commit: per_task      # per_task | per_phase | off
branch_strategy: feature   # feature | current
cmd_test_unit: ""          # empty = autodetect (escape hatch)
cmd_test_integration: ""
cmd_lint: ""
cmd_vet: ""
model_test_author: sonnet     # per-role model (see _shared/agent-roster.md); inherit = session model
model_implementer: sonnet
model_reviewer: opus
effort_test_author: medium    # per-role effort; raised to high on escalation
effort_implementer: medium
effort_reviewer: high
```

## What each key does

- **`tdd`** — when false, RED is skipped and the engine writes code directly (warns; you lose the safety net).
- **`team_mode` / `workflow_mode`** — feed the decision tree (see [`decision-tree.md`](./decision-tree.md)). `team_mode` wins when both could apply.
- **`max_parallel_agents`** — fan-out cap for team/workflow modes. `1` forces sequential.
- **`isolation`** — `worktree` gives each parallel agent its own git worktree under `.worktrees/`; `inplace` edits the checkout directly and **forces parallelism to 1**.
- **`stop_on_red`** — `true`: a red that survives escalation halts the run. `false`: drop that task, auto-block its dependents, continue other branches.
- **`max_red_retries`** — RED→GREEN attempts before escalation (see [`escalation.md`](./escalation.md)).
- **`gate_lint` / `gate_vet`** — include lint / vet in the per-task gate (skipped gracefully if no command is detected — see [`command-detection.md`](./command-detection.md)).
- **`require_integration`** — `auto`: run integration tests if a Docker daemon answers, else mark NON-red; `always`: BLOCK before dispatch if Docker is absent; `never`: skip the integration tier entirely.
- **`auto_commit`** — `per_task` (default), `per_phase`, or `off` (leave commits to the user).
- **`branch_strategy`** — `feature`: ensure work is on a feature branch (create one if on the default branch); `current`: commit on the current branch.
- **`cmd_*`** — explicit command overrides; non-empty values short-circuit detection (the escape hatch for unusual repos).
- **`model_*` / `effort_*`** — per-role model + effort for the three agents, applied when the engine spawns them (it overrides the agent's frontmatter default). Roster defaults + rationale → [`../../_shared/agent-roster.md`](../../_shared/agent-roster.md). Precedence: env var > this setting > agent frontmatter > session.
  - **Env path (reliable lever):** because the `effort:` frontmatter has been reported as a no-op on some builds (GitHub claude-code#43083), the engine ALSO exports `CLAUDE_CODE_EFFORT_LEVEL` (and `CLAUDE_CODE_SUBAGENT_MODEL`) for the dispatch when these keys are set — so effort takes effect even where the frontmatter doesn't.
  - **`.size` scaling:** the engine raises the default effort for **L/XL** features (execution agents → `high`) before dispatch, and keeps the cheap defaults for **XS/S** — a cross-module change is where reasoning depth pays off. It prints the resolved per-role model+effort in the banner.

## Reading semantics

Unknown keys are ignored (forward-compatible). A missing key falls back to the default above. A malformed file → warn and fall back to all-defaults rather than failing the run.
