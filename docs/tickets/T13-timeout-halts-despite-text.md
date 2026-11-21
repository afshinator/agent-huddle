# T13 — A timed-out turn halts the chain, though the room never sees the text

**Status:** open · **Found:** run `002-ticket-64`, 2026-11-21 · **Severity:** the run dies mid-gate

## What happened

Run `002-ticket-64` halted at hop 2 of 20, three minutes into gate 1:

```
22:15:59  lead dispatches @dev1 to verify ticket #64's claims
22:15:59  [@dev1] Got it: verifying every factual claim in ticket #64 against the code, no edits.
22:25:05  dev1's last tool call returns (85 tool calls, 48 model round trips so far)
22:30:59  agent dev1: settle timeout after 900000ms
          (chain halted; no reply, no commit, no ticket comment)
```

The room printed dev1's text, so the turn was not silent. D20 exists for exactly this case — *a turn
that times out hands on what it wrote* — and it did not fire. The tests for it pass.

## Root cause: the room's stream listener is deleted when the client spawns

D20's salvage reads a copy of the streamed text that `TurnLoop` keeps:

- `src/turn-loop.ts:121-126` — the `TurnLoop` constructor subscribes `pi.on("stream", …)` for every
  agent and appends each delta to `this.streamed`.
- `src/coordinator.ts:125` — the coordinator constructs `TurnLoop` in its **constructor**, so those
  subscriptions exist before boot.
- `src/coordinator.ts:172` — `bootRoom()` then calls `this.pi.spawn(agent, …)` for each agent.
- `src/real/pi-agent-client-real.ts:144` — `spawn()` calls `register()`.
- `src/real/pi-agent-client-real.ts:289` — `register()` calls `this.bus.reset(agent.id)`.
- `src/seams/pi-agent-client.ts:107` — `AgentListeners.reset` deletes **every** listener for that agent.

So by the time any delta arrives, `this.streamed` has no subscriber: it stays `""`, the branch at
`src/turn-loop.ts:337` (`if (/settle timeout/.test(msg) && partial !== "")`) is skipped, `dispatch`
returns `null`, and `runChain` finishes the chain `halted` (`src/turn-loop.ts` after the settle checks).

The chat pane still prints, because the coordinator registers its own `stream`/`tool`/`message_end`
listeners inside `bootRoom()` **after** `spawn` — they survive the reset. That asymmetry is why the
pane looked healthy while the salvage path was dead.

**Why the suite is green:** the fake client's `spawn` (`src/seams/pi-agent-client.ts:171-177`) never
calls `reset`, so the D20 tests (`test/turn-loop.test.ts:479` and `:501`) exercise a client whose
listeners are never wiped. Nothing in the suite spawns after the loop subscribes.

This is the third dead wire of the session (#76's unassigned `onDispatch`, #70's unwired mark) and the
same shape: declared, wired, tested against a stub, never exercised in the order the room actually runs.

## Contributing, not a defect: one provider request took 354 s

Measured from `agents/dev1/sessions/2026-11-21T22-15-45-458Z_dev1.jsonl`, first turn only:

| model waits | median | p90 | max | total | tool time |
|---|---|---|---|---|---|
| 48 | 5.0 s | 27.2 s | **354 s** | 858 s | 45 s |

So the 900 s cap was consumed by 48 round trips (858 s) plus one stall of nearly six minutes. Without
the stall the turn ends around 9 minutes. The cap is per turn (`turn_timeout_ms`), not per hop.

## What to build

1. The failing test first: build a `TurnLoop`, then `spawn` (the order the coordinator uses), then
   stream a delta, then fail `waitForSettled` with a settle timeout — the streamed text must land as an
   agent message and the chain must continue. Today it halts with no message.
2. Fix the wire. Either drop `bus.reset(agent.id)` from `register()` — the listeners belong to the room
   and a respawned child should not silence them — or re-subscribe after spawn. Keep `AgentListeners.reset`
   only if something still needs it.
3. A turn that streamed **nothing** still halts: the empty-partial path is correct and needs its test
   kept (`test/turn-loop.test.ts:501`).

## Definition of done

- The new test is red before the fix and green after.
- A timed-out turn with streamed text: the text is in `messages.jsonl`, the named agent is dispatched,
  the chain continues, and `room.active_chains` returns to 0.
- A timed-out turn with no text: still halts, still reports the timeout as a timeout rather than a
  failure.
- The chat pane and the agent log still show deltas (the coordinator's listeners are unaffected).
- `bun run check` green.

## Out of scope

- Re-routing a timed-out turn to another model, or retrying it.
- The `$0.0000` spend for a model that reports no cost (known limit, `docs/STATUS.md`).
- Pane input being serialised behind the active chain (a separate observation from the same run).
