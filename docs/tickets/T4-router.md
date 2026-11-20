# T4 — Router

Depends: T1
Spec: `../SPEC.md` §6.2, §6.4
Status: done

## Goal

`resolveTargets(message, config)` → ordered agent ids.

## Rules

- `@handle` → that agent; multiple mentions → all of them, deduped, in first-occurrence order.
- `@lead` or the lead's handle → lead id.
- `@all` / `@everyone` → every agent (lead + all specialists).
- no mention → `[leadAgentId]`.

## Files

- create: `src/router.ts`, `test/router.test.ts`

## DoD

- [ ] pure unit tests covering every rule above, plus unknown `@handle` (log + skip, never crash).
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- Returns **ids**, not handles; `RoomMessage.mentions` stores ids (§4.1).
- Build a handle→id index from `LoadedConfig` (handles are unique per config).
