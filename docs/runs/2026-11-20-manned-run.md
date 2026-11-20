# Manned room run — 2026-11-20

First end-to-end run with two real models and real panes. Room: `rooms/example-2.yaml`
(`tiny-factory-2`, lead `deepseek/deepseek-v4-pro` thinking medium, dev1
`deepseek/deepseek-v4.1-flash` thinking high, `max_hops: 8`). Driven by a pipe instead of a human:
two supervisor lines, 10s and 120s apart, stdin closed at 270s.

## What happened

Three chains. The startup `task:` opened chain 1; my two typed lines opened chains 2 and 3.

| hop | from | what |
|---|---|---|
| 1 | lead | dispatched `@dev1` with a full token-bucket spec — real delegation, `mentions: [dev1, lead]` |
| 2 | dev1 | `@lead Done.` after writing `src/rate-limiter.ts` and `test/rate-limiter.test.ts` and running `bun run check` (129 pass) |
| 3 | lead | asked dev1 for two more tests; the message reads "…report to @lead when green", so `mentions: [dev1, lead]` |
| 4 | room | `agent lead failed: agent lead settle timeout after 120000ms` — chain halted half-done |

Chain 2: supervisor typed "Create hello.txt containing exactly one line: hi" with no mention → routed
to the lead only. The lead **did the work itself** ("hello.txt created: one line, `hi\n`") and wrote no
`DONE`, so the chain had no completion signal and never closed. `hello.txt` was on disk, 2 bytes, no
trailing newline.

Chain 3: the second supervisor line landed and then stdin closed, so `main()` ran `shutdown()`.

## The seven assertions

1. **Routing — holds.** `messages.jsonl` shows `startup_task` → lead → dev1 → lead → notice, hops
   incrementing 0..4, `mentions` matching the text.
2. **`DONE` — half-proved, not by this run.** No agent ever emitted the bare `DONE` line, so the live
   accept path did not fire. The near-miss half is deterministic already
   (`test/turn-loop.test.ts:79-80` against the same `hasDoneSignal` at `src/turn-loop.ts:26`).
   Observed instead: a lead that closes with prose gets no completion and burns the hop budget.
3. **Context push — holds, and this run is the first proof.** Supervisor's "Create hello.txt…" message
   mentions nobody, so dev1 was untargeted and took no turn, yet the string appears exactly once in
   `agents/dev1/sessions/2026-11-20T04-37-09-311Z_dev1.jsonl`. `bash echo` +
   `excludeFromContext: false` does reach the model's context as designed.
4. **Panes — holds on open, fails on exit.** Two panes, labels `@lead` and `@dev1`, tailing their
   logs. Closing one did not kill its `pi` child. But both panes were still listed after the
   coordinator exited — the orphan-pane defect, reproduced with a real shutdown path.
5. **Telemetry — holds.** 6 `agent.turn` spans, 3 `chain` spans, `room.hops_total` +1 per hop, and
   `room.active_chains` balanced exactly 3×+1/3×−1 (net 0) — no gauge leak on the live path.
   `agent.settle_latency_ms`: 88.7s, 86.2s, 33.0s, 19.0s, 8.0s. The failure appears once as a `log`
   with `agent.turn` status `error` and description `agent lead settle timeout after 120000ms`.
6. **Ctrl-C — not run.** The run ended by stdin EOF, so #27's signal path still has no live evidence.
7. **Kill a child — not run.**

## What the numbers say

The two largest settle latencies are **88.7s and 86.2s against a 120s ceiling** — the lead runs at
~74% of its timeout on every turn, so a timeout is not an edge case, it is the expected next turn.
When it happened the chain halted at hop 4 of 8, mid-refactor, with the room left `status: active`.

## Not observed, therefore still open

- `DONE` accepted from a real model.
- Ctrl-C and killed-child paths (#27, and #18's exit handling) against a real signal.
- Whether the lead can be kept from doing specialist work: `role:` prose did not stop it doing a
  one-line task itself.
- `--tools` allowlist enforcement: not tested (no agent attempted a tool outside its list).

## Findings filed

#30 (turn timeout inside real latency), #31 (self-mention re-queues the author), #32 (context push has
no observable trace), #33 (panes outlive the coordinator), #34 (`state.json` left `active` on exit).

## Also worth knowing

Agents run with `cwd` = the coordinator's cwd, unsandboxed: dev1 created `src/rate-limiter.ts`,
`test/rate-limiter.test.ts` in this repo and ran `bun run check` against it. Fine for v1's trust
model, fatal for anything else. Both files were removed after the run.
