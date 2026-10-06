#!/usr/bin/env bash
# Run a docs/PLAN.md task through Codex CLI in its own git worktree. See CLAUDE.md "Task loop".
#   scripts/codex-task.sh start <plan-id> <slug>        # brief: docs/briefs/<plan-id>.md
#   scripts/codex-task.sh fix   <plan-id> <feedback.md> # fresh Codex session in the task worktree (default)
#   scripts/codex-task.sh resume <plan-id> <feedback.md> # resume the original session (costs its full context)
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
[[ -n "$cmd" && -n "$id" ]] || die "usage: $0 start|fix|resume|path|clean <plan-id> [...]"
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
    sed 's/\x1b\[[0-9;]*m//g' "$run_dir/round-$n.log" | grep -m1 -oE 'session id: [0-9a-f-]+' | awk '{print $3}' > "$run_dir/session"
    [[ -s "$run_dir/session" ]] || die "could not read the Codex session id from $run_dir/round-$n.log"
    echo "codex-task: session $(cat "$run_dir/session"); worktree $wt; report $run_dir/round-$n.md"
    ;;
  fix)
    # A fresh session reads the current code plus brief and feedback. Resuming would re-bill the
    # whole earlier conversation for what is usually a small change.
    feedback="${3:-}"; [[ -f "$feedback" ]] || die "fix needs a feedback file"
    wt="$(worktree_for "$id")"; [[ -n "$wt" ]] || die "no worktree for $id"
    brief="$REPO/docs/briefs/$id.md"; [[ -f "$brief" ]] || die "missing brief $brief"
    n=$(find "$run_dir" -maxdepth 1 -name 'round-*.md' | wc -l)
    { printf '%s\n\n' "This is a FIX ROUND for a task that is already implemented in this worktree. Read the current code first; change only what the feedback asks for. The original brief follows for context, then the feedback."
      cat "$brief"; printf '\n\n# FEEDBACK FOR THIS ROUND\n\n'; cat "$feedback"; } \
      | codex exec --disable apps -m "$MODEL" -c "model_reasoning_effort=$EFFORT" -s workspace-write -C "$wt" \
          -o "$run_dir/round-$n.md" - 2>&1 | tee "$run_dir/round-$n.log"
    echo "codex-task: report $run_dir/round-$n.md"
    ;;
  resume)
    feedback="${3:-}"; [[ -f "$feedback" ]] || die "resume needs a feedback file"
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
