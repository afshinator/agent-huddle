# T6 — Turn loop + hop cap + nudge

Depends: T2, T3, T4, T5
Spec: `../SPEC.md` §6

## Goal

`TurnLoop` drives one user-turn chain to completion over the fakes.

## Behavior (from §6)

- Dispatch targets in order, one at a time; each dispatch = one hop (`chain.hopCount++`, add id to `chain.dispatchedAgentIds`).
- On `settled`: append agent final text to `messages.jsonl`; extract `@mentions` → next-hop targets; detect `DONE` (`/^DONE$/m` on lead text) → chain complete.
- Push the message to unmentioned agents via `pushContext` before dispatch (D8 / §6.6).
- Hop cap: `hopCount == max_hops` + no DONE + no nudge → dispatch lead with the §6.3 wrap-up prompt (`nudgeIssued=true`, status `wrap_up`); then dispatch each agent in `dispatchedAgentIds` (excl. lead) one concluding turn.
- Still no DONE after concluding turns → append `hop_limit_reached`, status `halted`, stop auto-routing.
- Human input resets the chain (`hopCount=0`, `nudgeIssued=false`, new `chainId`).

## Files

- create: `src/turn-loop.ts`, `test/turn-loop.test.ts`

## DoD

- [ ] state-machine tests: normal completion via `DONE`; mention propagation; hop-cap nudge; concluding turns; `hop_limit_reached` halt; human reset; unmentioned `pushContext` was called.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- Uses fakes only; no real `pi`.
- "active agents" = `chain.dispatchedAgentIds` (§4.2).
