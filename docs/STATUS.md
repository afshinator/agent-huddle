# Status — v1.1

Version: **v1.1** · 2026-11-20 · code at commit `7676219` · spec: [`SPEC.md`](SPEC.md) · decisions:
[`decisions.md`](decisions.md) · evidence: [`runs/`](runs/), [`rca/`](rca/)

Capabilities listed here are backed by a test or a live run. Each claim names its evidence: a run note
under `runs/`, a live adapter test, or a test file. Anything unproven is listed under **Not proven**
rather than softened.

## What it does

**A template owns a kind of room; a run owns one ask.** `rooms/templates/<type>/` is tracked and holds
the template plus its prompts and its `launch.sh`. A run is a small file naming `template:` plus `task`,
`definition_of_done` and any budget it overrides, and its collateral — the resolved config, a snapshot of
the prompts that ran, the ask, notes and the room's runtime — lives in the gitignored `_run/<NNN>-<slug>/`
in the repo the room runs in (D13). The ordinal is creation order, so `ls _run/` reads as a history, and
re-running the same `--slug` reuses that directory.

**A room, defined by one YAML file.** A template (or a standalone room file) declares the lead and
specialists: id, handle,
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
real files there. Before the first spawn, if that cwd is a git repository root *and not a linked
worktree*, `launch_guard: warn` logs one record naming the directory and branch and prints one line;
`refuse` stops boot with one line and exit 1, before any agent spawns, pane opens, or room file is
written; `off` skips the check. A linked worktree is a repository root but a throwaway one, and it is
where a supervised room belongs, so the guard leaves it alone (#48).

**Durable, damage-tolerant state.** `messages.jsonl` (append-only; a truncated final line is skipped
and counted), `state.json` (recoverable cache, atomic write, terminal status on shutdown),
`telemetry.jsonl` (OTel-shaped: `chain` and `agent.turn` spans, `agent.settle_latency_ms`,
`room.hops_total`, balanced `room.active_chains`, one `context.push` per push, `pane.input` per typed
line), plus per-agent session dirs, `output.log`, `inbox`, `pane.sh` and `stderr.log` (the child's own stderr, kept out of the room unless `PI_STDERR=1`).

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
| Readable prose and one `[tool] …` line per call in real `herdr` panes | #3 |
| A line typed into an agent's pane during an active chain becomes a public `@that agent` message and dispatches it | #3 |
| `launch_guard: warn` records the repo root and branch at boot | #3 (record only — see #48) |

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
| A linked worktree is left alone by both `warn` and `refuse`; a main checkout is not | `test/launch-guard.test.ts`, `test/coordinator.test.ts`, D12, #48 |
| The fake and the real `PiAgentClient` agree on what a stop does to a turn in flight | `test/client-parity.test.ts`, #52 |
| The test harness fails a test that ends with a chain still running, naming it | `test/coordinator.test.ts`, #53 |
| `AH_DEBUG=1` traces boot, the signal, each stop and each child's exit with code and signal | `test/debug.test.ts`, `test/pi-protocol.test.ts`, `test/coordinator.test.ts`, #55 |
| A startup task that names agents dispatches only the lead, and pushes the text to the named agents as context | `test/turn-loop.test.ts`, #57 |
| The room prints its banner (name, handles, run dir, ask, transcript) and the measured layout before dispatching, and appends every line to `room.log` | `test/coordinator.test.ts`, `test/room-log.test.ts`, #59 |
| An agent's prose reaches the room from the stream deltas, before the turn settles; the settled text is not printed twice, and a dying turn closes the line | `test/chat-stream.test.ts`, `test/coordinator.test.ts`, #63 |
| An agent's pane stream belongs to one boot: truncated on open, `log.jsonl` still append-only, and the pane clears herdr's restored scrollback first | `test/agent-stream.test.ts`, `test/pane-command.test.ts`, `test/coordinator.test.ts`, #61 |
| A pane opens with `@handle — idle, never dispatched · slot n/m` and marks `@handle — working` once per turn, so an unused pane cannot read as activity | `test/coordinator.test.ts`, #62 |
| The agent pane carries tool calls and lifecycle lines, never the agent's prose | `test/coordinator.test.ts`, `test/agent-stream.test.ts`, #65 |
| Only a speaking message's prefix takes the agent's colour; a handle named in text stays plain | `test/chat-stream.test.ts`, `test/coordinator.test.ts`, #70 |
| A room note prints dim, so it cannot be read as somebody speaking | `test/coordinator.test.ts`, D19 |
| A pane title is plain: herdr prints it as text, so an escape shows literally — measured live | `test/coordinator.test.ts`, D17 |
| A turn's settled text is every assistant message it contains, and a message boundary starts a new room line | `test/pi-protocol.test.ts` (two stubs), `docs/tickets/T11-settled-text-per-turn.md` |
| `dispatch_scope: anyone` (default) dispatches every mention; `lead` makes a peer's mention context | `test/turn-loop.test.ts` (both scopes), `test/config.test.ts`, D18 |
| The startup task prints as a brief block and notices as `·`, never as a participant's message | `test/coordinator.test.ts`, D19 |
| The caller decides colour; the coordinator cannot see a terminal through a wrapped stdout | `src/index.ts`, `test/coordinator.test.ts`, #67 |
| A direct mention must be acknowledged with `Got it: …` (scope `lead` by default, `anyone` on request); a broadcast or the startup task need not, and a missing acknowledgement appends one notice naming the agent | `test/turn-loop.test.ts`, `test/prompts.test.ts`, #60 |
| A room's `pi` children are spawned with `PI_TEST_INTEGRATION=0`, so an agent running the suite opens no panes | `test/pi-protocol.test.ts`, #58 |
| A run overlays a template: ask from the run, agents from the template; an agent of the same id is replaced whole; a run may not set `name` | `test/config-template.test.ts`, D13 |
| A run's collateral is self-contained: resolved config plus prompt snapshot reload to the same room | `test/room-run.test.ts`, `test/config-template.test.ts` |
| Run directories are numbered in creation order, and a rerun reuses its directory | `test/run-slug.test.ts` |
| Every shipped template loads, and no template's prompts sit outside its own directory | `test/rooms.test.ts` |

## Not proven

- **Nothing beyond two agents.** Run #3 used one lead, one specialist, one provider and a two-turn task.
  `@all`, three or more agents, a lead that refuses to emit `DONE`, a chain that reaches `max_hops`, and a
  reviewer that pushes work back to another specialist are unproven in a manned room. `rooms/templates/docs-audit`
  is a three-agent room staged for exactly that; until it runs, three agents are configuration, not behaviour.
- **The template/run launcher is verified only up to the boot.** `launch.sh` was exercised with `--dry-run`
  against a throwaway repo: collateral written, worktree created (branch and detached), resolved config
  loads. No room has been booted through it yet, so the last step — exec with the resolved config and
  `room_dir` pointing at `_run/` — is unproven in a real launch.
- A provider other than `commandcode` (deepseek-v4-pro, deepseek-v4.1-flash); one provider is measured.
- Crash (SIGKILL) of the coordinator: panes from that run are not tracked and will leak.
- `definition_of_done` is never checked; `DONE` is the lead's self-certification.
- The `launch_guard` **refusal** path was run through the CLI (#38) but not in a real room: nobody has
  watched `refuse` stop a boot at the terminal. The other half is proven both ways: a linked worktree is
  left alone under `refuse`, and a main checkout is refused (`test/launch-guard.test.ts`, `test/coordinator.test.ts`).
- A pane line typed while **no** chain is active, and a pane line typed into a `pane_writable: false`
  pane, are proven by test only.

## Known limits

- **An agent cannot run the live adapter tests from inside a room.** Every `pi` child is spawned with
  `PI_TEST_INTEGRATION=0` (#58), so a `bun test` inside a room skips the `herdr`/`pi` integration
  tests. That is deliberate: those tests open real panes, and one launch showed them appearing
  beside the room.
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
- **`launch_guard` cannot see a launch from a subdirectory** of a repository, and a worktree of the tree
  you care about is indistinguishable from a throwaway one.
- **Pane text carries noise a clean run should not have** (run #3): a lead turn with no text is committed
  as an empty `agent` message (#49). (#50's child stderr and #51's false `[error]` are fixed.)
- **A run's collateral is only as good as the machine it ran on.** `_run/<NNN>-<slug>/` is gitignored, so a
  run is reproducible from its snapshot but not shareable: the resolved config and prompt copy die with the
  checkout. What survives a merge is the run's output, and a run note only if the ask produced one.
- **Run numbering assumes the launcher.** A hand-made `_run/<name>/` is ignored when counting, and two
  launchers started at the same moment can pick the same ordinal — nothing locks.
- **`_run/` being ignored is the repo's job, not the launcher's.** `launch.sh` warns when `_run/` is not in
  `.gitignore` and then writes there anyway.
- **The tool-substitution rules are enforced outside this repo.** `sed -n` file slices, heredoc file writes,
  interpreter rewrites and `git add -A` are refused by a user-level agent extension, so a clone gets the rules
  in `AGENTS.md` without the check.

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
