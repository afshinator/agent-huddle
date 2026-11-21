# Decision records

One entry per decision whose *reason* is not visible in the code. Written after the v1 RCA found that
none of these existed anywhere: the spec states the outcome, so the rejected alternative and why it
lost are lost with the session that chose it.

Rules:

- A decision that constrains future work gets an entry here, in the same commit as the code.
- **A spec edit made after the code exists names which side moved** — the code or the spec — in the
  commit message. Post-code spec edits were the strongest single signal in the v1 RCA: every one of
  them was a failure mode discovered late.
- If an entry stops being true, edit or delete it; do not leave a second one explaining the first.

---

## D1 — `state.json` is a cache, not the source of truth

**Decision:** `messages.jsonl` is authoritative. `state.json` is a recoverable snapshot, rewritten
atomically, and reconciled on load; a corrupt file is treated as absent and rebuilt.

**Rejected:** rebuild state from the log on every read.

**Why:** a rebuild discards in-flight chain state and pids, so a resumed room would have to re-derive
liveness it cannot observe. Reconciliation keeps the cheap read path while never trusting the file.

**Cost, accepted:** two writers of truth must agree, which produced #1 (a stale copy) and #12/#25
(damaged-file tolerance). See `src/store.ts`, `src/coordinator.ts`.

## D2 — the lead's `DONE` line is the only machine completion signal

**Decision:** a chain completes when the lead's final text contains a line that is exactly `DONE`
after trimming. `definition_of_done` is prose for the prompt, never parsed.

**Rejected:** per-agent completion flags; parsing the DoD text.

**Why:** the DoD is natural language, so any parser is a guess. One token at the end of the lead's
turn is checkable and is the lead's own judgement, which is the only judgement available.

**Cost, accepted:** a chain can end "completed" with the DoD unmet, and a lead that never writes the
line runs to the hop cap. `hasDoneSignal` in `src/turn-loop.ts`.

## D3 — unmentioned context is pushed over an isolated seam

**Decision:** an agent not targeted by a message still receives it as context through
`pushContext`, implemented as an RPC `bash echo` with `excludeFromContext:false`.

**Rejected:** lazy catch-up on the agent's next dispatched turn; blind `steer` injection.

**Why:** agents stay current without spending a turn, and the seam existed so the mechanism could be
swapped. It was swapped once already, at the design stage.

**Cost, accepted:** a failure here is invisible to the model and must never halt a chain, so it is
best-effort — that boundary is what #11 was about. `src/turn-loop.ts` `syncContext`, SPEC §6.6/§10.

## D4 — a failed agent halts the chain; there is no automatic reroute

**Decision:** a dispatched agent that fails or aborts appends a `notice` and stops the chain, waiting
for the human.

**Rejected:** reroute to the lead; retry the hop.

**Why:** v1 has no way to judge whether the missing work matters, and a silent reroute hides a broken
agent behind a plausible-looking room. A halt is visible.

**Cost, accepted:** an unattended run stops on the first failure. Revisit only with a reroute policy
that records the substitution. SPEC §10.

## D5 — `lastMessageId` is tracked in memory, not re-read from the log

**Decision:** `RoomStore.onAppend` updates the room state's `lastMessageId`; `persistState` never
re-reads `messages.jsonl`.

**Rejected:** reading the log inside `persistState` to find the last id.

