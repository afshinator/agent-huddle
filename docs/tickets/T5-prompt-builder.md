# T5 — Prompt builder

Depends: T1
Spec: `../SPEC.md` §5

## Goal

Build each agent's spawn prompts: role prompt (`--system-prompt`) + social contract (`--append-system-prompt`), plus the lead's DoD block.

## Files

- create: `src/prompts.ts`, `test/prompts.test.ts`

## DoD

- [ ] `buildRolePrompt(agent, config)` = `role` + `system_prompt` (or `system_prompt_file` content).
- [ ] `buildSocialContract(agent, config)` fills `{handle}`, `{roomName}`, `{role}`.
- [ ] `buildLeadPrompt(config)` appends the DoD block (`The definition of done is: {…}` + the `DONE` instruction).
- [ ] golden tests assert exact text; `bun test` green; `tsc --noEmit` clean.

## Notes

- `system_prompt_file` is read from disk (path resolved by T1); missing file = load error.
- Social-contract and lead text are §5 verbatim.
