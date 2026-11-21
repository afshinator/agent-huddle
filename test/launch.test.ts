import { test, expect, describe } from "bun:test";
import {
  askedFrom,
  blockerReason,
  criteriaOf,
  dependencyReferences,
  eligibility,
  lockfileFor,
  worktreeAction,
  warmPlan,
} from "../src/launch";

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

describe("the ask is built from the whole ticket (#81)", () => {
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

describe("a blocked ticket is not dispatchable (#81)", () => {
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

describe("dependencies named in prose count too (#82)", () => {
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
