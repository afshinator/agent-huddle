# T17 — The transcript must show replies in the order they were said, and must not let a reply answer a superseded message

**Status:** open · **Found:** run `003-ticket-54`, 2026-11-22 00:57 · **Severity:** a reader watches the lead
ask for a verdict that is already on screen, then sees the review done twice

## What the reader saw

```
00:57:11  [reviewer] Got it: … @lead go — criteria 1–9 pass: …          ← the verdict
00:57:19  [lead]     Waiting on @reviewer's verdict on cd8e59a — no action until it lands
00:57:23  [reviewer] Got it: verdict based on `git show cd8e59a` …      ← the same verdict again
00:57:37  [lead]     … @reviewer's verdict: `go`, criteria 1–9 pass … DONE
```

The reviewer did come back, twice, before `DONE`. The transcript reads backwards, and the line that reads
as "the lead ignored the verdict" is why the reviewer was asked a second time.

## Why, exactly

Two replies settled in the same millisecond — the reviewer's verdict and dev1's "standing by" — and both
addressed the lead. The room de-duplicates an agent inside one round, so the lead was dispatched twice, in
queue order:

```
00:57:11 from=dev1     targets=reviewer queued=lead  hop=9
00:57:11 from=reviewer targets=lead     queued=lead  hop=9
```

The first prompt carried dev1's superseded message, so the lead's answer — "still waiting" — was true of
the text it was given and false of the room. That answer named `@reviewer`, which bought the second review
turn.

`printMessage` (`src/coordinator.ts:652`) does not print the settled agent record at all: an agent's text
reached the room as it streamed (`src/chat-stream.ts`), which is what makes the room feel live. So the
display order is "when it was said", which is right; the defect is that an agent can be *asked* with
material that has already been overtaken, and the transcript carries no time to show it.

## What good looks like

The pattern every chat client and every group-chat agent framework uses: a total order by message time,
and a reply that is visibly attached to the message it answers. Ties are broken deterministically (time,
then author), and a reader never has to guess which line came first.

Here that means two changes, in this order of value:

1. **Do not hand an agent a superseded message.** When one round of replies addresses the same agent more
   than once, combine them into one prompt, labelled and in time order:

   ```
   @dev1 (00:57:11): Standing by — that dispatch is @reviewer's; no action from my lane.
   @reviewer (00:57:11): @lead go — criteria 1–9 pass: …
   ```

   One turn instead of two, no stale answer, one hop instead of two, and the agent can see that the second
   message is the newer one. This is the fix that removes the wrong line rather than explaining it.
2. **Put the time on the line.** `[lead] 00:57:37 ` — one timestamp in the prefix, taken from the message's
   own `ts`. Cheap, and it makes "which came first" checkable instead of inferred. Simultaneous messages
   print in arrival order, both of them, as they already do.

Deliberately **not** doing: buffering replies to print them in a sorted batch (delays the room for no
reason — the timeliness of streaming text is the thing that makes it watchable), and hiding or collapsing
duplicates (a reader should see that the reviewer was asked twice).

## Definition of done

1. Two replies that address the same agent in one round produce **one** prompt, containing both, ordered by
   time and labelled with author and time; that agent's turn answers both at once.
2. The hop count for that round drops by one, and `max_hops` accounting is unchanged elsewhere.
3. Every printed message carries the time it was said, to the second, in the prefix; a notice keeps its
   `·` form.
4. Streaming text still appears as it is written, not at settle.
5. A test with two agents settling in the same round shows one combined prompt and one lead reply, and the
   chat lines carry timestamps.
6. `bun run check` green.

## Red test

`test/turn-loop.test.ts`: two agents both scripted to answer a single lead message — one reply naming
`@lead` directly, one needing the upward report — then assert `pi.calls` holds **one** `prompt` for the lead
whose message contains both texts with their authors. Today it holds two.

`test/coordinator.test.ts`: assert the printed prefix matches `/^…\[lead\] \d\d:\d\d:\d\d /`.

## Out of scope

- Threading or per-message reply-to links in the transcript; the author-and-time label is enough to read it.
- Anything about how the room decides who speaks next (that is D18).
- The acknowledgement line (`Got it:`) — noted, no action (see T16 for what was ruled out).
