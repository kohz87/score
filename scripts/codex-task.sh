#!/usr/bin/env bash
# Run a docs/PLAN.md task through Codex CLI in its own git worktree. See CLAUDE.md "Task loop".
#   scripts/codex-task.sh start <plan-id> <slug>        # brief: docs/briefs/<plan-id>.md
#   scripts/codex-task.sh fix   <plan-id> <feedback.md> # resume the same Codex session
#   scripts/codex-task.sh path  <plan-id>               # print the worktree path
#   scripts/codex-task.sh clean <plan-id>               # remove the worktree (after merge)
set -euo pipefail

MODEL="${CODEX_MODEL:-gpt-6.1-sol}"
EFFORT="${CODEX_EFFORT:-high}"
REPO="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
WT_ROOT="$(dirname "$REPO")/score-worktrees"
RUNS="${SCORE_HOME:-$HOME/.score}/codex/runs"

die() { echo "codex-task: $*" >&2; exit 1; }
worktree_for() { ls -d "$WT_ROOT/$1-"* 2>/dev/null | head -1; }

cmd="${1:-}"; id="${2:-}"
[[ -n "$cmd" && -n "$id" ]] || die "usage: $0 start|fix|path|clean <plan-id> [...]"
run_dir="$RUNS/$id"; mkdir -p "$run_dir"

case "$cmd" in
  start)
    slug="${3:-}"; [[ -n "$slug" ]] || die "start needs a slug"
    brief="$REPO/docs/briefs/$id.md"; [[ -f "$brief" ]] || die "missing brief $brief"
    wt="$WT_ROOT/$id-$slug"; branch="task/$id-$slug"
    [[ -e "$wt" ]] && die "worktree exists: $wt"
    mkdir -p "$WT_ROOT"
    git -C "$REPO" worktree add -b "$branch" "$wt" main
    (cd "$wt" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm install --frozen-lockfile --silent)
    n=$(find "$run_dir" -maxdepth 1 -name 'round-*.md' | wc -l)
    codex exec --disable apps -m "$MODEL" -c "model_reasoning_effort=$EFFORT" -s workspace-write -C "$wt" \
      -o "$run_dir/round-$n.md" - < "$brief" 2>&1 | tee "$run_dir/round-$n.log"
    grep -m1 -oE 'session id: [0-9a-f-]+' "$run_dir/round-$n.log" | awk '{print $3}' > "$run_dir/session"
    echo "codex-task: session $(cat "$run_dir/session"); worktree $wt; report $run_dir/round-$n.md"
    ;;
  fix)
    feedback="${3:-}"; [[ -f "$feedback" ]] || die "fix needs a feedback file"
    wt="$(worktree_for "$id")"; [[ -n "$wt" ]] || die "no worktree for $id"
    session="$(cat "$run_dir/session" 2>/dev/null)"; [[ -n "$session" ]] || die "no session for $id"
    n=$(find "$run_dir" -maxdepth 1 -name 'round-*.md' | wc -l)
    (cd "$wt" && codex exec resume "$session" --disable apps -m "$MODEL" -c "model_reasoning_effort=$EFFORT" \
      -c 'sandbox_mode="workspace-write"' -o "$run_dir/round-$n.md" - < "$feedback" 2>&1 | tee "$run_dir/round-$n.log")
    echo "codex-task: report $run_dir/round-$n.md"
    ;;
  path) worktree_for "$id" ;;
  clean)
    wt="$(worktree_for "$id")"; [[ -n "$wt" ]] || die "no worktree for $id"
    git -C "$REPO" worktree remove "$wt"
    ;;
  *) die "unknown command $cmd" ;;
esac
