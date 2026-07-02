#!/usr/bin/env bash
# SDD eval harness — on-demand, NOT CI (it invokes `claude` and costs tokens).
#
#   ./evals/run.sh                      # all scenarios
#   ./evals/run.sh design-gate-refusal  # one (or more) by name
#
# Env: SDD_EVAL_MODEL=<model>  SDD_EVAL_MAX_TURNS=<n, default 40>
set -euo pipefail

EVALS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_TURNS="${SDD_EVAL_MAX_TURNS:-40}"
MODEL_ARGS=()
[ -n "${SDD_EVAL_MODEL:-}" ] && MODEL_ARGS=(--model "$SDD_EVAL_MODEL")

command -v claude >/dev/null 2>&1 || { echo "FATAL: claude CLI not found" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq not found" >&2; exit 2; }

run_scenario() {
  local name="$1"
  local dir="$EVALS_DIR/scenarios/$name"
  [ -d "$dir" ] || { echo "FATAL: no such scenario: $name" >&2; return 2; }

  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/sdd-eval-$name.XXXXXX")"
  echo "== $name  (workdir: $work)"

  # 1. Fixture → git baseline.
  cp -R "$dir/fixture/." "$work/"
  git -C "$work" init -q
  git -C "$work" add -A
  git -C "$work" -c user.email=eval@sdd -c user.name=sdd-eval commit -qm baseline

  # 2. The run under test — headless; the prompt pins --depth=easy (a headless
  #    run cannot answer AskUserQuestion).
  local out="$work/.eval-run.json"
  ( cd "$work" && claude -p "$(cat "$dir/prompt.txt")" \
      --permission-mode acceptEdits --max-turns "$MAX_TURNS" \
      --output-format json "${MODEL_ARGS[@]}" > "$out" ) || true

  local final_msg tree diff
  final_msg="$(jq -r '.result // empty' "$out" 2>/dev/null | tail -c 4000 || true)"
  tree="$(cd "$work" && find . -path ./.git -prune -o -type f -print | sort)"
  git -C "$work" add -A
  diff="$( { git -C "$work" diff --cached --stat HEAD | head -40; git -C "$work" diff --cached HEAD | head -400; } || true)"

  # 3. The judge — rubric + observed outcome → one JSON verdict.
  local jp="$work/.judge-prompt.md"
  # shellcheck disable=SC2016  # the backticks are literal markdown fences
  {
    cat "$EVALS_DIR/judge-prompt.md"
    printf '\n## Rubric\n\n'; cat "$dir/rubric.md"
    printf '\n## File tree after the run\n\n```\n%s\n```\n' "$tree"
    printf '\n## Git diff vs the fixture baseline\n\n```\n%s\n```\n' "$diff"
    printf '\n## Tail of the run'\''s final message\n\n```\n%s\n```\n' "$final_msg"
  } > "$jp"

  local judge_out verdict
  judge_out="$(claude -p "$(cat "$jp")" --output-format json "${MODEL_ARGS[@]}" | jq -r '.result // empty')"
  verdict="$(printf '%s' "$judge_out" | sed -n 's/.*"verdict"[[:space:]]*:[[:space:]]*"\([A-Z]*\)".*/\1/p' | head -1)"

  printf '%s\n' "$judge_out"
  echo "== $name: ${verdict:-UNPARSEABLE}"
  [ "$verdict" = "PASS" ]
}

# No args → every scenario (dir names are kebab-case, splitting is safe).
if [ "$#" -eq 0 ]; then
  # shellcheck disable=SC2046
  set -- $(ls "$EVALS_DIR/scenarios")
fi

rc=0
for s in "$@"; do
  run_scenario "$s" || rc=1
done
exit $rc
