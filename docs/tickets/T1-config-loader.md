# T1 — Config loader

Depends: none
Spec: `../SPEC.md` §3
Status: done

## Goal

Parse and validate a YAML team template into `LoadedConfig` (§3.1), with fail-fast validation and absolute-path resolution.

This ticket also establishes the project skeleton (first code ticket).

## Scaffold

- `package.json` — bun; devDep `typescript`; dep `yaml`; scripts `test: bun test`, `typecheck: tsc --noEmit`.
- `tsconfig.json` — strict, ESM.
- `rooms/example.yaml` — fixture matching §3 (lead + dev1 + dev2 + reviewer).

## Files

- create: `package.json`, `tsconfig.json`, `src/config.ts`, `test/config.test.ts`, `rooms/example.yaml`

## DoD

- [ ] `bun test` green: valid config loads; `max_hops` defaults to 12; `room_dir` derived from `name` when omitted; `system_prompt_file`/`room_dir` resolved to absolute paths.
- [ ] rejects: unknown keys; `system_prompt` + `system_prompt_file` together; duplicate agent ids (across lead + agents).
- [ ] `tsc --noEmit` clean.

## Notes

- Copy the `LoadedConfig`/`RoomConfig`/`AgentSpec`/`ThinkingLevel` types from §3.1 exactly.
- Model strings are passed through verbatim; no validation against `pi`.
