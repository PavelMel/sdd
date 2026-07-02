# SDD behaviour evals — on-demand, NOT CI

End-to-end scenarios that drive a real `claude` session over a fixture repo and let an LLM judge
verify the outcome against a rubric. They complement `scripts/validate_plugin.py` (structure) and
`server/tests/` (deterministic runtime): evals check that a **skill's protocol actually behaves** —
gates refuse, artifacts land in shape, handoffs are emitted.

> **Why not CI.** Each run invokes `claude -p` (the run under test) + a judge call — it costs real
> tokens, takes minutes, and is non-deterministic. Run evals locally when you change a skill's
> protocol; CI stays deterministic (`validate` + `server-tests`).

## Prerequisites

- `claude` CLI installed and logged in, with the **sdd plugin installed** (`/plugin install sdd@sdd`)
  — the scenarios invoke `/sdd:<skill>` commands.
- `jq`, `git` on PATH.
- Budget: one scenario ≈ one short agent session + one judge call.

## Run

```bash
./evals/run.sh                        # all scenarios
./evals/run.sh design-gate-refusal    # one scenario
SDD_EVAL_MODEL=opus ./evals/run.sh classify-size   # override the model
```

Exit code is non-zero when any scenario's verdict is `FAIL` (or unparseable).

## How a scenario works

1. `run.sh` copies `scenarios/<name>/fixture/` into a `mktemp` dir and `git init && commit`s it
   (the baseline).
2. It runs `claude -p "$(cat prompt.txt)" --permission-mode acceptEdits --max-turns 40
   --output-format json` **inside that dir**. Prompts always pin `--depth=easy` and state
   «headless — no interactive user», because a headless run cannot answer `AskUserQuestion`.
3. It then asks a judge (`claude -p` with [`judge-prompt.md`](./judge-prompt.md)) to verify the
   **rubric** against the file tree, the `git diff` vs the baseline, and the tail of the run's
   final message. The judge answers one JSON object: `{"verdict": "PASS"|"FAIL", "checks": [...]}`.

## Scenarios

| Scenario | What it proves |
|---|---|
| `specify-happy-path` | `/sdd:specify` produces a spec.md with §1–§8, business-observable ACs, `.size` + `.route`, and the handoff block |
| `design-gate-refusal` | `/sdd:design` on a folder with `.size` but **no spec.md** refuses, points at `specify`, writes no sad.md/ADRs |
| `classify-size` | `/sdd:classify-size` writes one-token `.size` + `.route` and hands off (utility variant) |

## Adding a scenario

Create `scenarios/<name>/` with three parts:

- `fixture/` — the starting repo tree (committed as the git baseline; keep it minimal).
- `prompt.txt` — the exact `-p` prompt: the `/sdd:` command line plus the headless framing
  (state the idea/answers inline; always `--depth=easy`).
- `rubric.md` — numbered PASS conditions the judge can verify from the diff/tree/final message
  only. Make every item observable; «the model tried» is not a rubric item.
