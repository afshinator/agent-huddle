import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLaunchDir } from "../src/launch-guard";
import { gitRepo } from "./helpers";

const run = promisify(execFile);

/** A linked worktree of `repo`, the place `AGENTS.md` says to run a supervised room. */
async function worktreeOf(repo: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "ah-wt-")), "wt");
  await run("git", ["-C", repo, "worktree", "add", path, "-b", "throwaway"]);
  return path;
}

async function nonRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ah-guard-plain-"));
}

describe("inspectLaunchDir", () => {
  test("a git repository root is reported with its branch", async () => {
    const dir = await gitRepo();
    try {
      const result = await inspectLaunchDir(dir);
      expect(result.isRepoRoot).toBe(true);
      expect(result.dir).toBe(await realpath(dir));
      expect(result.branch).toMatch(/^(main|master)$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a linked worktree root is a repository root, but marked a worktree", async () => {
    const repo = await gitRepo();
    try {
      const wt = await worktreeOf(repo);
      try {
        const launch = await inspectLaunchDir(wt);
        expect(launch.isRepoRoot).toBe(true);
        expect(launch.worktree).toBe(true);
        // The main checkout is the case the guard exists for: no worktree marker.
        expect((await inspectLaunchDir(repo)).worktree).toBe(false);
      } finally {
        await rm(join(wt, ".."), { recursive: true, force: true });
      }
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("a subdirectory of a repository is not the root", async () => {
    const dir = await gitRepo();
    const sub = join(dir, "src");
    await mkdir(sub);
    try {
      expect((await inspectLaunchDir(sub)).isRepoRoot).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a directory outside any repository is not the root", async () => {
    const dir = await nonRepo();
    try {
      const result = await inspectLaunchDir(dir);
      expect(result.isRepoRoot).toBe(false);
      expect(result.branch).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a missing git binary is not a repository, and does not throw", async () => {
    const dir = await nonRepo();
    try {
      const missingGit = async (): Promise<string> => {
        throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
      };
      const result = await inspectLaunchDir(dir, missingGit);
      expect(result.isRepoRoot).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
