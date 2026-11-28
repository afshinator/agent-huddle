import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  askedFrom,
  blockerReason,
  claimsRefused,
  claimsRows,
  criteriaOf,
  dependencyReferences,
  eligibility,
  lockfileFor,
  pickTemplate,
  prepFirst,
  resolveClaimCheck,
  templatePath,
  worktreeAction,
  warmPlan,
} from "../src/launch";
import {
  parseLaunchFlags,
  performLaunch,
  planLaunch,
  type Launch,
  type LaunchDeps,
  type LaunchFacts,
  type LaunchFlags,
} from "../src/launch-plan";

describe("which lockfile a repo uses", () => {
  test("picks the one it has", () => {
    expect(lockfileFor(["package.json", "package-lock.json"])).toBe("package-lock.json");
    expect(lockfileFor(["bun.lock", "package.json"])).toBe("bun.lock");
    expect(lockfileFor(["pnpm-lock.yaml"])).toBe("pnpm-lock.yaml");
  });

  test("a repo with none gets no install plan", () => {
    expect(lockfileFor(["package.json"])).toBeNull();
  });

  test("two lockfiles: the repo is asked to pick, not guessed", () => {
    // A stale `package-lock.json` beside a live `pnpm-lock.yaml` is how a room installs the wrong tree.
    expect(lockfileFor(["package-lock.json", "pnpm-lock.yaml"])).toBe("ambiguous:package-lock.json,pnpm-lock.yaml");
  });
});

describe("warm: copy the source tree or install", () => {
  test("same lockfile and the source has modules: clone it", () => {
    expect(
      warmPlan({ lockfile: "package-lock.json", sourceHasModules: true, sourceLock: "abc", worktreeLock: "abc" }),
    ).toEqual({ mode: "clone", reason: "the lockfile matches the source checkout" });
  });

  test("a lockfile the branch changed: install, never copy", () => {
    // A copied tree that does not match the lockfile tests the wrong dependency set, silently.
    expect(
      warmPlan({ lockfile: "package-lock.json", sourceHasModules: true, sourceLock: "abc", worktreeLock: "def" }),
    ).toEqual({ mode: "install", reason: "the worktree's package-lock.json differs from the source checkout" });
  });

  test("a worktree already warmed: nothing to do, no second clone", () => {
    // Every relaunch used to re-clone 763 MB; the second one has nothing to fix.
    expect(
      warmPlan({
        lockfile: "package-lock.json",
        worktreeHasModules: true,
        sourceHasModules: true,
        sourceLock: "abc",
        worktreeLock: "abc",
      }),
    ).toEqual({ mode: "skip", reason: "the worktree is already warmed" });
  });

  test("no source modules: install", () => {
    expect(
      warmPlan({ lockfile: "bun.lock", sourceHasModules: false, sourceLock: null, worktreeLock: "abc" }),
    ).toEqual({ mode: "install", reason: "no node_modules in the source checkout to clone" });
  });

  test("no lockfile: nothing to install", () => {
    expect(
      warmPlan({ lockfile: null, sourceHasModules: true, sourceLock: null, worktreeLock: null }),
    ).toEqual({ mode: "skip", reason: "no lockfile in the worktree" });
  });

  test("two lockfiles: refuse rather than pick one", () => {
    expect(
      warmPlan({
        lockfile: "ambiguous:package-lock.json,pnpm-lock.yaml",
        sourceHasModules: true,
        sourceLock: null,
        worktreeLock: null,
      }).mode,
    ).toBe("refuse");
  });
});

