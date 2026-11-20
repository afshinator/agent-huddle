# Status — v1.1

Version: **v1.1** · 2026-11-20 · commit `93737d8` · spec: [`SPEC.md`](SPEC.md) · decisions:
[`decisions.md`](decisions.md) · evidence: [`runs/`](runs/), [`rca/`](rca/)

Capabilities listed here are backed by a test or a live run. Each claim names its evidence: a run note
under `runs/`, a live adapter test, or a test file. Anything unproven is listed under **Not proven**
rather than softened.

## What it does

**A room, defined by one YAML file.** `rooms/*.yaml` declares the lead and specialists: id, handle,
role, prompt (inline or file), provider, model, thinking level, tool allowlist, `pane_writable`. Room
keys: `name`, `room_dir`, `task`, `definition_of_done`, `max_hops` (12), `turn_timeout_ms` (300000),
`launch_guard` (`warn`), `lead`, `agents`. Unknown keys are rejected; reserved handles (`@all`,
`@everyone`, `@lead`) are rejected naming the offending field; the handle grammar lives once in
`src/router.ts` and is derived from it, never restated.

**Real agent sessions.** One `pi --mode rpc` child per agent, one persistent `--session-dir` each,
spawned with its own system prompt, provider, model, thinking level and `--tools` allowlist.

**Mentions decide who acts, nothing else.** `@agent` dispatches those agents, `@all` dispatches
everyone, `no mention activates nobody` — the message is still delivered to every agent as context, so
information can be shared without starting work. The startup `task:` is the one exception: it targets
the lead. A reply's mention of **its own author** is ignored.

**Bounded, observable chains.** Hops count against `max_hops`; at the cap the lead gets one wrap-up
prompt and each dispatched specialist one concluding turn, then a `hop_limit_reached` halt. The chain
completes only on the lead's line that is exactly `DONE`. Agent failure, abort or a dead child halts
with a `notice` and marks the agent `error`.

**Two input channels, one conversation.** The coordinator's terminal is the room: its stdin takes
supervisor messages, its stdout prints every message and notice. An agent's pane also takes input: a
line typed there is posted as a public message addressed to that agent (`@dev1 check the parser`),
visible to everyone, activating only that agent. There is no private channel.

**Panes show the agent's work, not its log.** One pane per agent tailing `agents/<id>/output.log`:
streamed prose, one blank line per turn, one `[tool] <name> <args>` line per tool call, lifecycle lines
(`[started]`, `[error] …`, `[exited]`). `agents/<id>/log.jsonl` keeps the JSON records for analysis and
no pane reads it. `pane_writable: false` gives a tail-only pane behind a read-only banner.

**A boot guard against writing into someone's tree.** Agents inherit the coordinator's cwd and write
real files there. Before the first spawn, if that cwd is a git repository root, `launch_guard: warn`
logs one record naming the directory and branch; `refuse` stops boot with one line and exit 1, before
any agent spawns, pane opens, or room file is written; `off` skips the check.

**Durable, damage-tolerant state.** `messages.jsonl` (append-only; a truncated final line is skipped
and counted), `state.json` (recoverable cache, atomic write, terminal status on shutdown),
`telemetry.jsonl` (OTel-shaped: `chain` and `agent.turn` spans, `agent.settle_latency_ms`,
`room.hops_total`, balanced `room.active_chains`, one `context.push` per push, `pane.input` per typed
line), plus per-agent session dirs, `output.log`, `inbox` and `pane.sh`.

**Clean lifecycle.** Ctrl-C/SIGTERM stops the inbox poll, stops agents, closes the panes it opened,
flushes telemetry, writes `state.json`, exits 0. A failed boot rolls back the agents and panes it
started.

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

## Proven against the real thing (`test:live`, and probes)

| Behaviour | Evidence |
|---|---|
| Real `pi`: spawn → prompt → settle → last text; `pushContext` produces no reply | `test/pi-real.integration.test.ts` |
| Real `herdr`: pane opens, tails a file, `close` spares the child process | `test/herdr-real.integration.test.ts` |
| Real `herdr`: a line typed into a writable pane reaches the agent's inbox | `test/herdr-real.integration.test.ts` |
| Real `pi` emits `tool_execution_start`; the client maps it to one `tool` event | probe, #39 close (`deepseek-v4.1-flash`, `bash` → `{"command":"echo tool-marker"}`) |
| A startup task drives lead → specialist → `DONE` through the real RPC framing and persists room state | `test/coordinator.integration.test.ts` |

