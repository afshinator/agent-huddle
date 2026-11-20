# T9 — Real HerdrPaneManager

Depends: T3
Spec: `../SPEC.md` §8, §9.2
Status: done

## Goal

Real `HerdrPaneManager` over the `herdr pane` CLI.

## Behavior

- `openAgentPane`: `herdr pane split` + `run tail -f <log>` + `rename` to the agent handle.
- `tailLog` → `herdr pane run tail -f <log>`; `readOutput` → `herdr pane read`; `close` → `herdr pane close`.
- `close` only hides the pane; the `pi` process is untouched (owned by the coordinator, not the pane).

## Files

- create: `src/real/herdr-pane-manager-real.ts`, `test/herdr-real.integration.test.ts`

## DoD

- [ ] integration test: open a pane, tail a temp log, `readOutput` sees appended lines, `close` does not kill a child process.
- [ ] test skips cleanly if `herdr` is not on PATH.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- The room pane is NOT seam-managed (§9.2): the human launches the coordinator in it.
- No `collapse`/`expand` — herdr has no such pane op; "hidden" = `close`.