describe("worktree: reuse, replace, or refuse", () => {
  const base = { headMatchesBase: true, dirty: false, branchMerged: true };

  test("no worktree: create one", () => {
    expect(worktreeAction({ ...base, exists: false }).action).toBe("create");
  });

  test("a worktree at the base commit: reuse it", () => {
    expect(worktreeAction({ ...base, exists: true }).action).toBe("reuse");
  });

  test("an old worktree whose branch is merged: replace it", () => {
    // The silent failure: a run quietly cut from a commit nobody looks at again.
    expect(
      worktreeAction({ exists: true, headMatchesBase: false, dirty: false, branchMerged: true }).action,
    ).toBe("replace");
  });

  test("an old worktree with unmerged work: refuse, and say why", () => {
    const decision = worktreeAction({ exists: true, headMatchesBase: false, dirty: false, branchMerged: false });
    expect(decision.action).toBe("refuse");
    expect(decision.reason).toContain("not merged");
  });

  test("an old dirty worktree: refuse, never remove uncommitted work", () => {
    const decision = worktreeAction({ exists: true, headMatchesBase: false, dirty: true, branchMerged: true });
    expect(decision.action).toBe("refuse");
    expect(decision.reason).toContain("uncommitted");
  });
});

describe("a ticket's acceptance criteria become the run's bar", () => {
  test("the acceptance-criteria section, verbatim, without its heading", () => {
    const body = [
      "## What to build",
      "Do the thing.",
      "",
      "## Acceptance criteria",
      "1. One.",
      "2. Two.",
      "",
      "## Repo constraints",
      "- not this",
    ].join("\n");
    expect(criteriaOf(body)).toEqual({ text: "1. One.\n2. Two.", source: "criteria" });
  });

  test("a definition-of-done heading works the same way", () => {
    const body = "## Definition of Done\n\n- a\n- b\n\n## Deps\n- nothing";
    expect(criteriaOf(body)).toEqual({ text: "- a\n- b", source: "criteria" });
  });

  test("no such heading: the whole body is the bar, not an empty one", () => {
    const body = "The page lies about the sector.\nMake it stop.";
    expect(criteriaOf(body)).toEqual({ text: body, source: "body" });
  });

  test("an empty body is an error, not an empty bar", () => {
    expect(() => criteriaOf("   \n\n ")).toThrow();
  });
});

describe("is the ticket ready for an agent", () => {
  test("ready-for-agent is eligible", () => {
    expect(eligibility(["bug", "ready-for-agent", "P2"])).toEqual({ ok: true, state: "ready-for-agent" });
  });

  test("every other state is a refusal that names it", () => {
    expect(eligibility(["bug", "needs-info"])).toEqual({ ok: false, state: "needs-info" });
    expect(eligibility(["bug", "wontfix"]).state).toBe("wontfix");
    expect(eligibility(["bug", "ready-for-human"]).state).toBe("ready-for-human");
  });

  test("no labels at all reads as untriaged", () => {
    expect(eligibility([])).toEqual({ ok: false, state: "untriaged" });
  });
});

describe("the ask is built from the whole ticket (2957787)", () => {
  const ticket = {
    number: 54,
    title: "detailParser: read the November markup",
    state: "OPEN",
    labels: ["bug", "ready-for-agent"],
    body: [
      "## What to build",
      "Rewrite the parser.",
      "",
      "## Acceptance criteria",
      "1. Every field.",
      "",
      "## Dependencies",
      "- Needs before merge: #64 (open).",
      "",
      "## Out of scope",
      "- The email parser.",
    ].join("\n"),
  };

  test("the task carries the body verbatim, constraints and dependencies included", () => {
    const asked = askedFrom(ticket);
    expect(asked.task).toContain("Needs before merge: #64 (open).");
    expect(asked.task).toContain("## Out of scope");
    expect(asked.task).toContain("- The email parser.");
    expect(asked.task).toContain('"detailParser: read the November markup"');
    expect(asked.task).toContain("Resolve ticket #54");
  });

  test("the bar is the criteria section, not a paraphrase and not the whole body", () => {
    const asked = askedFrom(ticket);
    expect(asked.definitionOfDone).toBe("1. Every field.");
    expect(asked.source).toBe("criteria");
  });
});

describe("a blocked ticket is not dispatchable (2957787)", () => {
  test("an open blocker is named", () => {
    expect(blockerReason([{ number: 64, state: "open" }, { number: 65, state: "closed" }])).toBe(
      "blocked by #64 (open)",
    );
  });

  test("only closed blockers: nothing blocks", () => {
    expect(blockerReason([{ number: 65, state: "closed" }])).toBeNull();
  });

  test("no blockers at all: nothing blocks", () => {
    expect(blockerReason([])).toBeNull();
  });

  test("two open blockers are both named", () => {
    expect(blockerReason([{ number: 64, state: "open" }, { number: 67, state: "open" }])).toBe(
      "blocked by #64 (open), #67 (open)",
    );
  });
});

