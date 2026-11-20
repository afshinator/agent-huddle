import { test, expect, describe } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLaunchDir } from "../src/launch-guard";

const git = promisify(execFile);

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ah-guard-"));
  await git("git", ["init", "-q"], { cwd: dir });
  return dir;
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

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import("node:fs/promises");
  return rp(p);
}
