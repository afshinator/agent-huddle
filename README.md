# agent-huddle

Software engineers team up and pair to tackle their work; why not use the same approach with agents and see what happens.

Config-driven multi-agent chat room for [`pi`](https://github.com/earendil-works/pi) sessions managed from a shared terminal room and optional [`herdr`](https://herdr.dev/) panes.  
 

## Status

v1 implementation is complete. The specification is in [`docs/SPEC.md`](docs/SPEC.md), with the implementation slices in [`docs/tickets/`](docs/tickets/). What the app does today, each capability with the run or test behind it, is in [`docs/STATUS.md`](docs/STATUS.md); the spec has since moved to v1.1 in three places that are **not built yet** (issues #35–#37: no mention activates nobody, readable agent panes, writable pane input).

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

The test suite includes deterministic unit/fake-seam tests and integration tests for the real `pi` and `herdr` adapters. Set `PI_TEST_INTEGRATION=0` to skip live integration tests.

## Run a room

Run the coordinator from the terminal that should act as the shared room:

```bash
bun src/index.ts rooms/example-2.yaml
```

Each agent gets a pane showing that agent's work as prose. The pane tails `rooms/<room>/agents/<id>/output.log`; the JSON records stay in `agents/<id>/log.jsonl` for analysis and no pane reads them.

The pane also shows one `[tool] …` line per tool call, so you see what the agent actually ran.

Type in an agent's pane and the line becomes a public room message addressed to that agent (`@dev1 check the parser`): everyone sees it, only that agent runs. Set `pane_writable: false` on an agent to make its pane read-only behind a banner.

The coordinator's terminal is the shared chat room:

- **stdin**: supervisor messages
- **stdout**: formatted room messages
- `@agent` or multiple handles: target named agents
- `@all` / `@everyone`: target the whole team
- no mention: nobody is activated; every agent still receives it as context
- unknown-only mentions: append a notice and dispatch nobody

When running inside a Herdr-managed pane (`HERDR_ENV=1`), the coordinator opens one read-only log pane per agent. Closing an agent pane hides its log and does not stop that agent's `pi` process.

## Room files

A room's `room_dir` contains:

- `messages.jsonl` — append-only shared room log
- `state.json` — live/recoverable room state
- `telemetry.jsonl` — JSONL traces, logs, counters, histograms, and up/down counters
- `agents/<id>/sessions/` — persistent isolated pi session storage
- `agents/<id>/output.log` — the agent's pane text: prose plus one-line lifecycle events
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

`system_prompt` and `system_prompt_file` are mutually exclusive. Handles must be quoted in YAML because `@` is reserved in an unquoted YAML scalar. See [`rooms/example-2.yaml`](rooms/example-2.yaml) for a runnable two-agent fixture and [`rooms/example.yaml`](rooms/example.yaml) for the default four-agent roster.

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
