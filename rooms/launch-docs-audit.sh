#!/usr/bin/env bash
# Launch the docs-audit room in the repo it sits in. Run from the run worktree's root.
#
# The three-agent audit writes docs/DOCS-AUDIT.md, so it belongs in a throwaway worktree: the
# room's cwd is where its agents write, and `launch_guard: refuse` keeps it honest.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f rooms/docs-audit.yaml ]; then
  echo "launch: rooms/docs-audit.yaml not found — run this from the repo worktree" >&2
  exit 1
fi

# A linked worktree is not a repository root for the guard, which is why `refuse` is safe here.
if [ -z "$(git rev-parse --git-dir 2>/dev/null)" ]; then
  echo "launch: not inside a git worktree; the room needs one" >&2
  exit 1
fi

# Panes on by default: this room is meant to be watched. HERDR_ENV=0 runs it headless.
export HERDR_ENV="${HERDR_ENV:-1}"
if [ "$HERDR_ENV" = "1" ] && ! command -v herdr >/dev/null 2>&1; then
  echo "launch: herdr not on PATH; exporting HERDR_ENV=0 to run headless" >&2
  export HERDR_ENV=0
fi
# AH_DEBUG=1 traces boot, the signal, and each child's exit with code and signal.
[ -t 0 ] || echo "launch: stdin is not a terminal; the room will stop as soon as it starts" >&2

exec bun src/index.ts rooms/docs-audit.yaml
