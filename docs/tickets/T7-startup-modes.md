# T7 — Startup task / idle modes

Depends: T6
Spec: `../SPEC.md` §2, §6.1, D2

## Goal

Boot behavior: if `task` is present, post it and trigger the lead; else start idle waiting for input.

## Files

- create: `src/startup.ts`, `test/startup.test.ts`

## DoD

- [ ] `task` present → appends a `startup_task` message and starts a chain whose first target is the lead.
- [ ] `task` absent → room starts `idle`; no dispatch until the first human message.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- Composes store (T2) + turn loop (T6) over fakes.