**Why:** the read cost scaled with room history on every hop — measured at 9 reads and 387 parsed
lines per submit, and 0 after the change (#15).

**Cost, accepted:** an append that bypasses the store leaves the id stale; every append goes through
the store by construction. `src/store.ts`, `src/coordinator.ts`.

---

## D6 — a message with no mention activates nobody (v1.1)

**Decision:** a message whose text mentions no handle targets nobody: `extractMentions` returns an
empty list, every agent still ingests the text as context (§6.6), and the chain completes immediately
as `idle`. The startup `task:` is the one exception — it targets the lead, because a boot directive is
not a chat message.

**Amended 2026-11-21 (#57):** the exception is unconditional. A `task:` that names `@dev1` and
`@reviewer` still dispatches only the lead; those mentions are recorded and pushed to those agents as
context. Before this, mentions were consulted first, so the first docs-audit launch sent the lead's
instructions to two specialists and never started the lead at all.

**Rejected:** the v1 rule, where an unaddressed message fell back to the lead.

**Why:** this is a chat room, not a request queue. A supervisor or a lead must be able to say
something — a constraint, a status, context — without spending a turn and without obliging the lead to
answer every observation. The fallback also made "nobody acted" indistinguishable from "the lead
decided not to", which is a bad state for a human to debug.

**Cost, accepted:** a silent room is now reachable. A human who forgets the `@handle` sees nothing
happen, so a message with no targets must produce a room notice saying so rather than nothing.
**Cost, accepted (added #57):** a `task:` cannot start several agents at once. That is the point:
one boot directive, one accountable lead.

`src/router.ts` (`extractMentions`), `src/turn-loop.ts` (chain start, #35, #57).

---

## D7 — an agent pane shows the readable stream, and typing in it is a public message (v1.1)

**Decision:** an agent pane shows that agent's output rendered for a human — its messages as prose,
its tool calls one line each, its deltas coalesced — while `log.jsonl` stays on disk as the
machine-readable record. Panes are writable by default (`pane_writable: true`); a line typed in
`@dev1`'s pane is posted as a public room message with `@dev1` implied: visible to everyone, activating
only dev1. A read-only pane runs the tail alone behind a banner, because swallowed keystrokes give no
feedback.

**Rejected:**

- *Agent panes tail `log.jsonl`.* That is what v1 shipped: one JSON record per token fragment,
  unreadable by construction, and the reason a manned run produced a wall of noise with no conversation
  in it.
- *Agent panes show the conversation.* Two views of one conversation means the room pane stops being
  the whole story, and "what has been said" no longer has one answer.
- *Typing in a pane sends a private message to that agent.* Explored and dropped: it needs hidden
  traffic, a per-agent inbox with a leak rule for the agent's public reply, and it re-creates a second
  moderator channel. Public-with-implied-mention keeps the convenience and none of that.

**Why:** the two artefacts have different audiences. The human wants the agent's work as prose; a
debugger wants JSON events. Serving both from one file made the pane a log dump wearing a chat label.

**Cost, accepted:** a second per-agent output file to keep coherent with `log.jsonl`, and a
two-process pane command (tail plus reader) for writable panes, because a pane cannot tail a file and
read a keyboard at the same time.

---

## D8 — the pane shows tool calls through a new `tool` seam event (v1.1)

**Decision:** `AgentEventMap` gains `tool: { name: string; args: unknown }`. The real client emits it on
`tool_execution_start` and ignores `tool_execution_update` and `tool_execution_end`. The coordinator
renders one line, `[tool] <name> <args on one line, cut at 200 chars>`.

**Rejected:**

- *Parse `agents/<id>/log.jsonl` in the pane stream writer.* It puts the `pi` protocol shape into the
  presentation layer, gives the same fact two sources, and would break on the next record rename
  without any test noticing.
- *Emit on `tool_execution_end` instead of start.* A long `bash` would stay invisible until it
  finished, which is exactly the wait where the pane is the only thing to watch.
- *Carry `isError` and `durationMs` now.* No consumer reads them; adding fields "for later" is how a
  seam grows a vocabulary nobody chose.

**Why:** a coding agent's work is mostly tool calls. Without them the pane shows a model talking about
files it may never have opened. The seam already existed for streaming and errors, so the alternative
was not "no seam change", it was "protocol knowledge in the wrong layer".

**Cost, accepted:** one more event to keep wired in three places (interface overload, listener lists,
fake), and the pane prints arguments verbatim — which can be large or sensitive, hence the 200-char cut.
`docs/json.md` in the `pi` package is the only source for the record shape.

---

## D9 — pane input pins its target instead of escaping the text (#40)

**Decision:** `TurnLoop.submit` takes an optional explicit target list; pane input passes
`[paneAgentId]`, and the message text keeps every handle the supervisor typed.

**Rejected:**

- *Escape the handles in the typed text.* `MENTION_RE` (`src/router.ts:12`) has no word-boundary guard,
  so `\@dev2` still parses as `@dev2` — measured. Stripping the `@` works but changes what the room
  records, against #40's own criterion that the text is recorded intact.
- *Change the spec so a pane line is ordinary supervisor text.* Then a line typed next to dev1 can
  start dev2, which is the surprise #40 exists to remove.

**Why:** routing and wording are different concerns. The supervisor's words belong in the record as
written; the pane decides who runs. Pinning also keeps the unknown-handle notice honest — `@nobody` is
still reported even though it cannot dispatch.

**Cost, accepted:** `mentions[]` can list an agent that was not dispatched. It records the text, not the
routing, and §6.4 now says so. `Coordinator.submit` and `TurnLoop.submit` gain an optional parameter,
which every existing caller ignores.

---

## D10 — the boot guard runs before anything writes (#38)

**Decision:** `launch_guard` (`refuse | warn | off`, default `warn`) is enforced in `boot()`, before its
`try` block and before the first spawn, pane or room file. `refuse` throws `LaunchGuardError`, which the
CLI prints as one line and exits 1.

**Rejected:**

- *Check inside `bootRoom`, after the state load.* Measured the failure: `boot()`'s catch calls
  `abortBoot`, whose `persistState` lazily rebuilds state, so a refusal left `state.json` and
  `telemetry.jsonl` inside the very tree it refused to write into.
- *Check only in `src/index.ts`.* Any other entry point — tests, a future CLI, an embedder — bypasses it,
  and the coordinator is the only place that holds the `cwd` the agents inherit.
- *Default `refuse`.* It would stop every existing room launched from a repository root, including a room
  run from a worktree of a room repo, with no way to accept the risk without editing YAML first.

**Why:** the guard exists to stop a room writing into someone else's working tree. A guard that writes
there first fails its own purpose, and the ordering is invisible in the code — `boot()` looks like it
could do the check anywhere.

**Cost, accepted:** a refusal writes nothing at all, so its only evidence is stderr, not telemetry. The
check flags a repository **root** only: a launch from a subdirectory of a repository is not caught. The
entry is later than the code it describes (#38), which breaks the "same commit" rule above; #45 exists
because that was missed.

## D11 — A turn that dies during shutdown is `cancelled`, not `halted`

**Context.** Ctrl-C in the room pane signals the whole foreground process group: the coordinator and
every `pi` child. A turn in flight therefore dies, and the coordinator recorded that as a failed hop —
a `notice` in the transcript and `status: "halted"` in `state.json`, for a stop the operator asked for.

**Decision.** `Coordinator.shutdown()` sets `stopping` as its first statement, before any `await`. The
turn loop asks (`isStopping`) before judging a failed dispatch: while stopping it logs
`agent turn cancelled by shutdown` at `info`, appends no notice, and finishes the chain `cancelled`,
which clears the chain and leaves the room `idle`.

**Rejected alternatives.**
- *Set each agent's shutdown flag in one tick and rely on the flag in the client's exit handler.* This
  is also in place (all stops start before the first `await`), but on its own it is not enough: the
  child can die before the coordinator's signal handler runs, and a turn in flight then still fails.
  Measured twice in a real room: no `[error]`, but the notice and the halt remained.
- *Ignore a child exit whose `signal` is `SIGINT`.* It silences the real symptom too (an agent that
  crashed mid-turn and a stop would read the same), and it puts the judgement in the transport, which
  cannot know whether the room is stopping.
- *Report the cancellation as a `notice` and keep `halted`.* The transcript needs no entry for a turn
  the operator killed, and `halted` describes a chain the room gave up on, not one that was stopped.

**Why:** the flag is the only place that knows the operator's intent, and it is set before any code that
could yield. The ordering is invisible in the code — `shutdown()` looks like it could set the flag later.

**Follow-up, found on CI:** the rejected turn unwinds *after* `shutdown()` returned, so the final state was
written while a chain was still writing it (a rename on a temp dir the caller had already removed). Shutdown
now waits for the chain that owns the dead turn — `submitQueue` and `bootRun` — before persisting. A stop
during boot was reachable all along: `index.ts` installs the signal handlers before `await boot()`.

**Cost, accepted:** a genuine crash that happens to land in the few milliseconds after shutdown began is
recorded as a cancellation. The pane still shows `[exited]`, and the room writes nothing to the transcript
to say a chain was interrupted, so `messages.jsonl` can end mid-chain with no explanation.

## D12 — The launch guard ignores a linked worktree, and warns out loud

**Context.** Run #3 tripped `launch_guard: warn` while being launched from a worktree — the placement
`AGENTS.md` mandates for supervised runs — because `git rev-parse --show-toplevel` returns the worktree
root, which is a repository root by every measure the guard used (#48). A guard that fires on the correct
launch and on the dangerous one distinguishes neither, and its record went only to `telemetry.jsonl`, so
an operator never saw it either.

**Decision.** A linked worktree root is not a guarded situation: `inspectLaunchDir` reports
`worktree: true` (from `rev-parse --git-dir` ≠ `--git-common-dir`), and both `warn` and `refuse` stay
silent there. In a main checkout, `warn` logs the record **and** prints one line to stderr.

**Rejected alternatives.**
- *Print the line and keep the predicate.* It would nag on every correct worktree launch, which is how a
  warning becomes noise and then becomes ignored.
- *`test -f .git` to detect a worktree.* Cheaper, but it also matches a `--separate-git-dir` clone, where
  `.git` is a file and the checkout is not a worktree.
- *Refuse in a worktree too.* It would make the documented safe workflow unreachable with `refuse`.

**Why:** the guard's question is not "is this a repository" but "is this a tree someone would miss". The
predicate is invisible in the code — `isRepoRoot` reads like the whole test.

**Cost, accepted:** a worktree of a repository you care about is not flagged, and neither is a
subdirectory launch. The record still names the directory and branch, so a `warn` in a log is readable
after the fact.

## D13 — A room is a template plus a run, and the run is never tracked

**Context.** A room's collateral was spread across four directories: `rooms/<name>.yaml` beside other
rooms' configs, its prompts in a shared `prompts/` that also held prompts of rooms long gone, its launcher
at a third level, and its run note in `docs/runs/`. Nothing said which files belonged together, so the
`.gitignore` rule had to be `rooms/*/` — coarse enough to forbid ever tracking a template directory. The
worse half was the run: `task` and `definition_of_done` lived in the same file as the agents, models and
prompt paths, so asking a different question of the same room meant copying thirty lines of roster and
watching the copy drift.

**Decision.** A **template** owns the kind of room: agent count, models, thinking, tools, prompts and
budget defaults, all inside one tracked directory (`rooms/templates/<type>/`). A **run** owns one ask: a
small file naming `template:` plus `task`, `definition_of_done` and any budget it wants to change. The
run's collateral — the resolved config, a snapshot of the prompt files that ran, the ask, notes, and the
room's runtime files — goes in `_run/<slug>/` in the repo the room runs in, gitignored. The room's output
goes to a linked worktree on `run/<slug>` when the run produces something to check in, and to a detached
worktree when it does not.

**Rejected alternatives.**
- *Co-locate the files and leave the config format alone.* It fixes the template half and makes the run
  half worse: every run file repeats the roster, and a roster duplicated across runs is how a room runs
  models nobody chose.
- *Deep-merge an agent override field by field.* Half-merging a model with a tool list produces a room
  that exists in no file; a run replaces an agent whole, or adds one.
- *Commit the run's collateral next to the template.* It makes every run a tracked directory, turns the
  repo's history into run logs, and puts a prompt snapshot in the way of the template someone is editing.
- *Run in the main checkout when there is no branch.* Agent writes would land in a tree that holds work
  and tests; a detached worktree costs one command and keeps the invariant.

**Why:** the boundary that decides what may be committed should be visible in the file layout, not
inferred from a config key. Templates are the thing worth sharing; a run is one question asked once.

**Cost, accepted:** two files to read instead of one, and `room_dir` changes meaning between a standalone
config (default `<cwd>/rooms/<name>`) and a run (default the run file's directory). The resolved snapshot
is what a run is reproducible from, so a template edited later silently stops describing past runs — which
is the point, but it means the snapshot is the evidence, not the template.

## D14 — The pane shape is computed from the tab, not fixed

**Context.** The manager split the current pane once per agent with herdr's default ratio, so the room
pane halved itself repeatedly and the last agent landed furthest from the chat. `herdr` only accepts a
`--ratio` per split, and a probe elsewhere measured exactly this failure: repeated 0.5 splits produce a
staircase (29/14/7/4/2/1 rows), while equal bands come from splitting one base pane with
`(n-k)/(n-k+1)` (probe notes in `pi-herdr-panes/SPEC.md`, F6/F7).

**Decision.** `src/layout.ts` owns the geometry: six named constants at the top of that one file, and
`chooseLayout` tests both orientations and every grid shape against two floors (a pane needs 64x8, the
chat 100x24), scoring survivors by worst aspect against 3.0. The manager reads the tab from
`herdr pane layout`, carves the chat pane once, splits the region with those ratios, and assigns slots
by measured `rect` order.

**Rejected alternatives.**
- *Keep one split per agent with the default ratio.* That is the staircase; the chat ends at 1/8.
- *Three or four equal columns always.* At 176 columns each pane would be 58 wide, under the floor.
- *Assign slots in creation order.* The probes measured slice sizes, not which end a split lands on;
  sorting by `rect` makes the question moot.

**Why:** the tab size is the only fact that decides whether a shape is readable, and it is measurable
before the first split.

**Amended 2026-11-21 (#59):** the seam exposes the measurement, not the decision:
`HerdrPaneManager.layoutReport?()` returns the tab, the orientation, the chat box and each pane's
`rect`. The room prints it in its boot banner, which is how the plan is checked against a real tab
without a screenshot. It is optional so a manager that owns no geometry (a fake, a headless run) says
nothing rather than inventing it.

**Cost, accepted:** an unreadable tab now fails boot instead of producing panes nobody can read, and
the constants are judgement values until a live run measures rows against a real tab.