describe("dependencies named in prose count too (5ae0c30)", () => {
  // The real bodies. #54 carries a native edge *and* the sentence; #64 carries the sentence that
  // must NOT read as a blocker, because it is about what it blocks, not what blocks it.
  const body54 = [
    "## What to build",
    "Something. See #53 for context and #57 later.",
    "",
    "## Dependencies",
    "- Needs before merge: #64 (open). #65 is closed, so that half of the edge is already cleared.",
    "- Blocks #57 (open): it re-runs the symbols this parser repairs.",
    "*Blocked by #64 and #65* as native GitHub dependencies.",
    "",
    "## Out of scope",
    "- Nothing here mentions #67.",
  ].join("\n");

  const body64 = [
    "## Acceptance criteria",
    "1. Something.",
    "",
    "## Dependencies",
    "- Nothing blocks this ticket.",
    "- Blocks #54 (open) and #67 (open): #54 must not merge before this.",
    // The line that made a naive scan refuse the one runnable ticket: it says *they* wait for *me*.
    "None to build. #54 and #55 must not merge before this: once a parse returns 1 to 32 fields, every",
    "row is stored `partial` and reported ok.",
    "",
    "## Out of scope",
    "- The parser, which is #54.",
  ].join("\n");

  const body67 = [
    "## Dependencies",
    "- Needs #64 (open) merged first: it sets the cutoff.",
    "- Nothing depends on this ticket.",
  ].join("\n");

  test("a 'needs before merge' line names its blockers", () => {
    expect(dependencyReferences(body54).sort((a, b) => a - b)).toEqual([64, 65]);
  });

  test("a 'blocks' line is not a blocker, however open the ticket it names", () => {
    expect(dependencyReferences(body64)).toEqual([]);
  });

  test("'nothing blocks this ticket' names nobody", () => {
    expect(dependencyReferences(body64)).not.toContain(54);
  });

  test("mentions outside the Dependencies section are not blockers", () => {
    expect(dependencyReferences(body54)).not.toContain(53);
    expect(dependencyReferences(body54)).not.toContain(57);
    expect(dependencyReferences(body64)).not.toContain(67);
  });

  test("a 'needs #n' line is a blocker", () => {
    expect(dependencyReferences(body67)).toEqual([64]);
  });

  test("a prose-only blocker reaches the same refusal as a native one", () => {
    const states = dependencyReferences(body67).map((n) => ({ number: n, state: "open" }));
    expect(blockerReason(states)).toBe("blocked by #64 (open)");
  });
});

/**
 * One command per ticket (#68). The template is a consequence of the body, the claims preflight runs where the
 * room will run, and a refusal is a row rather than a crash.
 */
describe("the template follows the ticket", () => {
  test("a body carrying a claims block wants the claims room", () => {
    expect(pickTemplate("# t\n\n```claims\n[]\n```\n")).toBe("ticket-resolver1-claims");
  });

  test("a body without one wants the base room", () => {
    expect(pickTemplate("# t\n\nNo records here.\n")).toBe("ticket-resolver1");
  });

  test("the template path comes from this file's location, not the cwd", () => {
    expect(templatePath("ticket-resolver1")).toMatch(/\/rooms\/templates\/ticket-resolver1\/template\.yaml$/);
  });
});

