#!/usr/bin/env bash
# Launch a room template against a repo.
#
#   ./rooms/launch.sh --template <name> --repo <path> --slug <slug> [--branch] [--run <run.yaml>]
#   Add --dry-run to prepare the collateral and the worktree without booting the room.
#
# What it creates, in this order:
#   1. <repo>/_run/<slug>/          run collateral: run.yaml (the ask), run.resolved.yaml,
#                                    prompts/, notes.md — gitignored, survives the worktree
#   2. <repo>/../<repo-name>-<slug> a linked worktree, on branch run/<slug> with --branch,
#                                    detached otherwise: this is where the room's output goes
#   3. the room itself, whose agents write in that worktree
#
# The launcher neither commits nor pushes. Whether a room commits its work on the branch is the
# template's own contract, stated in its prompts; merging the run branch stays with a human.
set -euo pipefail

ROOMS_DIR="$(cd "$(dirname "$0")" && pwd)"
HUDDLE_ROOT="$(cd "$ROOMS_DIR/.." && pwd)"

TEMPLATE_NAME=""
REPO=""
SLUG=""
BRANCH=0
RUN_FILE=""
DRY_RUN=0

usage() {
  sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
  if [ -d "$ROOMS_DIR/templates" ]; then
    echo "templates: $(ls "$ROOMS_DIR/templates" | tr '\n' ' ')"
  fi
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --template) TEMPLATE_NAME="${2:-}"; shift 2 ;;
    --repo) REPO="${2:-}"; shift 2 ;;
    --slug) SLUG="${2:-}"; shift 2 ;;
    --run) RUN_FILE="${2:-}"; shift 2 ;;
    --branch) BRANCH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "launch: unknown argument $1" >&2; usage ;;
  esac
done

[ -n "$TEMPLATE_NAME" ] || { echo "launch: --template <name> is required" >&2; usage; }
TEMPLATE="$ROOMS_DIR/templates/$TEMPLATE_NAME/template.yaml"
[ -f "$TEMPLATE" ] || {
  echo "launch: no template at $TEMPLATE" >&2
  echo "templates: $(ls "$ROOMS_DIR/templates" 2>/dev/null | tr '\n' ' ')" >&2
  exit 1
}

REPO="${REPO:-$PWD}"
REPO="$(cd "$REPO" && pwd)"
REQUESTED="${SLUG:-$(date +%Y-%m-%d-%H%M%S)}"
# Run names start with an ordinal so `ls _run/` shows creation order; an existing run keeps it.
SLUG="$(bun "$HUDDLE_ROOT/src/run-slug.ts" next "$REPO/_run" "$REQUESTED")"
[ -n "$SLUG" ] || { echo "launch: could not name the run" >&2; exit 1; }
RUN_DIR="$REPO/_run/$SLUG"
WORKTREE="$(dirname "$REPO")/$(basename "$REPO")-$SLUG"
NAME="$TEMPLATE_NAME"

if [ -z "$RUN_FILE" ]; then
  mkdir -p "$RUN_DIR"
  RUN_FILE="$RUN_DIR/run.yaml"
  if [ ! -f "$RUN_FILE" ]; then
    # The ask is the only thing a human must write. Everything else comes from the template.
    cat > "$RUN_FILE" <<YAML
template: $TEMPLATE
task: |
  Describe the ask for this run.
definition_of_done: |
  Describe what makes it done.
YAML
    echo "launch: wrote a skeleton ask at $RUN_FILE — edit it, then run this again" >&2
    exit 1
  fi
fi

# `_run/` must not be committed: it holds runtime files and a prompt snapshot per run.
if [ ! -d "$REPO/.git" ] && [ ! -f "$REPO/.git" ]; then
  echo "launch: $REPO is not a git working tree; a room's output needs a branch or a worktree" >&2
  exit 1
fi
if ! git -C "$REPO" check-ignore -q _run/; then
  echo "launch: warning: _run/ is not gitignored in $REPO; add it before the room writes there" >&2
fi

CONFIG="$(bun "$HUDDLE_ROOT/src/room-run.ts" prepare "$RUN_FILE" --out "$RUN_DIR")"
[ -f "$CONFIG" ] || { echo "launch: prepare did not produce a resolved config" >&2; exit 1; }

if [ -d "$WORKTREE" ]; then
  echo "launch: reusing existing worktree $WORKTREE" >&2
elif [ "$BRANCH" = "1" ]; then
  git -C "$REPO" worktree add -b "run/$SLUG" "$WORKTREE" >&2
else
  # No branch: this run produces nothing to check in, so nothing should be mergeable.
  git -C "$REPO" worktree add --detach "$WORKTREE" >&2
fi

echo "launch: template=$NAME run=$RUN_DIR worktree=$WORKTREE branch=$([ "$BRANCH" = 1 ] && echo "run/$SLUG" || echo detached)" >&2

if [ "$DRY_RUN" = "1" ]; then
  echo "launch: dry run, not booting. Resolved config: $CONFIG" >&2
  exit 0
fi

cd "$WORKTREE"
export HERDR_ENV="${HERDR_ENV:-1}"
if [ "$HERDR_ENV" = "1" ] && ! command -v herdr >/dev/null 2>&1; then
  echo "launch: herdr not on PATH; running headless" >&2
  export HERDR_ENV=0
fi
exec bun "$HUDDLE_ROOT/src/index.ts" "$CONFIG"
