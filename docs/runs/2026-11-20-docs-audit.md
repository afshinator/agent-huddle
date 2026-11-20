# Docs audit run — three agents, one audit, one reviewer

Date: 2026-11-20 · config: `rooms/docs-audit.yaml` · worktree `../agent-huddle-docaudit`,
branch `docaudit` · not yet run.

Purpose: first room with **three** agents (lead, dev, reviewer), a pushback loop, and a
verification chain that ends in the lead rather than in the dev's own claim. Also the first run
under `launch_guard: refuse` from a linked worktree, which the guard is supposed to leave alone.

The job: audit every tracked markdown file against the code and write `docs/DOCS-AUDIT.md`. The
code is the source of truth; `runs/`, `retro/`, `rca/` and `tickets/` are historical and are
checked against the commit they describe.

## Setup

```bash
cd /Users/afshin/Documents/dev/agent-huddle
git worktree add ../agent-huddle-docaudit -b docaudit   # already created
cd ../agent-huddle-docaudit && bun install
# room pane in herdr, then:
./launch-docs-audit.sh
```

`max_hops: 16` (two pushback rounds), `turn_timeout_ms: 600000`, `launch_guard: refuse`.
Agents: `@lead` `deepseek/deepseek-v4-pro` medium, `@dev1` `deepseek/deepseek-v4.1-flash` high,
`@reviewer` `gpt-5.6-luna` high — three different models, so the reviewer is not the same voice
that wrote the audit.

## Checks

| Check | Pass criteria | How to look |
|---|---|---|
| 1 three agents boot | three panes, three `pi` children, `state.json` lists all three | `herdr pane list`, `state.json`, `agents/*/output.log` |
| 2 dev reads the code, not the docs | `docs/DOCS-AUDIT.md` rows cite `src/…:NN` or `commit abc123`; no row says "checked" | read the file |
| 3 reviewer verifies independently | reviewer names three findings it opened itself, and at least one problem the dev missed | `[@reviewer]` message in the room |
| 4 pushback round trip | one item goes reviewer → dev → reviewer, and the row changes | `messages.jsonl` hop count, `git diff docs/DOCS-AUDIT.md` |
| 5 lead verifies before DONE | lead's last message quotes a line it read itself; `DONE` arrives only after the reviewer's go | `messages.jsonl` order, `state.json` `chain: null`, `status: idle` |
| 6 `refuse` in a worktree | no refusal, no warning line: a linked worktree is not a repo root for the guard | room pane text, `telemetry.jsonl` |
| 7 hop budget holds | with two pushback rounds the chain still finishes under 16 hops | `state.json`, `room.hops_total` |

## Expected shape of the deliverable

`docs/DOCS-AUDIT.md`: a `Doc | Verdict | Evidence | Fix` table over every `git ls-files '*.md'`
entry, verdicts `current` / `stale` / `historical` / `unverified`, then one short section per
stale claim, then the counts.

## Cleanup

```bash
# from the room pane: Ctrl-C, wait for `[exited]` lines, exit 0
cd /Users/afshin/Documents/dev/agent-huddle
git worktree remove ../agent-huddle-docaudit   # after reviewing docs/DOCS-AUDIT.md
git worktree list                              # must not list the run dir
```

The audit document is the only thing worth keeping: copy it out of the worktree before removing it
if the branch is not merged.

## Findings

| Check | Result | Evidence |
|---|---|---|
| — | not run yet | — |
