# agent-huddle

Config-driven multi-agent chat room for [`pi`](https://github.com/earendil-works/pi) sessions managed from a shared terminal room and optional [`herdr`](https://herdr.dev/) panes.

## Status

v1 implementation is complete. The specification is in [`docs/SPEC.md`](docs/SPEC.md), with the implementation slices in [`docs/tickets/`](docs/tickets/).

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

The coordinator's terminal is the shared chat room:

- **stdin**: supervisor messages
- **stdout**: formatted room messages
- `@agent` or multiple handles: target named agents
- `@all` / `@everyone`: target the whole team
- no mention: route to the lead
- unknown-only mentions: append a notice and dispatch nobody

When running inside a Herdr-managed pane (`HERDR_ENV=1`), the coordinator opens one read-only log pane per agent. Closing an agent pane hides its log and does not stop that agent's `pi` process.

## Room files

A room's `room_dir` contains:

- `messages.jsonl` — append-only shared room log
- `state.json` — live/recoverable room state
- `telemetry.jsonl` — JSONL traces, logs, counters, histograms, and up/down counters
- `agents/<id>/sessions/` — persistent isolated pi session storage
- `agents/<id>/log.jsonl` — streamed agent lifecycle/output log

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
bun run typecheck
bun test
```

Implementation boundaries and test seams are documented in [`docs/SPEC.md`](docs/SPEC.md). The project deliberately excludes the source video's web UI, generative HTML, tracing dashboard, cron daemon, sub-rooms, and autonomous configuration changes.

Two rules earn their own documents: decisions whose reasons are not visible in the code go in [`docs/decisions.md`](docs/decisions.md), and a spec edit made *after* the code exists must say in its commit message which side moved and why.

## CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs `bun install --frozen-lockfile`, `bun run typecheck` and `bun test` on pushes to `main` and on pull requests. CI sets `PI_TEST_INTEGRATION=0`, so the live `pi`/`herdr` tests skip there; run them locally against a real environment.

The post-implementation review and environment retrospective are in [`docs/retro/2026-11-20.md`](docs/retro/2026-11-20.md); the root-cause analysis of why v1 produced 27 findings, and the process changes that came out of it, are in [`docs/rca/2026-11-20-v1-defects.md`](docs/rca/2026-11-20-v1-defects.md).
