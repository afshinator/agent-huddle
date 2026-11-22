# T19 — A turn that works without printing says it is alive

**Status:** done · **Found:** run `004-ticket-55`, 2026-11-22 02:08 · **Severity:** a healthy turn is
indistinguishable from a hung one, and the human asks whether to kill it

## What happened

Gate 1 on #55: the reviewer was dispatched at 02:08:25.999, made its first tool call at 02:08:30.252, its
last at 02:09:08.148 — twenty tool calls — and emitted **no assistant text at all** until 02:09:17.153, when
its whole reply arrived in 6.7 seconds. dev1 behaved the same way: fifty-odd tool calls over seven minutes
and five text deltas in total.

Nothing was wrong with either agent. But `room.log` printed nothing between 02:09:23 and the end of dev1's
turn, so from outside the room had stopped: the panes said "working", the transcript said nothing, and the
only remaining question was whether the process had hung.

The two other silence mechanisms do not cover this. The idle nudge is suppressed while a tool runs, which
is right — `npm run check` is two silent minutes — and the pane's "working" mark lives in a pane, not in the
transcript a human reads back.

## What was built

`WORK_NOTICE_MS = 60_000`. While a turn is running and has printed no text, the room writes one dim notice
a minute:

```
· agent dev1: working — 180s, 41 tool calls, no text yet
```

It stops as soon as the turn prints anything: after that the agent's own words are the liveness signal, and
the heartbeat would be noise on top of them. It counts as a notice, never a hop, and never touches the
acknowledgement rule.

## Definition of done

1. A turn that works for longer than the window without printing produces the notice, naming the elapsed
   time and the tool count.
2. Once the turn prints, no further notice appears.
3. The notice is a room notice: no hop, no dispatch, no acknowledgement.
4. `bun run check` green.

## Test

`test/turn-loop.test.ts` — hold a turn, start a tool, require the notice; then stream a delta and require
the count to stop growing.

## Two prompt defects found in the same run

Both in `rooms/templates/ticket-resolver1/prompts/`, both fixed here:

- **The acknowledgement was batched with the result.** The prompt asked for `Got it:` as the first line of
  a reply, which a model satisfies by putting it in the one message it sends at the end. It now asks for a
  message of its own, before the first tool call, with no tool call in it.
- **The verdict line read as a rejection.** The template asked for `not doable / doable: <one line>`, so the
  reviewer wrote `not doable / doable: doable as written` — read at a glance as "not doable". It now asks for
  `verdict: doable — <why>`, one word, no slash.
