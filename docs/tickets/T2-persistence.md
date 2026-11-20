# T2 — Persistence & Telemetry

Depends: T1
Spec: `../SPEC.md` §4, §9.3
Status: done

## Goal

Two append-only room artifacts plus the telemetry deep module:

1. Room log `messages.jsonl` + atomic `state.json` (§4).
2. `Telemetry` deep module (seam): span/log/counter → OTel-shaped JSONL to `<room_dir>/telemetry.jsonl` (§9.3).

## Files

- create: `src/messages.ts`, `src/state.ts`, `src/store.ts`, `src/telemetry.ts`, `test/store.test.ts`, `test/telemetry.test.ts`

## DoD

Persistence:

- [ ] append a `RoomMessage` to `messages.jsonl` (one JSON object per line) and read it back in order.
- [ ] atomic `state.json` write: `state.json.tmp` → `fsync` → `rename`; no partial state on crash.
- [ ] rebuild `RoomState` from `messages.jsonl` + config (recoverable cache).

Telemetry:

- [ ] `Telemetry` interface: `span(name, attrs, fn)` (times the fn, wires parent/child), `log(level, msg, attrs)`, `counter(name, attrs, inc)`.
- [ ] `JsonlTelemetry` emits OTel-shaped records (`trace_id`/`span_id`/`parent_id`/start/end/attributes/events/status) to `<room_dir>/telemetry.jsonl`.
- [ ] `NoopTelemetry` for tests.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- Copy the `RoomMessage`/`MessageKind`/`RoomState`/`ChainState`/`AgentRuntime` types from §4 exactly.
- Store owns `<room_dir>/messages.jsonl` and `<room_dir>/state.json`; telemetry owns `<room_dir>/telemetry.jsonl`.
- No `@opentelemetry/*` dependency — OTel-shaped records only; a real SDK/OTLP impl swaps in later behind the same interface.
