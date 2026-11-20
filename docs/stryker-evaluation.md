# Mutation testing — StrykerJS, evaluated on this repo

**Verdict: keep as an on-demand, human-adjudicated probe on a fixed module set. Do not put it in
`check` or CI, and do not act on a survivor until `bun test` confirms it.** Two measurements decide
that: on this stack Stryker's verdicts are not reproducible (3–4 mutants of ~80 flip between two
identical runs), and 5 of the 15 survivors I re-checked against the real runner were ghosts. What
survives the re-check is worth the run: **the strongest argument for the tool here is that
`bun test --coverage` reports 96–100% line coverage on the modules where Stryker finds 4–27% of
mutants surviving.**

Provenance: `agent-huddle` at `fc470fc` (suite green: 167 tests, 2 skips, 17.1 s),
2026-11-20, `@stryker-mutator/core` 10.1.1, `@stryker-mutator/vitest-runner` 10.1.1,
vitest 5.1.1, node v24.19.0, bun 1.4.2, macOS arm64, `concurrency: 4`. No model spend.
Experiment run in a throwaway copy (`git archive HEAD`), so nothing in this tree depends on it.
Artifacts: [`docs/evidence/stryker/`](evidence/stryker/).

---

## 1. The blocker, stated first: there is no Bun test runner

- `npm view @stryker-mutator/bun-runner` → **404** (2026-11-20). Shipped runners are
  `vitest`, `jest`, `mocha`, `jasmine` (all 10.1.1). This repo's tests import `bun:test`
  (`test/router.test.ts:1` and 20 other files).
- The workaround that works: a vitest config that aliases `bun:test` → `vitest`, plus
  **five one-line edits** to tests that use Bun-only APIs. Every edit is portable — `bun test`
  stays green afterwards (167 passed, 2 skipped), so this is not a fork of the suite.

| test file | Bun-only construct | portable form |
|---|---|---|
| `test/hygiene.test.ts:5`, `test/rooms.test.ts:7` | `import.meta.dir` | `import.meta.dirname` |
| `test/store.test.ts:96,109` | `Bun.file(p).text()` | `readFile(p, "utf8")` |
| `test/coordinator.test.ts:372` | `Bun.sleep(1)` | `new Promise((r) => setTimeout(r, 1))` |
| `test/coordinator.test.ts:428` | `expect(x).toStartWith()` (Bun matcher) | `expect(x.startsWith(...)).toBe(true)` |

With those five edits, **vitest runs the whole suite unmodified otherwise: 165 passed, 2 skipped,
matching `bun test`'s 167.** Configs as run: `docs/evidence/stryker/stryker.conf.json`,
`docs/evidence/stryker/vitest.mutation.config.ts`.

Reproduce:

```sh
git archive HEAD | tar -x -C "$TMPDIR/eval" && cd "$TMPDIR/eval"
bun install && bun add -d @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1 vitest
# apply the five edits above, copy the two configs, then:
npx stryker run                     # 4 modules, ~2m16s
```

---

## 2. Scores (`coverageAnalysis: "perTest"`, full suite, 486 mutants)

| module | mutants | killed | survived | no cov | score | bun line cov |
|---|---|---|---|---|---|---|
| `src/config.ts` | 340 | 250 | 70 | 20 | **73.53%** | 96.17% |
| `src/store.ts` | 86 | 74 | 11 | 1 | 86.05% | 100% |
| `src/errors.ts` | 15 | 13 | 2 | 0 | 86.67% → **100%** after re-check | 100% |
| `src/router.ts` | 45 | 43 | 2 | 0 | 95.56% | 100% |
| **total** | **486** | **380** | **85** | **21** | **78.19%** | 94.33% |

Run time: 2m16s at concurrency 4. With the integration tests excluded (the first run, which I later
found to be wrong — see §3) it was 52 s; `src/store.ts` alone is 15–19 s; `coverageAnalysis: "all"`
on store+errors is 35 s.

The `bun test --coverage` column is the point of the whole exercise. `src/store.ts`, `src/router.ts`
and `src/errors.ts` are at 100% line coverage and still have mutants that no test notices.

The two tools also disagree in an instructive way. `bun` reports 7 unreached lines in `config.ts`
(`67, 105, 108, 121, 156, 163, 182`), and Stryker reports `NoCoverage` inside those same blocks.
But `bun` counts `src/config.ts:73` as covered —
`if (typeof v !== "string" || v.trim() === "") fail(... must be a non-empty string)` — while
Stryker reports the `fail()` template on that line as `NoCoverage`, because line coverage fires
when the `if` executes and mutation coverage asks whether the body ever ran. So: 26.5% of
`config.ts` mutants survive code that is 96% executed, and **13 of the 20 `NoCoverage` mutants sit
on lines `bun` counts as covered**.

