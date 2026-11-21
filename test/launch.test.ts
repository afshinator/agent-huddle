import { test, expect, describe } from "bun:test";
import {
  criteriaOf,
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
