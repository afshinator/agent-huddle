# T16 — An agent that goes quiet mid-turn is asked for status, in the room

**Status:** open · **Found:** runs `002-ticket-64` and `003-ticket-54`, 2026-11-21 · **Severity:** a turn can
spend 30 minutes silent and return nothing usable

## What happened

`002-ticket-64`: dev1 was dispatched, ran 85 tool calls over 15 minutes, wrote one line ("Got it: …") and
nothing else. The settle timeout killed the turn and the chain halted. The work was recovered only because
a human typed a status request into the agent's pane, and it answered in 72 seconds from the context it
already had.

`003-ticket-54`: dev1 was dispatched at 00:40:12, made 24 tool calls, and emitted **zero** text. The room's
`messages.jsonl` therefore held nothing for that turn — the pane showed tools, the room showed silence.

A silent turn is not a stuck turn: the agent is working and not telling anyone. The room has no way to ask.

## What is verified before building this

- **A nudge must be `steer`, not `followUp`.** pi's RPC docs (`docs/rpc-commands.md:26-27`) are explicit:
  `"steer"` is "delivered after the current assistant turn finishes executing its tool calls, before the
  next LLM call"; `"followUp"` is "delivered only when agent stops". `src/turn-loop.ts:362` sends every
  dispatch with `streamingBehavior: "followUp"`, so a nudge built on that path would arrive after the turn
  it was meant to rescue. The seam already accepts both (`src/seams/pi-agent-client.ts:12`).
- **The room records the turn's text, not its work.** `src/turn-loop.ts:371` appends `settled.lastText`;
  tool calls go to the pane and `log.jsonl` only. An agent that answers by running a command has, from the
  room's point of view, said nothing. The nudge text therefore has to say so.
- **Inactivity is observable.** The coordinator already subscribes to `stream` (`src/coordinator.ts:219`),
  `tool_end` (`:225`) and `tool` (`:230`); `TurnLoop` subscribes to `stream` alone (`src/turn-loop.ts:132`).
  A per-agent "last event" stamp needs no new seam.
- **The acknowledgement case needs nothing.** A reply that settles without `Got it: …` already appends the
  notice at `src/turn-loop.ts:272`, and `reportUp` (`:291`) already hands the lead the report. No lead ping
  is warranted for that; the missing-ack problem is cosmetic, and a ping would cost two turns.
- **The outer bound exists and is huge.** `waitForSettled(agentId, turnTimeoutMs)` (`:364`) waits 30 minutes
  (`turn_timeout_ms: 1800000`).

## What to build

In `TurnLoop.dispatch`, the settle wait becomes slices rather than one long promise:

1. Stamp `lastEventAt` for the agent on every `stream`, `tool` and `tool_end` event.
2. Wait for the settle in slices of `NUDGE_CHECK_MS`. Each slice that ends without a settle checks
   `now - lastEventAt`; while it is under `IDLE_NUDGE_MS`, keep waiting.
3. Past `IDLE_NUDGE_MS`, send **one** steer per turn:

   > Status only, in one line of text, now: what you have done so far and whether you are still on it. The
   > room reads only what you write in your reply — a tool call is not an answer to the room.

   Record the nudge in `messages.jsonl` as a notice so a reader can see why the agent suddenly spoke.
4. Keep waiting for the same settle. No new hop is counted: a nudge is not a dispatch, and `hopCount` must
   not move.
5. Cap it: one nudge per turn. A second silence after the first nudge is the timeout's business.
6. Best effort: a failed steer is a notice (`agent <id> nudge failed: …`), never a halt.

`IDLE_NUDGE_MS` and `NUDGE_CHECK_MS` are exported consts at the top of `turn-loop.ts`, with the reason in
one line: a live agent shows a tool call every few seconds; silence of two minutes means it is thinking at
length or has lost the thread, and both are better asked than waited out.

## Definition of done

1. A turn that holds with no events at all receives exactly one steer, and the room records it as a notice.
2. A turn that streams or calls tools steadily receives **no** steer, whatever the wall clock says.
3. A turn that is nudged and then speaks completes normally, and `hopCount` is the same as without the nudge.
4. A steer that fails produces a notice and the chain keeps waiting.
5. The nudge text asks for the status as text and says the room cannot read a tool call.
6. `bun run check` green.

## Red test

`test/turn-loop.test.ts`: script an agent with `{ hold: true }` and no deltas, set a short `IDLE_NUDGE_MS`,
and assert that `pi.calls` contains one `prompt` with `streamingBehavior: "steer"` before the turn settles;
then `pi.release(...)` and assert the chain completes with the same hop count. Today nothing is sent, so the
wait for that call times out — the assertion fails for the right reason.

Second test: script an agent that streams a delta every few milliseconds while holding, and assert **zero**
steers.

## Out of scope

- The lead pinging an agent over a missing `Got it:` (verified above: the notice and the upward report
  already exist, and a ping costs two turns for a cosmetic line).
- Interrupting a turn that is working; the nudge is a question, not a cancellation.
- Nudging during `wrapUp`, which has its own prompt and its own bound.
- Re-routing or retrying a turn that times out (that is T13's territory).