describe("the claims preflight report", () => {
  test("no block is fatal and says what to do", () => {
    const rows = claimsRows({ hasBlock: false, beforeExit: null, unverified: null });
    expect(rows[0]).toMatchObject({ ok: false, fatal: true, label: "claims block" });
    expect(rows[0]!.detail).toContain("has no claims block");
  });

  test("a failing before phase is fatal, an unverified criterion only warns", () => {
    const rows = claimsRows({ hasBlock: true, beforeExit: 1, unverified: 2 });
    expect(rows.find((r) => r.label === "claims before phase")).toMatchObject({ ok: false, fatal: true });
    expect(rows.find((r) => r.label === "claims unverified")).toMatchObject({ ok: false, fatal: false });
  });

  test("a clean block is green on every row", () => {
    expect(claimsRows({ hasBlock: true, beforeExit: 0, unverified: 0 }).every((r) => r.ok)).toBe(true);
  });

  test("--no-claims says it skipped instead of pretending it passed", () => {
    const rows = claimsRows({ hasBlock: false, beforeExit: null, unverified: null, skipped: true });
    expect(rows[0]!.detail).toContain("skipped");
  });

  test("a missing block refuses, and a warning does not", () => {
    // Regression: the exit code once tested `hasBlock && beforeExit !== 0`, so the one case that must stop a
    // launch printed FAIL and exited 0.
    expect(claimsRefused(claimsRows({ hasBlock: false, beforeExit: null, unverified: null }))).toBe(true);
    expect(claimsRefused(claimsRows({ hasBlock: true, beforeExit: 1, unverified: 0 }))).toBe(true);
    expect(claimsRefused(claimsRows({ hasBlock: true, beforeExit: 0, unverified: 3 }))).toBe(false);
    expect(claimsRefused(claimsRows({ hasBlock: true, beforeExit: 0, unverified: 0 }))).toBe(false);
  });
});

describe("what a refused preflight leads to (#70)", () => {
  // One prep pass per launch, never a loop, and a template a human named is not overridden by a room the
  // launcher picked for them.
  test("a green gate goes straight to the resolver room", () => {
    expect(prepFirst({ refused: false, prepRan: false, templateRequested: false })).toBe("resolver");
  });

  test("a refusal nobody has repaired yet runs the prep room once", () => {
    expect(prepFirst({ refused: true, prepRan: false, templateRequested: false })).toBe("prep");
  });

  test("still refused after that pass stops instead of running prep again", () => {
    expect(prepFirst({ refused: true, prepRan: true, templateRequested: false })).toBe("stop");
  });

  test("an explicit --template is the human's decision, so the chain stays out of it", () => {
    expect(prepFirst({ refused: true, prepRan: false, templateRequested: true })).toBe("stop");
    expect(prepFirst({ refused: true, prepRan: true, templateRequested: true })).toBe("stop");
  });
});

describe("where claim-check comes from", () => {
  test("the repo's own override wins", () => {
    expect(resolveClaimCheck({ AH_CLAIM_CHECK: import.meta.path, PATH: "" })).toBe(import.meta.path);
  });

  test("an override pointing at nothing resolves to nothing, never to PATH", () => {
    expect(resolveClaimCheck({ AH_CLAIM_CHECK: "/nope/claim-check", PATH: process.env.PATH ?? "" })).toBeNull();
  });

  test("PATH is the documented convention, as for pi and herdr", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-path-"));
    const bin = join(dir, "claim-check");
    await writeFile(bin, "#!/bin/sh\nexit 0\n");
    await chmod(bin, 0o755);
    expect(resolveClaimCheck({ PATH: dir })).toBe(bin);
  });
});

