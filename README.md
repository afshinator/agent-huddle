# agent-huddle

Software engineers team up and pair to tackle their work; why not use the same approach with agents and see what happens.

Config-driven multi-agent chat room for [`pi`](https://github.com/earendil-works/pi) sessions managed from a shared terminal room and optional [`herdr`](https://herdr.dev/) panes.  
 

## Status

v1.1 is implemented. The specification is in [`docs/SPEC.md`](docs/SPEC.md) and the decisions behind it in [`docs/decisions.md`](docs/decisions.md). What the app does today — each capability with the run or test behind it, and an explicit list of what is *not* proven — is in [`docs/STATUS.md`](docs/STATUS.md). For what is built, read that file rather than this one.

**A room's agents write real files into the directory you launch it from.** Run supervised rooms in a worktree or a branch you are willing to throw away, or their output lands in your working tree and their tests in your test run. The coordinator checks at boot ([SPEC §10](docs/SPEC.md#10-error-handling--process-lifecycle)): `launch_guard` is `warn` by default, and `refuse` stops the room before any agent starts.

## Requirements

- [Bun](https://bun.sh/)
- `pi` on `PATH`, configured for the providers/models in your team YAML
- `herdr` on `PATH` when using agent log panes; the coordinator also runs headlessly without Herdr

## Install and verify

```bash
bun install
bun run typecheck
bun test
```

The test suite includes deterministic unit/fake-seam tests and integration tests for the real `pi` and `herdr` adapters. Set `PI_TEST_INTEGRATION=0` to skip live integration tests. A room's own `pi` children are always spawned with `PI_TEST_INTEGRATION=0`, so an agent that runs the suite inside a room never opens real herdr panes (#58).

## Run a room

A **template** owns a kind of room — how many agents, their models, tools and prompts. A **run** owns
one ask. Templates are tracked, runs never are:

```
rooms/templates/<type>/template.yaml   # name, budgets, lead + agents, each with its prompt
rooms/templates/<type>/prompts/*.md    # the prompts that template uses
rooms/templates/<type>/launch.sh       # the only glue: prepare, worktree, boot
_run/<NNN>-<slug>/                     # gitignored: the ask, the resolved config, prompts snapshot,
                                       # room runtime, notes — everything this run produced or used
```

Start a room from its template, pointing at the repo whose code the agents will touch:

```bash
./rooms/templates/docs-audit/launch.sh --repo ~/dev/some-repo --slug 2026-11-20-audit --branch
```

The run directory is numbered in creation order (`001-docs-audit`, `002-…`), so `ls _run/` reads as a
history. Re-running the same `--slug` reuses that run's directory instead of starting a second one beside
it.

That writes a skeleton `_run/<NNN>-<slug>/run.yaml` and stops; edit the ask, run it again, and it prepares
`run.resolved.yaml` plus a snapshot of the prompts, creates a worktree at `../<repo>-<slug>` (branch
`run/<slug>` with `--branch`, detached without, when the run produces nothing to check in), and boots
the room there. Add `--dry-run` to prepare everything without booting.

A run file carries only what is specific to it:

```yaml
template: /path/to/rooms/templates/docs-audit/template.yaml
task: |
  What this run should do.
definition_of_done: |
  What makes it done.
max_hops: 20          # optional override; any template key except `name` may be overridden
```

An `agents:` entry in a run replaces the template's agent of that id **whole** (no field merge) and may
add an agent the template does not have. A run may not set `name`.

Nothing commits inside the room. After `DONE`, review the worktree, commit on `run/<slug>`, push, merge,
and `git worktree remove` it. The `_run/<NNN>-<slug>/` collateral stays behind on the machine that ran it.

Each agent gets a pane showing that agent's work as prose. The pane tails `<room_dir>/agents/<id>/output.log`; the JSON records stay in `agents/<id>/log.jsonl` for analysis and no pane reads them.

Before the first agent speaks the room prints a banner — its name, its handles, the run directory, the ask and where the transcript lives — followed by the measured tab shape it laid the panes out in. Every room line is also appended to `<room_dir>/room.log`, so closing the pane does not lose the run.

The pane also shows one `[tool] …` line per tool call, so you see what the agent actually ran.

Type in an agent's pane and the line becomes a public room message addressed to that agent (`@dev1 check the parser`): everyone sees it, only that agent runs. Set `pane_writable: false` on an agent to make its pane read-only behind a banner.

The coordinator's terminal is the shared chat room:

- **stdin**: supervisor messages
- **stdout**: formatted room messages
- `@agent` or multiple handles: target named agents
- `@all` / `@everyone`: target the whole team
- no mention: nobody is activated; every agent still receives it as context
- unknown-only mentions: append a notice and dispatch nobody

Panes need `HERDR_ENV=1`; without it the coordinator runs headless with the same routing and no panes.

A `pi` child's stderr is kept out of the room: it goes to `agents/<id>/stderr.log`. Set `PI_STDERR=1` to see it inline (prefixed `[pi:<id>]`) when diagnosing a child that misbehaves. Set `AH_DEBUG=1` to trace the room's own lifecycle to stderr — boot, signal, each agent stop, and each child's exit with code and signal — which is how you tell whether Ctrl-C reached the children before the coordinator's handler. Closing an agent pane hides it and does not stop that agent's `pi` process.

## Room files

A room's `room_dir` contains:

- `messages.jsonl` — append-only shared room log
- `state.json` — live/recoverable room state
- `telemetry.jsonl` — JSONL traces, logs, counters, histograms, and up/down counters
- `agents/<id>/sessions/` — persistent isolated pi session storage
- `agents/<id>/output.log` — the agent's pane text: prose plus one-line lifecycle events
- `agents/<id>/stderr.log` — the `pi` child's own stderr, which no longer reaches the room
- `agents/<id>/inbox` — lines typed into the agent's pane, read once by the coordinator
- `agents/<id>/pane.sh` — the script a writable pane runs (tail plus reader)
- `agents/<id>/log.jsonl` — the same activity as JSON records, for analysis

## Team YAML

The smallest useful template has a lead and specialist agents:

```yaml
name: tiny-factory
room_dir: ./rooms/tiny-factory
max_hops: 8

definition_of_done: |
  A tested implementation and a concise summary.

task: |
  Build the requested feature.

lead:
  id: lead
  handle: "@lead"
  role: "Coordinate the team and integrate results."
  system_prompt: "Delegate work; end a completed response with DONE."
  provider: commandcode
  model: deepseek/deepseek-v4-pro
  thinking: medium
  tools: [read, bash, edit, write, grep]

agents:
  - id: dev1
    handle: "@dev1"
    role: "Implement features and tests."
    system_prompt: "Report completed work to @lead."
    provider: commandcode
    model: deepseek/deepseek-v4.1-flash
    thinking: high
    tools: [read, bash, edit, write, grep]
```

`system_prompt` and `system_prompt_file` are mutually exclusive, and a prompt path resolves against the file that wrote it. Handles must be quoted in YAML because `@` is reserved in an unquoted YAML scalar. See [`rooms/templates/tiny-factory/template.yaml`](rooms/templates/tiny-factory/template.yaml) for a two-agent template and [`rooms/templates/docs-audit/template.yaml`](rooms/templates/docs-audit/template.yaml) for the three-agent audit room.

## Routing and completion

The coordinator routes only explicit targets. Every agent receives unmentioned room messages as context without an active turn, so agents stay current without replying unnecessarily. A chain is bounded by `max_hops`; after the cap, the lead receives one wrap-up nudge, then previously dispatched specialists receive one concluding turn. If the lead does not emit a line containing exactly `DONE`, the chain halts with a `hop_limit_reached` room notice and waits for human input.

## Development

```bash
bun run check        # typecheck, then tests — the same two commands CI runs
bun run test:live    # adds the live pi/herdr adapter tests (skipped by default)
```

Behaviour that the code cannot show is recorded in [`docs/decisions.md`](docs/decisions.md). Agent-facing pointers — gate, ticket loop, probe convention — are in [`AGENTS.md`](AGENTS.md).

Implementation boundaries and test seams are documented in [`docs/SPEC.md`](docs/SPEC.md). The project deliberately excludes the source video's web UI, generative HTML, tracing dashboard, cron daemon, sub-rooms, and autonomous configuration changes.

Two rules earn their own documents: decisions whose reasons are not visible in the code go in [`docs/decisions.md`](docs/decisions.md), and a spec edit made *after* the code exists must say in its commit message which side moved and why.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on pushes to `main` and on pull requests. CI sets `PI_TEST_INTEGRATION=0`, so the live `pi`/`herdr` tests skip there; run them locally against a real environment.

The post-implementation review and environment retrospective are in [`docs/retro/2026-11-20.md`](docs/retro/2026-11-20.md); the root-cause analysis of why v1 produced 27 findings, and the process changes that came out of it, are in [`docs/rca/2026-11-20-v1-defects.md`](docs/rca/2026-11-20-v1-defects.md).
