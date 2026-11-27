# Runbook

The operating procedure for a supervised room. Everything here is a command you can copy; the
reasoning lives in `docs/SPEC.md` and `docs/decisions.md`.

A room is a **template** (agents, budgets, prompts) plus a **run** (an ask, a worktree, a branch). The
room's agents write real files, so every run happens in a linked worktree, and nothing is pushed.

## 1. Before the first run

- `bun`, `git`, `gh` (authenticated: `gh auth status`) on `PATH`.
- `herdr` on `PATH` for panes; without it the launcher runs headless.
- The target repo has `_run/` in its `.gitignore` (a warning, not a refusal — check it yourself).
- The target repo is a git working tree. Its uncommitted changes are not in the worktree; commit or
  accept that the room will not see them.

## 2. Start a ticket run

```sh
cd ~/Documents/dev/agent-huddle
./rooms/launch.sh --template ticket-resolver1 --repo ~/Documents/dev/finance-hub --issue 54 --slug ticket-54 --check
```

`--check` reports and creates nothing: the repo, `_run/` being ignored, the base commit and whether the
checkout is clean, whether `run/<slug>` is free, and whether `gh` is authenticated. Fix anything marked
`FAIL`; `warn` lines are yours to accept.

Then the same command with `--branch` (drop `--check`). It fetches the ticket, writes the ask, creates the
worktree, warms the dependencies, and boots. `--dry-run` does everything except boot.

The ask needs no editing. `--issue` writes the ticket's **whole body verbatim** into `task:` — its
constraints, its dependencies, its out-of-scope list — and its acceptance-criteria section into
`definition_of_done:`. Nothing about the ticket is left for you to retype.

**Preconditions that refuse the run.** Beyond the label, the launcher reads GitHub's native dependencies:
a ticket blocked by an open issue is refused, naming it (`blocked by #64 (open)`), and `--ignore-blockers`
is the deliberate override. Both sources are read: the native links, and `## Dependencies` lines that open
by naming what the ticket waits for. A ticket whose only block is prose still refuses — that is the case a
native-only gate would have waved through. A ticket can be `ready-for-agent` and still be unsafe to dispatch — #54 is
exactly that: triaged, and blocked by #64. The gate reads the tracker, not the prose in the body, so also
read the ticket's own Dependencies section.

**The ask, if you ever do need to change it.** Editing is optional, not a step. If you change
`_run/<run>/run.yaml`, relaunch the same command — an existing ask is kept, never regenerated:

```sh
# 1. write the ask and prepare everything, without booting
./rooms/launch.sh --template ticket-resolver1 --repo <repo> --issue 54 --slug ticket-54 --branch --dry-run

# 2. edit <repo>/_run/00N-ticket-54/run.yaml

# 3. boot with that ask: an existing run.yaml is kept, never regenerated
./rooms/launch.sh --template ticket-resolver1 --repo <repo> --issue 54 --slug ticket-54 --branch
```

Step 3 prints `reusing the ask at …`. Delete that file and re-run step 1 if you want it regenerated from
the ticket. The worktree is reused and the resolved config is re-prepared from your edited ask.

## 3. What you should see

1. A banner, the brief, and a layout line; three panes titled `🟨 @lead` `🟦 @dev1` `🟪 @reviewer`.
2. The lead's triage line: `bug, ready-for-agent, P2` — or a warning that the ticket was never triaged.
3. Gate 1: dev1 reports `true/false/cannot check` per claim; the reviewer does its own pass.
4. Gate 2: dev1 commits on `run/<slug>`; the reviewer runs the project's checks and rules `go` or
   `pushback`.
5. `DONE`, then the `── spend ──` block.

Nothing needs typing: the lead is dispatched with the startup task. Typing in a pane sends that agent a
message; typing in the chat sends it to the lead.

## 4. Stop a run

`Ctrl-C` in the chat pane. The turn in flight reads as `cancelled`, panes close, state is saved. A second
`Ctrl-C` kills it harder and can leak panes.

## 5. After DONE

```sh
# what the room actually produced
git -C <repo>-<slug> log --oneline -3
git -C <repo>-<slug> show HEAD

# where the time and the money went (per turn, including tokens and cost)
bun src/timings.ts <repo>/_run/00N-<slug>

# merge, then remove the worktree and the branch
git -C <repo> merge --no-ff run/00N-<slug> -m "Merge run/00N-<slug>: <what it did> (closes #54)"
git -C <repo> worktree remove <repo>-<slug>
git -C <repo> branch -d run/00N-<slug>
```

The room posts its own comment on the ticket at DONE (branch, commit, criteria, checks, what it did not
verify, and a line saying an AI wrote it). It never closes the issue and never changes a label: closing
follows the merge, and a refusal is your judgement.

Keep `run.yaml` and `notes.md` in `_run/00N-<slug>/`; the rest is runtime. Cleaning a finished run:

```sh
rm -rf <repo>/_run/00N-<slug>/{agents,state.json,messages.jsonl,room.log,telemetry.jsonl,run.resolved.yaml,summary.json,prompts}
```

Never edit a finished run's files: they are the record of what happened, including the `stats` lines that
say what each turn cost.

## 6. Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `launch: worktree refuse — … not merged` | the run's worktree is behind the base and its branch has unmerged work | merge or delete that branch yourself, or use a new `--slug` |
| `launch: worktree replace` | behind, clean, branch already merged | nothing: it is removed and recreated from the base |
| `launch: FAIL git working tree` | wrong `--repo`, or not a repo | pass the repo root |
| `launch: warn checkout clean — N uncommitted path(s)` | your checkout has changes | they will not be in the worktree; commit them or accept it |
| `launch: warn branch run/…` | a branch by that name exists | the worktree decision handles it; a fresh `--slug` avoids it |
| `launch: refusing — #54 is needs-info` | triage has not cleared the ticket | triage it, or `--any-state` if you know better |
| `launch: warm install …` instead of `clone` | the branch changed the lockfile, or no source `node_modules` | expected; it costs minutes, once |
| `launch: warm refused — … both present` | two lockfiles | delete the stale one |
| `· agent <id> context push failed` | the agent's `pi` session is not answering | check `_run/<run>/agents/<id>/stderr.log`; the turn continues without it |
| `· settle timeout` | the turn ran past `turn_timeout_ms` | what it wrote is kept and the chain continues; raise the template's timeout if it recurs |
| run ends with no `DONE` | hop cap, halt, or a refusal | read the lead's last block and `docs/STATUS.md`'s known limits |
| panes left open after a hard kill | `kill -9` skips shutdown | `herdr pane close <id>` for each labelled pane |
| `_run/` not ignored | the repo's `.gitignore` | add it before the room writes there |
| provider reports `cost unknown` / `$0.0000` | the model is unpriced there | tokens are the only signal; `bun src/timings.ts` shows them per turn |

## 7. Where the record is

| File | What it answers |
|---|---|
| `_run/<run>/room.log` | what a human saw, no timestamps |
| `_run/<run>/messages.jsonl` | every message, with ids and origins |
| `_run/<run>/agents/<id>/log.jsonl` | `spawned`, `turn_start`, `delta`, `tool_start`, `tool_end`, `stats`, `settled`, `error`, `shutdown` |
| `_run/<run>/telemetry.jsonl` | `agent.turn` spans, settle latency, `dispatch` events naming what queued whom |
| `_run/<run>/summary.json` | per-agent tokens, cost, tool calls |
| `bun src/timings.ts _run/<run>` | per turn: total, first event, tool time, longest gap and its predecessor, tokens and cost |