describe("the launch as a value (#78)", () => {
  const launch = (over: Partial<LaunchFlags> = {}): Launch => {
    const flags: LaunchFlags = {
      repo: "/repo",
      issue: "75",
      requested: null,
      template: null,
      runFile: "/repo/_run/004-ticket-75/run.yaml",
      branch: true,
      dryRun: false,
      checkOnly: false,
      warm: true,
      noClaims: false,
      anyState: false,
      ignoreBlockers: false,
      prepRan: false,
      ...over,
    };
    return {
      flags,
      slug: "004-ticket-75",
      runFile: flags.runFile ?? "/repo/_run/004-ticket-75/run.yaml",
      runDir: "/repo/_run/004-ticket-75",
      worktree: "/repo-004-ticket-75",
      template: "/rooms/templates/ticket-resolver1-claims/template.yaml",
      name: "ticket-resolver1-claims",
    };
  };

  const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
    worktreeAction: "create",
    claimsStatus: 1,
    created: true,
    branch: true,
    prepRan: false,
    templateRequested: false,
    config: "/repo/_run/004-ticket-75/run.resolved.yaml",
    ...over,
  });

  /** Rows copied from a real refusal: `_run/chain.out` lines 15, 17 and 22 of the #75 dispatch. */
  const REFUSAL_ROWS =
    "launch: FAIL claims before phase — run --phase before exited 1\n" +
    "launch: claims preflight refused — removing /repo-004-ticket-75 and /repo/_run/004-ticket-75\n" +
    "launch: ok   branch run/004-ticket-75-prep\n";

  function fakeDeps(answer: { worktree: string; worktreeStatus?: number; claims: number; config: string }) {
    const calls: string[] = [];
    const writes: string[] = [];
    let boots = 0;
    const deps: LaunchDeps = {
      exec: (cmd, args) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        if (cmd === "bun" && args[0].endsWith("launch.ts") && args[1] === "worktree") {
          return { status: answer.worktreeStatus ?? 0, stdout: `${answer.worktree}\n`, stderr: "" };
        }
        if (cmd === "bun" && args[0].endsWith("launch.ts") && args[1] === "claims") {
          return { status: answer.claims, stdout: "", stderr: REFUSAL_ROWS };
        }
        if (cmd === "bun" && args[0].endsWith("room-run.ts")) {
          return { status: 0, stdout: `${answer.config}\n`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
      boot: () => {
        boots += 1;
        return 0;
      },
      write: (line) => void writes.push(line),
    };
    return { deps, calls, writes, boots: () => boots };
  }

  test("a refusal is cleanup, then the prep pass, then the re-ask, and nothing is booted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-plan-"));
    try {
      await writeFile(join(dir, "run.yaml"), "template: x\n");
      const config = join(dir, "run.resolved.yaml");
      await writeFile(config, "name: room\n");
      const l = launch({ runFile: join(dir, "run.yaml") });
      const f = fakeDeps({ worktree: "create", claims: 1, config });

      expect(planLaunch(l, facts()).map((s) => s.kind)).toEqual(["cleanup", "prep", "reAsk"]);
      expect(performLaunch(l, f.deps)).toBe(0);

      expect(f.boots()).toBe(0);
      const prep = f.calls.findIndex((c) => c.includes("--template ticket-prep"));
      const reAsk = f.calls.findIndex((c) => c.includes("--issue 75") && c.includes("launch-plan.ts") && !c.includes("ticket-prep"));
      expect(prep).toBeGreaterThan(-1);
      expect(reAsk).toBeGreaterThan(prep);
      expect(f.calls[prep]).toContain("--slug ticket-75-prep");
      expect(f.calls[prep]).toContain("--prep-ran");
      // The chain, in the order the room printed it: the preflight's row, then the cleanup.
      const at = (needle: string) => f.writes.findIndex((w) => w.includes(needle));
      expect(at("FAIL claims before phase")).toBeGreaterThan(-1);
      expect(at("claims preflight refused")).toBeGreaterThan(at("FAIL claims before phase"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the cleanup removes the branch only when this launch created it", () => {
    expect(planLaunch(launch(), facts({ created: true, branch: true }))[0]).toEqual({
      kind: "cleanup",
      branch: "run/004-ticket-75",
    });
    expect(planLaunch(launch(), facts({ created: false, branch: true }))[0]).toEqual({ kind: "cleanup", branch: null });
  });

  test("the cleanup's branch deletion reaches git only for the created case", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-plan-"));
    try {
      await writeFile(join(dir, "run.yaml"), "template: x\n");
      const config = join(dir, "run.resolved.yaml");
      await writeFile(config, "name: room\n");
      const l = launch({ runFile: join(dir, "run.yaml") });
      const reused = fakeDeps({ worktree: "reuse", claims: 1, config });
      await performLaunch(l, reused.deps);
      expect(reused.calls.some((c) => c.includes("branch -D run/004-ticket-75"))).toBe(false);

      const created = fakeDeps({ worktree: "create", claims: 1, config });
      await performLaunch(l, created.deps);
      expect(created.calls.some((c) => c.includes("branch -D run/004-ticket-75"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a refused worktree plans nothing and removes nothing", async () => {
    expect(planLaunch(launch(), facts({ worktreeAction: "refuse", claimsStatus: 0 }))).toEqual([]);

    const dir = await mkdtemp(join(tmpdir(), "ah-plan-"));
    try {
      await writeFile(join(dir, "run.yaml"), "template: x\n");
      const config = join(dir, "run.resolved.yaml");
      await writeFile(config, "name: room\n");
      const f = fakeDeps({ worktree: "refuse", worktreeStatus: 1, claims: 0, config });
      expect(performLaunch(launch({ runFile: join(dir, "run.yaml") }), f.deps)).toBe(1);
      expect(f.calls.some((c) => c.includes("worktree remove"))).toBe(false);
      expect(f.boots()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the successful tail is warm, summary, and a dry run stops before booting", async () => {
    const l = launch({ dryRun: true, warm: false });
    expect(planLaunch(l, facts({ claimsStatus: 0 })).map((s) => s.kind)).toEqual(["summary", "dryRun"]);

    const dir = await mkdtemp(join(tmpdir(), "ah-plan-"));
    try {
      await writeFile(join(dir, "run.yaml"), "template: x\n");
      const config = join(dir, "run.resolved.yaml");
      await writeFile(config, "name: room\n");
      const f = fakeDeps({ worktree: "reuse", claims: 0, config });
      expect(performLaunch(launch({ runFile: join(dir, "run.yaml"), dryRun: true, warm: false }), f.deps)).toBe(0);
      expect(f.boots()).toBe(0);
      expect(
        f.writes.some(
          (w) => w === `launch: dry run, not booting. Resolved config: ${config}`,
        ),
      ).toBe(true);
      expect(
        f.writes.some((w) =>
          w.startsWith(
            "launch: template=ticket-resolver1-claims run=/repo/_run/004-ticket-75 worktree=/repo-004-ticket-75 branch=run/004-ticket-75",
          ),
        ),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the child invocations parse back into the flags they were built from", () => {
    const argsOf = (kind: "prep" | "reAsk"): string[] => {
      const step = planLaunch(launch({ warm: false }), facts()).find((s) => s.kind === kind);
      if (step === undefined || (step.kind !== "prep" && step.kind !== "reAsk")) throw new Error(`no ${kind} step`);
      return step.args;
    };

    // A hand-built argument list that the parser cannot read is a launch that dies in the refusal chain.
    const prep = parseLaunchFlags(argsOf("prep"));
    expect({
      template: prep.template,
      requested: prep.requested,
      prepRan: prep.prepRan,
      noClaims: prep.noClaims,
    }).toEqual({ template: "ticket-prep", requested: "ticket-75-prep", prepRan: true, noClaims: true });

    const reAsk = parseLaunchFlags(argsOf("reAsk"));
    expect({
      template: reAsk.template,
      requested: reAsk.requested,
      branch: reAsk.branch,
      warm: reAsk.warm,
      prepRan: reAsk.prepRan,
    }).toEqual({ template: null, requested: null, branch: true, warm: false, prepRan: true });
  });

  test("the flags are the ones the shell used to parse", () => {
    expect(
      parseLaunchFlags([
        "--repo", "/r", "--issue", "81", "--slug", "s", "--template", "ticket-resolver1",
        "--branch", "--dry-run", "--no-warm", "--any-state", "--ignore-blockers", "--no-claims", "--prep-ran",
      ]),
    ).toEqual({
      repo: "/r",
      issue: "81",
      requested: "s",
      template: "ticket-resolver1",
      runFile: null,
      branch: true,
      dryRun: true,
      checkOnly: false,
      warm: false,
      noClaims: true,
      anyState: true,
      ignoreBlockers: true,
      prepRan: true,
    });
    expect(() => parseLaunchFlags(["--nope"])).toThrow("unknown argument");
    expect(() => parseLaunchFlags(["--issue"])).toThrow("needs a value");
  });
});
