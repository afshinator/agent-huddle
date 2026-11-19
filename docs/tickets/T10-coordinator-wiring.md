# T10 — Coordinator wiring

Depends: T6, T8, T9
Spec: `../SPEC.md` §2, §13

## Goal

Compose everything into the runnable coordinator; CLI entry point.

## Files

- create: `src/coordinator.ts`, `src/index.ts` (CLI: `bun src/index.ts <config.yaml>`), finalize `rooms/example.yaml`.
- the room pane runs the coordinator: stdout prints the room stream; stdin reads human messages (§8).

## DoD

- [ ] `bun test` green (all unit + both integration suites) and `tsc --noEmit` clean.
- [ ] end-to-end run of the 2-agent room: startup task → lead → specialist → `DONE`, stream visible in the room pane, per-agent panes tailing logs.
- [ ] `max_hops` nudge and `hop_limit_reached` halt both observed in a test.

## Notes

- §13 is the project DoD; this ticket must satisfy it.
- Use the 2-agent config (lead + dev1) for the e2e fixture.