---

## 3. Verdicts are not reproducible — the finding that governs the verdict

Two identical runs, same config, same commit, disagree on mutants:

| comparison | mutants | flips |
|---|---|---|
| `coverageAnalysis: all`, store+errors, run 1 vs run 2 | 84 | **4** |
| unit tests only, store, run 1 vs run 2 | 74 | **3** |
| `perTest` vs `all` (same 2 modules, same mutants) | 101 | 6 |

Per-mutant evidence in `docs/evidence/stryker/runs.json`. Three of the flips are on mutants that
**no test can observe**, which is the proof that the instability is the harness and not the suite:

- `src/store.ts:37` (`this.ensuredDir = true` → `false`, a redundant `mkdir`) flips in all three
  comparisons.
- `src/store.ts:99` (`readFile(this.statePath, "utf8")` → `""` — the encoding argument) reported
  **Killed** in one unit-only run and Survived in the next. No test can read an encoding argument.
- `src/store.ts:87` (`finally { await fh.close() }` → empty) also flips; nothing in the suite
  counts file descriptors.

So a survivor list is a *lead list*, not a measurement. Any gate built on the score would fail
builds for reasons that do not exist on the next run.

**A false-kill trap to remember**: my first hand-check batch reported 5 mutants "killed" that in
fact survive. The bug was in my verifier, not the code: `bun test` writes its summary to **stderr**,
and I read `stdout`. Two further lessons from the same afternoon — one flaky integration test
(`Coordinator (real pi, headless)`, `test/coordinator.integration.test.ts:93`) failing once turned
"survives" into "killed" for every mutant in that batch; and hand-applying a mutation from Stryker's
reported span is easy to get wrong (its columns are 1-based inclusive; my first attempt produced
`&& vtrue {`, a syntax error that "killed" all 106 survivors).

---

## 4. The survivors, adjudicated

Method: all 106 rows of `docs/evidence/stryker/survivors-perTest.json` were read; 15 representative
mutants were applied by hand and run against the **real** `bun test` suite twice, then probed for a
behavioural difference. Table: `docs/evidence/stryker/handcheck.json`.

**5 of 15 were false survivors** — `bun test` kills them, Stryker did not:

| site | mutation | killed by |
|---|---|---|
| `src/store.ts:18` | `typeof parsed === "object" && parsed !== null` → `true` | `test/store.test.ts:105` |
| `src/store.ts:59` | `ENOENT` fallback disabled | `test/coordinator.test.ts`, `coordinator.integration.test.ts` |
| `src/store.ts:87` | `finally { fh.close() }` emptied | `test/coordinator.test.ts` (log-write paths) |
| `src/errors.ts:8` | object guard → `true` | `test/errors.test.ts` |
| `src/errors.ts:11` | `JSON.stringify` catch removed | `test/errors.test.ts` |

Two of five rule out the whole of `src/errors.ts` as a gap: its true score is 100%.

**10 survive the real suite. Six change observable behaviour:**

| site | mutation | what changes (probe) | class |
|---|---|---|---|
| `src/config.ts:42` | one thinking level blanked | `thinking: off` is now rejected — a valid config stops loading | real gap |
| `src/config.ts:104` | `system_prompt` type check off | `system_prompt: 123` loads | real gap |
| `src/config.ts:135` | system-prompt assignment dropped | `loadConfig` returns a lead with **no** `system_prompt`; the room would spawn it without its role prompt | real gap |
| `src/config.ts:140` | tools assignment dropped | the agent loses its `--tools` allowlist | real gap |
| `src/store.ts:127` | `existing?.agents?.[id]` → `existing?.agents[id]` | boot throws on a `state.json` that has no `agents` key | real gap |
| `src/router.ts:60` | dedup clause dropped | `@nobody @nobody` is reported twice in the unknown-mention notice | real gap, cosmetic |

**Four are harmless:** `config.ts:137` (always-assign — same observable config), `config.ts:66`
(unreachable while every caller passes a mapping — inspect only, not probed), `store.ts:35`
(redundant `mkdir`), `store.ts:132` (`status: "starting"` → `""`; a real value but no test reads it).

