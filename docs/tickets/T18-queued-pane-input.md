# T18 — A line that has to wait says so

**Status:** done · **Found:** run `002-ticket-64`, 2026-11-21 22:35 · **Severity:** typed input looks
ignored, then speaks minutes later as an instruction nobody remembers writing

## What happened

A two-line message was pasted into `@dev1`'s pane. The inbox reported both lines, 490 ms apart
(`pane.input` telemetry at 22:35:18.144 and 22:35:18.634). The first was submitted; the second went into
`Coordinator.submitQueue` behind the chain that was already running.

That chain then halted on a settle timeout nineteen minutes later, and the second line — a fragment,
`new queries. Then say whether the ask is doable as written.` — started a chain of its own. From the room's
side it was input from nowhere; from the human's side the pane had looked dead the whole time.

`submitQueue` serialises submits on purpose (a second chain must not race the first), and pane input has
no way to refuse a line. So the only thing missing was the room saying that a line is waiting.

## What was built

`Coordinator.submit` counts what is already in flight and, when a submission has to wait, prints one dim
notice before queueing it:

```
· queued behind 1 run for @dev1: new queries. Then say whether the ask is doable as written.
```

It names the agent the line is for, so a fragment pasted for one agent cannot be mistaken for a room-wide
instruction, and it truncates at 60 characters so a long paste does not flood the transcript. The line is
still dispatched when the queue reaches it; it is now visible while it waits.

## Definition of done

1. A submit that has to wait prints exactly one `· queued behind N run(s) for @agent: …` notice.
2. A submit that can start immediately prints nothing extra.
3. The queued line still dispatches when its turn comes, and the chain order is unchanged.
4. `bun run check` green.

## Test

`test/coordinator.test.ts` — hold the first chain's turn, submit a second line for `@dev1`, and require the
notice while the first turn is still held; then release and let both finish.

## Not done, deliberately

- **Coalescing a pasted paragraph into one message.** Each newline is a line, and each line is a message;
  with the notice, a fragment is at least attributable to the pane it came from. Merging by arrival window
  would need a delay on every typed line, which costs the responsiveness that makes the pane usable.
- **Refusing input while a chain runs.** The queue is the useful behaviour; hiding it was the defect.
