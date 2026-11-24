# Notes for agents working in this repo

Pointers, not rules. Anything a script or test can enforce lives there instead.

- **Gate:** `bun run check` (typecheck then tests). Live adapter tests are skipped by default and CI sets `PI_TEST_INTEGRATION=0`; run them with `bun run test:live`.
- **Spec:** `docs/SPEC.md`. §9 is the per-seam failure grammar (what rejects, when, idempotency, listener behaviour). §10 is error handling and recovery. §12 is how to write a DoD bullet.
- **What v1 actually does, and what it cannot:** `docs/STATUS.md` — capabilities with the run or test behind each, then the limits.
- **Decisions:** `docs/decisions.md` — one entry per choice whose *reason* is not visible in the code, numbered D1 upward, each with the rejected alternative and the accepted cost. Read it before changing a seam, the store, the `DONE` rule, or a boot-time ordering.
- **Why v1 produced 27 findings:** `docs/rca/2026-11-20-v1-defects.md`, with the six ranked process changes.
- **Work one issue per session.** Loop: verify each claim in the issue against the code, and the assertion the fixing test would make — an assertion that already passes proves nothing (issue bodies have been wrong — #14 said "hangs", it crashed; #13 was already covered; #50 proposed a stdout assertion for a stderr write) → failing test → fix → `bun run check` → push → one `gh run watch --exit-status` → close with the reproduction.
- **Rooms: templates are tracked, runs never are.** `rooms/templates/<type>/` holds a room kind (agents, models, prompts, `launch.sh`); a run is a small file naming `template:` plus the ask, and its collateral lives in the gitignored `_run/<slug>/`. Launch with `rooms/templates/<type>/launch.sh --repo <path> --slug <slug> [--branch]`, which prepares the collateral and boots the room **in a linked worktree** — never in the main checkout, because agents write real files there and their tests join your suite (`bun test` picked up a room's `shrink/src/slug.test.ts`). Nothing commits inside the room: commit on `run/<slug>` yourself.
- **Claims: a ticket can carry a ` ```claims ` block, and the room checks it.** The tool is not on `PATH`: `~/Documents/dev/_system/tools/claim-check/bin/claim-check`, with `skill/SKILL.md` beside it for how to run and read it. `ticket-resolver1-claims` is the template that gates on it (Gate 0, then `--phase after` before DONE).
- **Probes:** `probes/` (ignored), non-dot filename. `test/hygiene.test.ts` fails the suite on a dot-prefixed `.ts` file, because `tsc` skips those. A probe that boots a room sets `HERDR_ENV=0`, or it opens herdr panes that outlive the process.
- **Editing:** new file → write tool; existing file → edit tool. No `sed`/`perl` bulk rewrites of source: they have silently mangled four working states.
