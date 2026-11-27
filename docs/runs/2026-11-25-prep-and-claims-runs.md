# Runs 001–006 — the prep room, the claims gate, and one chain

Date: 2026-11-25 · six runs, all launched by `rooms/launch.sh` from the main checkout, all on the
`ticket-prep` template except 005 · evidence: `_run/001…006/` (gitignored, kept)

The six runs exist to watch the prep room do its three judgements on purpose-built smoke tickets, and
then to watch the chain a refusal starts. They are the reason `docs/STATUS.md` can say the prep chain
has run and its branches have been observed. Whether a run ended with the completion signal is a line
exactly `DONE`, so it is countable rather than remembered: `rg -c '^\s*DONE\s*$' _run/002-prep-reason/room.log`
is `0`, which is why that row says no `DONE`.

| run | ticket | template | what the room said | terminal |
|---|---|---|---|---|
| `001-prep-noop` | #72 | `ticket-prep` | `room.log:60` `**Verdict:** already-correct. The ask is valid and observable; nothing to repair.` | `DONE` |
| `002-prep-reason` | #73 | `ticket-prep` | `room.log:77` `**Verdict:** repaired — the one false supporting reason was cut` | no `DONE` — the lead refused to mark it done while `bun run check` was red for a pre-existing reason |
| `003-prep-noend` | #74 | `ticket-prep` | `room.log:63` the prep agent's own refusal, `:72` the lead's: "no observable end state … both agents refused, nothing published, label unchanged" | refusal is the terminal state; no `DONE` |
| `004-ticket-75-prep` | #75 | `ticket-prep` | `room.log:79` `**Verdict:** repaired.` | `DONE` |
| `005-ticket-75` | #75 | `ticket-resolver1-claims` | `room.log:85` "Resolved ticket #75 as not doable as written: … the criterion … already holds" | `DONE` |
| `006-ticket-77` | #77 | `ticket-prep` | `room.log:119` `**Verdict:** repaired.` | `DONE` |

## What the chain did, and how to see it

The first launch of #75 refused at the claims preflight and cleaned up after itself, then relaunched
into the prep room, which repaired the ticket, and the same command then ran the resolver room:

```bash
rg -n 'refused|Resolved ticket' _run/chain.out
# launch: claims preflight refused — removing …/agent-huddle-004-ticket-75 and …/_run/004-ticket-75
# Resolved ticket #75 as not doable as written: …
```

The re-run picked the claims room from the repaired body rather than from a flag — that decision is
`pickTemplate` over the ticket body, and the run records it on its first line:

```bash
head -1 _run/005-ticket-75/run.yaml    # template: …/templates/ticket-resolver1-claims/template.yaml
```

## Spend and timing, as the artefacts report them

Every number here is reproducible from `_run/`, so none of them is quoted as a fact you have to trust:

```bash
bun src/timings.ts _run/005-ticket-75     # per-turn totals for that room
bun src/timings.ts _run/001-prep-noop
```

Each turn line carries `total`, `first`, `tools`, the longest wait and its cause, plus the turn's
tokens and cost — the fields `docs/SPEC.md` §10 defines. 005 is the expensive one (one lead turn ran
minutes on a single audit); the four prep rooms each finish in seconds.

## What these runs do not prove

- **005 finished without doing the work.** Its criterion already held at `HEAD`, so the room closed
  the ticket as already-satisfied instead of changing code. The chain is proven; a code fix through
  the chain is not.
- **002 ended without `DONE`** on purpose: the lead would not certify a run whose suite was red for a
  reason outside the ticket. Treat that as the honest outcome, not a failed launch.
- **One observation per branch.** Each judgement was seen once, on a smoke ticket written to hit it.
  Nothing here says the prep room handles a real ticket's ambiguity the same way.
