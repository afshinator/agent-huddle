# Run 001-docs-audit — 2026-11-21

The tally room, launched from `5f892ac`, after the resolved-config fix. It finished: `DONE` in the
room, `docs/DOCS-AUDIT.md` 3010 bytes in the worktree, 28 rows against 28 tracked `.md` files.

## What the timing record said about the pauses

Read with `bun src/timings.ts _run/001-docs-audit` **before** the readout was fixed (#76), so the
"first" column here counts from spawn, not from dispatch:

```
dev1      total 164.9s  first 10.04s (delta)   longest 111.5s after delta → delta
lead      total  6.6s   first 6.20s  (delta)   longest 6.2s  after spawned → delta
reviewer  total 187.4s  first 175.42s (delta)  longest 175.4s after spawned → delta
```

Two facts, once the boot-to-dispatch time is discounted:

- `dev1`'s longest wait was **111.5 s between two `delta` events**, with no tool in between. That is the
  model writing slowly, not a stall and not a tool. A single line of prose took nearly two minutes of
  wall clock to stream.
- The reviewer's "175 s" is the room waiting to dispatch it, not the reviewer working. That is what the
  readout now excludes.

No `settle timeout` notice appeared, and no `·` notice appeared: every reply that owed an acknowledgement
gave one, and every approval carried its evidence.

## Spend

`summary.json` was not written for this run — the spend block landed after it (`52ed5a5`). Nothing to
report here; the next run will say what each agent spent.

## Cleaned

The run's collateral, worktree and `run/001-docs-audit` branch were left behind by that request and removed
on 2026-11-25, after the audit was found stale: the branch held no commit that `main` did not already have,
and its `docs/DOCS-AUDIT.md` inventoried a tree that had moved (29 tracked `.md` files when 46 exist,
`decisions.md` 536 lines when it is 764, and a `docs/stryker-evaluation.md` that had been deleted).
This note and the numbers above are what survive.
