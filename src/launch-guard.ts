import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface LaunchDir {
  /** Resolved launch directory, the one the agents inherit as their cwd. */
  dir: string;
  isRepoRoot: boolean;
  /** A linked worktree root: a repository root, but a throwaway one (#48). */
  worktree: boolean;
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
  if (toplevel === null) return { dir, isRepoRoot: false, worktree: false, branch: null };

  const root = await realpath(toplevel.trim()).catch(() => toplevel.trim());
  if (root !== dir) return { dir, isRepoRoot: false, worktree: false, branch: null };

  // symbolic-ref works on a repository with no commits yet; rev-parse does not.
  const branch = await git(["-C", dir, "symbolic-ref", "--short", "HEAD"], dir).catch(() => null);
  return {
    dir,
    isRepoRoot: true,
    worktree: await isLinkedWorktree(dir, git),
    branch: branch === null ? null : branch.trim(),
  };
}

/**
 * A linked worktree keeps its git dir under the main repository's, so `--git-dir` and
 * `--git-common-dir` differ. A main checkout has one directory for both. This also
 * tells a worktree from a `--separate-git-dir` clone, which `test -f .git` cannot.
 */
async function isLinkedWorktree(dir: string, git: GitRun): Promise<boolean> {
  const out = await git(["-C", dir, "rev-parse", "--git-dir", "--git-common-dir"], dir).catch(() => null);
  if (out === null) return false;
  const [gitDir, commonDir] = out.trim().split("\n");
  if (gitDir === undefined || commonDir === undefined) return false;
  return resolve(dir, gitDir) !== resolve(dir, commonDir);
}

async function defaultGit(args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, { maxBuffer: 1 << 20 });
  return stdout;
}

/** The warn-mode line. Printed, because a warning only a file sees is nearly silence (#48). */
export function guardWarning(launch: LaunchDir): string {
  const where = launch.branch === null ? "a git repository root" : `the git repository root (branch ${launch.branch})`;
  return (
    `warning: agents will write real files into ${launch.dir}, ${where}. ` +
    "Their tests join your test run. Run supervised rooms from a worktree or a throwaway branch."
  );
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
