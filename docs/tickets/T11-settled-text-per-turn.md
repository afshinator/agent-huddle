# T11 — the acknowledgement check reads the turn's last message, not the turn

Status: **closed** — fixed in `src/real/pi-agent-client-real.ts`; both probe questions answered below. Filed after run `_run/001-docs-audit` (2026-11-21 04:34) where the reviewer
acknowledged a direct message and the room published the opposite.

## What happened

`room.log` and the chat pane show the reviewer answering the lead's request:

```
[@lead] @reviewer verify the tally: `docs/DOCS-AUDIT.md` should have one row per tracked `.md` …
[@reviewer] Got it: verify the 27-row tally against tracked Markdown files and spot-check two
complete rows against their files.go
[room] @reviewer answered a direct message without "Got it: …" — a silent pickup is
indistinguishable from a miss
```

The notice is false: the acknowledgement is the line above it. Note `files.go` — the reviewer's
turn contained two assistant messages (`Got it: …files.` and `go`), and the second carried no
leading newline.

## Proof

`_run/001-docs-audit/agents/reviewer/log.jsonl`, boot 2:

```
04:34:55.207Z delta Got          …  04:34:55.211Z delta  files       (the acknowledgement)
04:34:59.431Z delta go           (a second assistant message, no newline before it)
04:34:59.607Z settled go         (the whole turn's record: "go")
```

One `settled` per turn, and it holds `go` alone. So the turn's accumulated text was discarded
mid-turn.

`src/real/pi-agent-client-real.ts:341-343`:

```ts
// Reset per low-level run so a retry does not concatenate attempts.
if (rec.type === "agent_start") {
  agent.textBuffer = "";
```

`agent_start` arrives per **assistant message**, not per turn, so message 2 wiped message 1's
text before `agent_settled`. `settleText` (`:389-391`) then returned `go`, and `hasAck` saw no
`Got it:`.

`src/real/pi-agent-client-real.ts:333-336` is the same defect by another route: `text_end`
**replaces** the buffer, so a provider that emits `text_end` per message loses every earlier
message too.

`#64` fixed the other half of this (prefer the streamed text over `get_last_assistant_text`);
it did not fix the buffer's scope, which is the message, not the turn. The consequence is not
cosmetic: `DONE` detection, the ack notice and `messages.jsonl` all read this text.

## Fix

Accumulate per dispatch, not per low-level run:

- clear the turn buffer where a prompt is dispatched, not on `agent_start`;
- keep a per-message buffer for the streaming path, and append it to the turn buffer when the
  next message starts (or at settle), joining messages with `"\n"`;
- `settleText` returns the turn buffer, `get_last_assistant_text` only when nothing streamed.

Two things to determine by probe before writing it:

1. Does pi emit `agent_start` again when it retries a failed run inside one dispatch? The reset
   at `:341` exists for that reason. If a retry re-streams the same message, the turn buffer
   would duplicate it.
2. Does a text-only provider ever send `text_end` per message rather than per turn? If yes, the
   replace must become "replace the current message segment, keep earlier ones".

## Test first

A stub that streams `Got it: …` in message 1 and `go` in message 2, exactly as the run did.
Before the fix: `settled.lastText` is `"go"` and the room prints the notice. After: `lastText`
is both messages and no notice appears. The same fixture must show `DONE` on its own line
still detected (a second message is how a model naturally writes `DONE`).

## Related, same run, not the same defect

The chat pane glued the two messages (`files.go`) because message 2's delta had no leading
newline. A pane should start a new assistant message on its own line; the message boundary is
known (`agent_start`), so `ChatStream` can break there instead of guessing from the text.

## Acceptance

- `bun run check` green, and a control that removes the turn-level accumulation goes red.
- The fixture's `messages.jsonl` `settled` record contains every message of the turn.
- Relaunch the docs-audit room and confirm the reviewer's acknowledgement produces no notice.

## Closed — what was done

`RealAgent` now keeps two buffers: `textBuffer` for the message streaming and `turnMessages` for the
messages before it. `agent_start` pushes the finished message instead of discarding it; `prompt()`
clears both, because that is where a turn begins; `settleText` joins them with `"\n"` and falls back to
`get_last_assistant_text` only when the turn was empty.

The two probe questions:

1. **Retry re-sending a message inside one dispatch:** no evidence found, so nothing was added for it.
   A `shortcut:` comment names the limit at the push site. If a provider is seen repeating a message,
   the fix is a dedupe there, not a return to per-message resets.
2. **`text_end` per message:** handled — it replaces the *current* message, and the boundary push keeps
   the earlier ones. A test covers a per-message `text_end`.

The related cosmetic defect is fixed too: a message boundary now emits a newline into the room stream
when the previous message did not end with one, so the live run's `…their files.go` becomes two lines.

Proof: two stubs in `test/pi-protocol.test.ts`. Controls, each turned red and restored: no message
accumulation (both red), settle ignoring earlier messages (both red), no boundary newline (one red).
End-to-end against a two-message stub room: `messages.jsonl` records
`Got it: verify the tally\ngo\nDONE` and no "silent pickup" notice appears.
