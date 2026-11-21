# T12 — what each turn cost, not what each agent cost

**Status:** done.

## Problem

`summary.json` and the spend block report one total per agent for the whole run (#76). That answers
"what did this run cost" and nothing else. The first live ticket run spent 1.65 M tokens, 1.31 M of
them in dev1's session, and the room could not say which turn ate them: the install, one exploration
phase, the red tests, the full gate, or the commit. The only way to find out was to guess from the
transcript — which is how a claim like "the install and the suite dominate" gets made without evidence.

## What changes

After a turn settles, the coordinator asks the session for its stats and appends a `stats` record to
that agent's `log.jsonl`, holding the **delta** since the previous record:

```json
{"ts":"…","event":"stats","text":"{\"tokens\":31240,\"cost\":0.0001,\"toolCalls\":9}"}
```

- The record is written **before** the `settled` line, so a turn's stats fall inside the turn the
  timing readout already segments.
- Deltas, not totals: a cumulative number repeated per turn says nothing about any single turn.
- A provider that reports no cost yields `cost: null` for that turn, never `0` (#76's rule).
- Stats the provider never answers are skipped, with the same 5 s race the spend block uses.

`bun src/timings.ts <run-dir>` gains the per-turn spend on the same line as the timings:

```
dev1  2026-11-21T20:15:36Z  total 179.4s  first 2.98s (delta)  tools 50.8s  longest 42.7s after tool_start → tool_end  31240 tokens · $0.0001
```

## Definition of done

1. A settled turn writes a `stats` line with the delta, before `settled`, in that agent's log.
2. A second turn writes the delta it spent, not the running total. Without stats available it writes
   nothing, and the turn still settles.
3. `turnTimings` carries `tokens` and `cost` for the turn, and `formatRun` prints them when present.
4. A log written before this change reads exactly as it does today — no stats line, no crash.

## Proof

- `test/timings.test.ts`: a turn containing a `stats` line reports its tokens and cost; a turn without
  one reports `tokens: 0`, `cost: null`.
- `test/coordinator.test.ts`: with the fake reporting 1500 tokens and `$0.12`, the log holds a `stats`
  event whose text parses to those numbers, and it precedes `settled`.
- Existing suites unchanged and green.
