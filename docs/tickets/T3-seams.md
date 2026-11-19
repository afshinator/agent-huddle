# T3 — Seams (interfaces + fakes)

Depends: T1
Spec: `../SPEC.md` §9

## Goal

`PiAgentClient` + `HerdrPaneManager` interfaces and in-memory fakes. The coordinator depends only on these interfaces (Q4).

## Files

- create: `src/seams/pi-agent-client.ts`, `src/seams/herdr-pane-manager.ts`, `test/seams.test.ts`

## DoD

- [ ] interfaces match §9.1 / §9.2 exactly.
- [ ] `FakePiAgentClient`: scripted replay (`agentId → {messages, replayScript}`), records every `prompt`/`pushContext`/`shutdown` call; emits `stream`/`settled`/`error` on demand.
- [ ] `FakeHerdrPaneManager`: in-memory pane registry; records `openAgentPane`/`tailLog`/`close`; `readOutput` returns scripted pane text.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- `PiAgentClient.on(event, agentId, fn)` overloads from §9.1.
- These fakes are the only implementations T6/T7/T10 run against until T8/T9.
