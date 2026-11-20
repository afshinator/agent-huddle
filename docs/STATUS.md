# Status — v1

Version: **v1.0** · 2026-11-20 · commit `2cc434a` · spec: [`SPEC.md`](SPEC.md) · decisions:
[`decisions.md`](decisions.md) · evidence: [`runs/`](runs/), [`rca/`](rca/)

Capabilities listed here are backed by a test or a live run. Each live claim names the run it came
from; anything unproven is listed under **Not proven** rather than softened.

## What it does

**A room, defined by one YAML file.** `rooms/*.yaml` declares the lead and specialists: id, handle,
role, prompt (inline or file), provider, model, thinking level, tool allowlist. Room keys:
`name`, `room_dir`, `task`, `definition_of_done`, `max_hops` (12), `turn_timeout_ms` (300000),
`lead`, `agents`. Unknown keys are rejected; reserved handles (`@all`, `@everyone`, `@lead`) are
rejected naming the offending field; the handle grammar lives once in `src/router.ts` and is derived
from it, never restated.

**Real agent sessions.** One `pi --mode rpc` child per agent, one persistent `--session-dir` each,
spawned with its own system prompt, provider, model, thinking level and `--tools` allowlist.

**One input channel.** `bun src/index.ts rooms/example-2.yaml` in a herdr pane. Routing: `@agent`
dispatches those agents, no mention routes to the lead, `@all` dispatches everyone, and a reply's
mention of **its own author** is ignored. Unmentioned agents get the message as context with no turn.

**Bounded, observable chains.** Hops count against `max_hops`; at the cap the lead gets one wrap-up
prompt and each dispatched specialist one concluding turn, then a `hop_limit_reached` halt. The chain
completes only on the lead's line that is exactly `DONE`. Agent failure, abort or a dead child halts
with a `notice` and marks the agent `error`.

**Durable, damage-tolerant state.** `messages.jsonl` (append-only; a truncated final line is skipped
and counted), `state.json` (recoverable cache, atomic write, terminal status on shutdown),
`telemetry.jsonl` (OTel-shaped: `chain` and `agent.turn` spans, `agent.settle_latency_ms`,
`room.hops_total`, balanced `room.active_chains`, one `context.push` per push), plus per-agent session
dirs and logs.

**Clean lifecycle.** Ctrl-C/SIGTERM stops agents, closes the panes it opened, flushes telemetry,
writes `state.json`, exits 0. A failed boot rolls back the agents and panes it started.

**Panes mirror the room.** One read-only pane per agent tailing its log; closing a pane hides it
without killing the agent; panes close on shutdown.

## Proven live (`runs/`)

| Behaviour | Run |
|---|---|
| Routing lead → specialist → lead; hop counting | #1, #2 |
| Context push reaches an unmentioned agent's context | #1 |
| `DONE` accepted from a real model; 3-hop chain completes | #2 |
| A 201.5s turn completes under the 300s timeout | #2 |
| Self-mention does not re-dispatch the author | #2 (4 hops → 3) |
| Panes open with the right labels, `close` spares the child, panes close on shutdown | #1, #2 |
| Telemetry spans, latencies, balanced `active_chains` | #1, #2 |
| Ctrl-C mid-turn → exit 0, telemetry flushed | #2 |
| Killed `pi` child → notice, agent `error`, chain halted | #2 |

## Not proven

- A provider other than `commandcode` (deepseek-v4-pro, deepseek-v4.1-flash); one provider is measured.
- Behaviour with more than two agents, or with `@all` in a manned room.
- Crash (SIGKILL) of the coordinator: panes from that run are not tracked and will leak.
- `definition_of_done` is never checked; `DONE` is the lead's self-certification.

## Known limits

- **No sandbox.** Agents inherit the coordinator's cwd and write real files there: run #2's specialist
  created `src/rate-limiter.ts`, `test/rate-limiter.test.ts` and a `shrink/` directory in the repo and
  ran `bun run check` against them.
- **No validation of reports.** A specialist replied with the literal text `@lead` and the lead signed
  off with `DONE`.
- **No reroute.** A failed agent halts the chain; the lead does not re-dispatch.
- **One room per process.** No multi-room, and an in-flight chain is not resumed across restart
  (`chain` is rebuilt as `null`).
- **Telemetry during a write outage is lost** (no buffering, by design; reported once on stderr).
- **Panes from a previous crashed run are unidentifiable** — pane ids are not recorded across runs.

## How to update this file

Bump the version line on a release, keep the previous version's claims in a `## v<N>` section rather
than deleting them, and attach a run note or test name to every capability added. A capability without
either belongs under **Not proven**.
