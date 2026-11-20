# T8 — Real PiAgentClient

Depends: T3
Spec: `../SPEC.md` §7
Status: done

## Goal

Real `PiAgentClient` implementation over `pi --mode rpc`.

## Behavior

- spawn: `pi --mode rpc --session-dir <room_dir>/agents/<id>/sessions --session-id <id> --provider … --model … --thinking … --tools … --system-prompt … --append-system-prompt …` (§7.1).
- JSONL framing on stdin/stdout; correlate by `id`; split records only on `\n` (never `readline`).
- `prompt` → `{"type":"prompt", …}`; wait for `agent_settled` (not `agent_end`) for hop completion; `get_last_assistant_text` for the final text.
- `pushContext` → `{"type":"bash","command":"echo '<escaped>'","excludeFromContext":false}` (§6.6).
- shutdown: close stdin → SIGTERM → grace period → SIGKILL.

## Files

- create: `src/real/pi-agent-client-real.ts`, `test/pi-real.integration.test.ts`

## DoD

- [ ] integration test against a real `pi` session: spawn → prompt → settle → last text; `pushContext` then verify no reply is produced; shutdown.
- [ ] test skips cleanly if `pi` is not on PATH.
- [ ] `bun test` green; `tsc --noEmit` clean.

## Notes

- This is where the Q3 `bash`-echo pushContext mechanism is proven or pivoted (§11).
- One agent, one minimal prompt; do not test full routing here.