By shape over all 106 rows: 33 are string literals (error text, encoding, indentation — the suite
asserts `ConfigError`, not messages), 21 `NoCoverage` (validation branches the suite never enters),
the rest condition/operator mutants on validation guards. The gap is concentrated and legible:
**the config validator's failure branches are the least-asserted code in the repo**, which is also
where three of the v1 findings lived (#8 unvalidated prompt file, #13 handle grammar, #24
reserved-handle message).

---

## 5. The second question: code the repo's agents write

The rooms write real code into the coordinator's cwd — `docs/STATUS.md` and
`AGENTS.md:11` both record that a room's `shrink/src/slug.test.ts` was picked up by `bun test` in
this very tree, and `docs/runs/2026-11-20-manned-run-2.md:69` lists `shrink/` as dev1's deliverable.
So agent-produced code arrives as source plus tests, in a repo, exactly where mutation testing
applies.

Why the question matters here, in numbers rather than principle: the v1 RCA
(`docs/rca/2026-11-20-v1-defects.md`) attributed 7 of 8 audit findings to *failure paths nobody
wrote a test for*, and the review that missed them was measuring code against a spec, not
behaviour. A mutation score asks precisely the question those agents got wrong: **if this behaviour
changed, would any test fail?** Nothing else in the toolchain asks it — `tsc` cannot, coverage
cannot (§2), and a diff review cannot.

Where it does *not* fit yet:

- **Not a room gate.** A room's output cannot be gated on a score whose verdicts move 4% between
  identical runs (§3). A lead told "score must be ≥80%" would chase numbers, and the number is
  partly noise.
- **Not a coordinator feature.** Attaching it to the coordinator means shipping a node-only tool
  (`npx stryker`, node v24 in this measurement) into a Bun program whose tests are `bun:test`, plus
  per-repo config synthesis. That is a product, not a flag.

What is cheap and useful today: at the end of a room run, run a scoped Stryker pass over the files
the run touched, and hand the **survivor list** to the lead as work to adjudicate — with the rules
in §4: re-verify each survivor against the repo's own runner before filing it. The measured cost of
that is small: 86 mutants on one module in 15–19 s, 486 across four modules in 2m16s, no model
spend.

---

## 6. If adopted here

1. `bun add -d @stryker-mutator/core@10.1.1 @stryker-mutator/vitest-runner@10.1.1 vitest`;
   commit the two configs from `docs/evidence/stryker/` and the five portable test edits from §1.
2. `package.json`: `"mutate": "stryker run"` — **not** inside `check`, and not in
   `.github/workflows/ci.yml` (a 2-minute node tool whose verdicts drift is not a CI gate).
3. Keep `mutate` pinned to a short, behaviour-heavy list. `src/config.ts` and `src/store.ts` pay;
   `src/errors.ts` and `src/router.ts` are already ≥95% and mostly produce equivalent mutants.
4. `.gitignore`: `.stryker-tmp/`, `reports/`.
5. Budget the reading pass, not the run: 106 survivors for four modules, ~20 minutes of reading,
   and expect a third of them to be ghosts.

**Kill criteria** — re-evaluate if either changes: a `@stryker-mutator/bun-runner` ships, or two
identical runs agree on every mutant status. Either one turns the score from a lead generator into
a measurement, and only then could it gate anything.

---

## 7. What this evaluation did not determine

- **Why the verdicts drift.** Three candidate causes were not separated: the vitest runner's
  per-test coverage attribution under the `bun:test` alias, the parallel suite's temp-dir
  collisions, and Stryker's timeout/killed classification. The measured facts (§3) are enough to
  withhold trust; the cause is not established.
- **Modules not mutated.** `src/turn-loop.ts` (292 lines, the hop cap and abort handling — three v1
  findings), `src/coordinator.ts` (362), the real adapters, and `src/telemetry.ts` were left out to
  keep the run small. Nothing here says anything about them.
- **Whether the 6 real gaps matter in a real room.** They are behaviour changes proven by probe
  (§4), not defects observed in a run; e.g. a config that drops `system_prompt` has never been
  shipped, because no room file triggers the mutation's condition.
- **Any claim about agent-written code in production.** Two manned runs exist (`docs/runs/`) and
  the v1 defect history is documented, but this repo has never run a mutation pass over a room's
  own output. The §5 proposal is derived from the RCA and the measured cost, not from a trial.
- **Windows/Linux behaviour** of the vitest shim, and Stryker's behaviour on a repo whose tests
  spawn subprocesses at the rate this one does.
