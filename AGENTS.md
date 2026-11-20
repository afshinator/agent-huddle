# Notes for agents working in this repo

Pointers, not rules. Anything a script or test can enforce lives there instead.

- **Gate:** `bun run check` (typecheck then tests). Live adapter tests are skipped by default and CI sets `PI_TEST_INTEGRATION=0`; run them with `bun run test:live`.
- **Spec:** `docs/SPEC.md`. §9 is the per-seam failure grammar (what rejects, when, idempotency, listener behaviour). §10 is error handling and recovery. §12 is how to write a DoD bullet.
- **What v1 actually does, and what it cannot:** `docs/STATUS.md` — capabilities with the run or test behind each, then the limits.
- **Decisions:** `docs/decisions.md` — five entries whose reasons are not visible in the code. Read before changing a seam, the store, or the `DONE` rule.
- **Why v1 produced 27 findings:** `docs/rca/2026-11-20-v1-defects.md`, with the six ranked process changes.
- **Work one issue per session.** Loop: verify each claim in the issue against the code (issue bodies have been wrong — #14 said "hangs", it crashed; #13 was already covered) → failing test → fix → `bun run check` → push → one `gh run watch --exit-status` → close with the reproduction.
- **Probes:** `probes/` (ignored), non-dot filename. `test/hygiene.test.ts` fails the suite on a dot-prefixed `.ts` file, because `tsc` skips those. A probe that boots a room sets `HERDR_ENV=0`, or it opens herdr panes that outlive the process.
- **Editing:** new file → write tool; existing file → edit tool. No `sed`/`perl` bulk rewrites of source: they have silently mangled four working states.
