#!/usr/bin/env bash
# Launch a room template against a repo.
#
#   ./rooms/launch.sh --template <name> --repo <path> --slug <slug> [--branch] [--run <run.yaml>]
#   ./rooms/launch.sh --template ticket-resolver1 --repo <path> --issue 54 --slug ticket-54 --branch
#
#   --issue <n>   fetch the ticket and write the ask from it: the whole body verbatim, the bar from
#                 its acceptance criteria. Refuses unless it is ready-for-agent (--any-state) and
#                 unless nothing open blocks it (--ignore-blockers). Nothing needs editing.
#   --check       report every precondition and stop before creating anything
#   --dry-run     prepare the collateral and the worktree without booting the room
#   --no-warm     skip the dependency warm-up
#
# What it creates, in this order:
#   1. <repo>/_run/<slug>/          run collateral: run.yaml (the ask), run.resolved.yaml,
#                                    prompts/, notes.md — gitignored, survives the worktree
#   2. <repo>/../<repo-name>-<slug> a linked worktree, on branch run/<slug> with --branch,
#                                    detached otherwise: this is where the room's output goes
#   3. the room itself, whose agents write in that worktree
#
# The sequence lives in src/launch-plan.ts, where a test holds it: which steps run, in what order, what a
# refusal removes, and how the prep pass and the re-ask are invoked (#78). This file resolves where the
# repo is and starts that entry point; it parses no YAML and branches on no exit code.
#
# The launcher neither commits nor pushes. Whether a room commits its work on the branch is the
# template's own contract, stated in its prompts; merging the run branch stays with a human.
set -euo pipefail

ROOMS_DIR="$(cd "$(dirname "$0")" && pwd)"
HUDDLE_ROOT="$(cd "$ROOMS_DIR/.." && pwd)"

exec bun "$HUDDLE_ROOT/src/launch-plan.ts" "$@"
