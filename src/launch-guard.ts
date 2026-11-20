import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface LaunchDir {
  /** Resolved launch directory, the one the agents inherit as their cwd. */
  dir: string;
  isRepoRoot: boolean;
  branch: string | null;
}

/** Raised at boot so the CLI can print one line instead of a stack trace. */
export class LaunchGuardError extends Error {}

type GitRun = (args: string[], cwd: string) => Promise<string>;

/**
 * Does this directory sit at the root of a git repository? (#38)
 *
 * Agents inherit the coordinator's cwd and write real files there: a supervised run
 * put its deliverable in the repo root and the repo's test command then ran the
 * agent's tests. Comparing against `--show-toplevel` rather than looking for `.git`
 * means a worktree and a subdirectory are both classified correctly, and a missing
 * `git` binary reads as "not a repository" instead of a boot failure.
 */
export async function inspectLaunchDir(cwd: string, git: GitRun = defaultGit): Promise<LaunchDir> {
  const dir = await realpath(cwd).catch(() => cwd);
  const toplevel = await git(["-C", dir, "rev-parse", "--show-toplevel"], dir).catch(() => null);
  if (toplevel === null) return { dir, isRepoRoot: false, branch: null };

  const root = await realpath(toplevel.trim()).catch(() => toplevel.trim());
  if (root !== dir) return { dir, isRepoRoot: false, branch: null };

  // symbolic-ref works on a repository with no commits yet; rev-parse does not.
  const branch = await git(["-C", dir, "symbolic-ref", "--short", "HEAD"], dir).catch(() => null);
  return { dir, isRepoRoot: true, branch: branch === null ? null : branch.trim() };
}

async function defaultGit(args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { maxBuffer: 1 << 20 });
  return stdout;
}

/** The boot decision: refuse, warn, or say nothing (§10). */
export function guardMessage(launch: LaunchDir): string {
  const where = launch.branch === null ? "a git repository root" : `the git repository root (branch ${launch.branch})`;
  return (
    `refusing to start: ${launch.dir} is ${where}. ` +
    "Agents inherit this directory and write real files into it, including tests that your own test run will pick up. " +
    "Run the room from a worktree or a throwaway branch, or set launch_guard: warn to accept the risk."
  );
}