## Proven by test only

| Behaviour | Test |
|---|---|
| No mention activates nobody; everyone still gets the text as context; one notice | `test/turn-loop.test.ts`, #35 |
| A startup task with no mention still targets the lead | `test/turn-loop.test.ts` |
| Panes tail readable prose, not JSON; no record braces; `log.jsonl` unchanged | `test/coordinator.test.ts`, `test/agent-stream.test.ts` |
| Tool calls render as one `[tool]` line; the settled text is not printed twice | `test/agent-stream.test.ts`, `test/coordinator.test.ts` |
| A pane line becomes `@dev1 <line>` from the supervisor, `mentions: ["dev1"]` | `test/coordinator.test.ts`, #37 |
| `pane_writable: false` opens a read-only pane and ignores the inbox | `test/coordinator.test.ts` |
| Inbox lines are consumed once and never replayed after a restart | `test/pane-inbox.test.ts` |
| The real client maps `tool_execution_start` to a `tool` event (stub pi, real framing) | `test/pi-protocol.test.ts` |
| `launch_guard` refuse / warn / off, and a refusal writes no room files | `test/coordinator.test.ts`, `test/launch-guard.test.ts`, #38 |

## Not proven

- **No manned run of v1.1.** Every v1.1 behaviour above is proven by test or by a live adapter test,
  not by a supervised room.
- A `[tool]` line, or readable prose, seen in a real `herdr` pane during a live room run. The three
  pieces (stream file, pane tail, client mapping) are tested separately, never together.
- Typing into an agent pane **during an active chain**. The line queues behind the chain via `submit()`,
  which is tested with fakes; the felt behaviour is unverified.
- The `warn` record in a real room: the CLI refusal was run, the warning was not.
- A provider other than `commandcode` (deepseek-v4-pro, deepseek-v4.1-flash); one provider is measured.
- Behaviour with more than two agents, or with `@all` in a manned room.
- Crash (SIGKILL) of the coordinator: panes from that run are not tracked and will leak.
- `definition_of_done` is never checked; `DONE` is the lead's self-certification.

## Known limits

- **No sandbox.** Agents inherit the coordinator's cwd and write real files there: run #2's specialist
  created `src/rate-limiter.ts`, `test/rate-limiter.test.ts` and a `shrink/` directory in the repo and
  ran `bun run check` against them (all removed since). `launch_guard` warns about the repository root but does not prevent
  it, and a launch from a **subdirectory** of a repository is not flagged at all.
- **No validation of reports.** A specialist replied with the literal text `@lead` and the lead signed
  off with `DONE`.
- **No reroute.** A failed agent halts the chain; the lead does not re-dispatch.
- **One room per process.** No multi-room, and an in-flight chain is not resumed across restart
  (`chain` is rebuilt as `null`).
- **Tool arguments print verbatim**, cut at 200 characters: a call carrying file contents or a token
  shows it in the pane.
- **Telemetry during a write outage is lost** (no buffering, by design; reported once on stderr).
- **Panes from a previous crashed run are unidentifiable** — pane ids are not recorded across runs.
- **A model that declines to use a tool produces no `tool` line**, and no test asserts otherwise: a
  model's choice is not a check.

## v1 (superseded 2026-11-20, commit `2cc434a`)

v1's claims and their evidence are unchanged in [`runs/`](runs/) and were carried forward above. Four
v1 behaviours were deliberately replaced:

| v1 | v1.1 | Why |
|---|---|---|
| A message with no mention routed to the lead | activates nobody; everyone still ingests it | "nobody acted" was indistinguishable from "the lead declined" (D6, #35) |
| Agent panes tailed `log.jsonl` (one JSON record per token fragment) | panes tail `output.log`, rendered prose + tool lines | the pane showed a log dump with a chat label (D7, #36, #39) |
| Panes were read-only | panes are writable by default; a typed line is a public message to that agent | talking next to the agent you mean, with no private channel (D7, #37) |
| Nothing stopped a room writing into the repo root | `launch_guard` warns or refuses at boot | a run's test files became part of the repo's own suite (#38) |

## How to update this file

Bump the version line on a release. Keep the previous version's claims — move the ones that no longer
describe the code into a `## v<N>` section with what replaced them, rather than deleting them silently.
Attach a run note, a live test, or a test file to every capability added. A capability without any of
those belongs under **Not proven**.
