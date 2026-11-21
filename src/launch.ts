/**
 * The decisions a launch makes, kept out of the shell script.
 *
 * `rooms/launch.sh` used to carry them: six steps a human had to remember before booting a room —
 * clean the last worktree, warm the dependencies, write the ask, check the ticket is triaged, keep the
 * base commit honest. Each of those is mechanical, and each failed silently when forgotten, so they
 * live here where a test can hold them (#80). The shell script keeps only what needs git and gh.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- lockfiles

const LOCKFILES = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"];

/** Which dependency manager a repo uses, from the files it has. */
export function lockfileFor(names: readonly string[]): string | null {
  // Sorted, so the refusal message reads the same whatever order the directory lists files in.
  const found = LOCKFILES.filter((l) => names.includes(l)).sort();
  if (found.length === 0) return null;
  // Two lockfiles is a repo mid-migration; guessing one installs a tree nobody asked for.
  if (found.length > 1) return `ambiguous:${found.join(",")}`;
  return found[0]!;
}

const INSTALL: Record<string, readonly string[]> = {
  "bun.lock": ["bun", "install", "--frozen-lockfile"],
  "bun.lockb": ["bun", "install", "--frozen-lockfile"],
  "pnpm-lock.yaml": ["pnpm", "install", "--frozen-lockfile"],
  "package-lock.json": ["npm", "ci"],
  "yarn.lock": ["yarn", "install", "--frozen-lockfile"],
};

export type WarmMode = "clone" | "install" | "skip" | "refuse";

export interface WarmInput {
  /** From `lockfileFor`, so `ambiguous:…` arrives here as a value to refuse. */
  lockfile: string | null;
  /** The worktree already has `node_modules`, so a relaunch has nothing to do. */
  worktreeHasModules?: boolean;
  sourceHasModules: boolean;
  /** Hash of the source checkout's lockfile, and of the worktree's. */
  sourceLock: string | null;
  worktreeLock: string | null;
}

export interface WarmDecision {
  mode: WarmMode;
  reason: string;
}

/**
 * Copy the dependencies from the checkout you launched from, or install them.
 *
 * Copying is the cheap path — measured at 8.1s for 763 MB against 42.7s for `npm ci` — and it is only
 * correct when both trees want the same rows. A copy that does not match the lockfile tests the wrong
 * dependency set and reports green anyway.
 */
export function warmPlan(input: WarmInput): WarmDecision {
  if (input.lockfile === null) return { mode: "skip", reason: "no lockfile in the worktree" };
  if (input.lockfile.startsWith("ambiguous:")) {
    return { mode: "refuse", reason: `${input.lockfile.slice(10).replace(",", " and ")} are both present; pick one` };
  }
  // A relaunch of the same run: the tree was warmed for this worktree's own lockfile already.
  if (input.worktreeHasModules === true) return { mode: "skip", reason: "the worktree is already warmed" };
  if (!input.sourceHasModules) {
    return { mode: "install", reason: "no node_modules in the source checkout to clone" };
  }
  if (input.sourceLock === null || input.worktreeLock === null) {
    return { mode: "install", reason: "a lockfile could not be read, so it cannot be compared" };
  }
  if (input.sourceLock !== input.worktreeLock) {
    return { mode: "install", reason: `the worktree's ${input.lockfile} differs from the source checkout` };
  }
  return { mode: "clone", reason: "the lockfile matches the source checkout" };
}

// ---------------------------------------------------------------- worktrees

export type WorktreeAction = "create" | "reuse" | "replace" | "refuse";

export interface WorktreeInput {
  exists: boolean;
  /** The worktree's HEAD is the repo's current base commit. */
  headMatchesBase: boolean;
  dirty: boolean;
  /** `run/<slug>` is already merged into the base branch. */
  branchMerged: boolean;
}

export interface WorktreeDecision {
  action: WorktreeAction;
  reason: string;
}

/**
 * What to do about `<repo>-<slug>`.
 *
 * Reusing a worktree cut from an older commit is the quiet one: the room works, the branch looks
 * healthy, and the base is a commit nobody looks at again.
 */
export function worktreeAction(input: WorktreeInput): WorktreeDecision {
  if (!input.exists) return { action: "create", reason: "no worktree for this run yet" };
  if (input.headMatchesBase) return { action: "reuse", reason: "the worktree is at the base commit" };
  if (input.dirty) {
    return { action: "refuse", reason: "the worktree is behind and has uncommitted work; nothing was removed" };
  }
  if (!input.branchMerged) {
    return {
      action: "refuse",
      reason: "the worktree is behind and its branch is not merged; merge or remove it yourself",
    };
  }
  return { action: "replace", reason: "the worktree is behind, clean, and its branch is already merged" };
}

// ---------------------------------------------------------------- tickets

export interface Criteria {
  text: string;
  /** `criteria` when a heading was found, `body` when the whole body is the bar. */
  source: "criteria" | "body";
}

const CRITERIA_HEADING = /^#{1,6}\s*(acceptance criteria|definition of done)\b.*$/im;

/**
 * A ticket's own bar, taken verbatim.
 *
 * A paraphrase in `definition_of_done` is a bar nobody wrote; the previous ticket run shipped one that
 * happened to be right. A body with no such heading falls back to the whole body rather than to an
 * empty bar, because an empty bar is satisfied by nothing.
 */
export function criteriaOf(body: string): Criteria {
  const trimmed = body.trim();
  if (trimmed === "") throw new Error("the ticket body is empty");
  const match = CRITERIA_HEADING.exec(trimmed);
  if (match === null) return { text: trimmed, source: "body" };
  const level = (match[0].match(/^#+/) ?? ["#"])[0].length;
  const after = trimmed.slice(match.index + match[0].length);
  const lines = after.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading !== null && heading[1]!.length <= level) break;
    out.push(line);
  }
  const text = out.join("\n").trim();
  return text === "" ? { text: trimmed, source: "body" } : { text, source: "criteria" };
}

export interface Eligibility {
  ok: boolean;
  state: string;
}

const STATES = ["ready-for-agent", "needs-triage", "needs-info", "ready-for-human", "wontfix"];

/** Whether a ticket may be handed to a room, from its labels (the triage vocabulary). */
export function eligibility(labels: readonly string[]): Eligibility {
  const state = STATES.find((s) => labels.includes(s));
  if (state === undefined) return { ok: false, state: "untriaged" };
  return { ok: state === "ready-for-agent", state };
}

// ---------------------------------------------------------------- the shell interface

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function trySh(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return sh(cmd, args, cwd);
  } catch {
    return null;
  }
}

const argsOf = (argv: string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      map.set(a.slice(2), next);
      i += 1;
    } else map.set(a.slice(2), "1");
  }
  return map;
};

const lockHash = (dir: string, lockfile: string | null): string | null => {
  if (lockfile === null || lockfile.startsWith("ambiguous:")) return null;
  const path = join(dir, lockfile);
  if (!existsSync(path)) return null;
  return String(Bun.hash(readFileSync(path, "utf8")));
};

function cmdWorktree(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const slug = args.get("slug")!;
  const worktree = join(repo, "..", `${repo.split("/").pop()}-${slug}`);
  const exists = existsSync(worktree);
  let headMatchesBase = true;
  let dirty = false;
  let branchMerged = false;
  if (exists) {
    const base = trySh("git", ["-C", repo, "rev-parse", "HEAD"]);
    const head = trySh("git", ["-C", worktree, "rev-parse", "HEAD"]);
    headMatchesBase = base !== null && head !== null && base === head;
    dirty = (trySh("git", ["-C", worktree, "status", "--porcelain"]) ?? "").length > 0;
    const merged = trySh("git", ["-C", repo, "branch", "--merged", "HEAD", "--list", `run/${slug}`]) ?? "";
    branchMerged = merged.trim() !== "";
  }
  const decision = worktreeAction({ exists, headMatchesBase, dirty, branchMerged });
  process.stderr.write(`launch: worktree ${decision.action} — ${decision.reason}\n`);
  process.stdout.write(`${decision.action}\n`);
  return decision.action === "refuse" ? 1 : 0;
}

function cmdWarm(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const worktree = args.get("worktree")!;
  const lockfile = lockfileFor([
    ...new Set([
      ...["bun.lock", "bun.lockb", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"].filter((l) =>
        existsSync(join(worktree, l)),
      ),
    ]),
  ]);
  const plan = warmPlan({
    lockfile,
    worktreeHasModules: existsSync(join(worktree, "node_modules")),
    sourceHasModules: existsSync(join(repo, "node_modules")),
    sourceLock: lockHash(repo, lockfile),
    worktreeLock: lockHash(worktree, lockfile),
  });
  if (plan.mode === "skip") {
    process.stderr.write(`launch: warm skipped — ${plan.reason}\n`);
    return 0;
  }
  if (plan.mode === "refuse") {
    process.stderr.write(`launch: warm refused — ${plan.reason}\n`);
    return 1;
  }
  const started = Bun.nanoseconds();
  if (plan.mode === "clone") {
    // `cp -R src dst` copies *into* dst when dst exists, which nests a second tree inside the first.
    rmSync(join(worktree, "node_modules"), { recursive: true, force: true });
    // Same volume, so this is a copy-on-write clone: measured 8.1s vs 42.7s for `npm ci` (#80).
    trySh("cp", ["-cR", join(repo, "node_modules"), join(worktree, "node_modules")]) ??
      sh("cp", ["-R", join(repo, "node_modules"), join(worktree, "node_modules")]);
  } else {
    const cmd = INSTALL[lockfile!]!;
    sh(cmd[0]!, [...cmd.slice(1)], worktree);
  }
  const seconds = (Bun.nanoseconds() - started) / 1e9;
  process.stderr.write(`launch: warm ${plan.mode} in ${seconds.toFixed(1)}s — ${plan.reason}\n`);
  return 0;
}

function cmdCheck(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const slug = args.get("slug") ?? "";
  const issueMode = args.get("issue") !== undefined;
  const rows: Array<{ ok: boolean; fatal: boolean; label: string; detail: string }> = [];
  const isRepo = trySh("git", ["-C", repo, "rev-parse", "--git-dir"]) !== null;
  rows.push({ ok: isRepo, fatal: true, label: "git working tree", detail: repo });
  if (isRepo) {
    const ignored = trySh("git", ["-C", repo, "check-ignore", "-q", "_run/"]) !== null;
    rows.push({ ok: ignored, fatal: false, label: "_run/ gitignored", detail: ignored ? "" : "add `_run/` before a room writes there" });
    const base = trySh("git", ["-C", repo, "rev-parse", "--short", "HEAD"]) ?? "?";
    const branch = trySh("git", ["-C", repo, "rev-parse", "--abbrev-ref", "HEAD"]) ?? "?";
    rows.push({ ok: true, fatal: false, label: "base", detail: `${branch} ${base}` });
    const dirtyCount = (trySh("git", ["-C", repo, "status", "--porcelain"]) ?? "").split("\n").filter((l) => l.trim() !== "").length;
    rows.push({
      ok: dirtyCount === 0,
      fatal: false,
      label: "checkout clean",
      detail: dirtyCount === 0 ? "" : `${dirtyCount} uncommitted path(s) will not be in the worktree`,
    });
    if (slug !== "") {
      const free = trySh("git", ["-C", repo, "branch", "--list", `run/${slug}`])?.trim() === "";
      rows.push({ ok: free === true, fatal: false, label: `branch run/${slug}`, detail: free === true ? "" : "exists; the launcher will refuse or reuse its worktree" });
    }
  }
  if (issueMode) {
    const auth = trySh("gh", ["auth", "status"]) !== null;
    rows.push({ ok: auth, fatal: true, label: "gh authenticated", detail: auth ? "" : "run `gh auth login`" });
  }
  for (const row of rows) {
    process.stderr.write(`launch: ${row.ok ? "ok  " : row.fatal ? "FAIL" : "warn"} ${row.label}${row.detail === "" ? "" : ` — ${row.detail}`}\n`);
  }
  return rows.some((r) => !r.ok && r.fatal) ? 1 : 0;
}

function cmdIssue(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const issue = args.get("issue")!;
  const out = args.get("out")!;
  const template = args.get("template")!;
  const json = JSON.parse(sh("gh", ["issue", "view", issue, "--json", "number,title,state,labels,body"], repo)) as {
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    body: string;
  };
  const labels = json.labels.map((l) => l.name);
  const found = eligibility(labels);
  process.stderr.write(`launch: #${json.number} ${json.state.toLowerCase()} [${labels.join(",")}] ${json.title}\n`);
  if (!found.ok && args.get("any-state") === undefined) {
    process.stderr.write(
      `launch: refusing — #${json.number} is ${found.state}, not ready-for-agent. Re-run with --any-state to override.\n`,
    );
    return 1;
  }
  const criteria = criteriaOf(json.body);
  if (criteria.source === "body") {
    process.stderr.write("launch: no acceptance-criteria heading in the body; the whole body is the bar\n");
  }
  const block = (label: string, text: string): string =>
    `${label}: |\n` +
    text
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n") +
    "\n";
  mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    out,
    `template: ${template}\n` +
      block("task", `Resolve ticket #${json.number} in this repo: "${json.title}".\n\nRead it with \`gh issue view ${json.number}\`; its body is the spec.`) +
      block("definition_of_done", criteria.text) +
      // The ask is a starting point a human edits; the two lines below are the ones only a person can write.
      `# Edit the task above: name the files in scope, the constraints the ticket states, and what is out of scope.\n`,
  );
  process.stderr.write(`launch: wrote the ask at ${out} (bar from the ticket's ${criteria.source})\n`);
  return 0;
}

if (import.meta.path === Bun.main) {
  const [command, ...rest] = process.argv.slice(2);
  const exit =
    command === "worktree"
      ? cmdWorktree(rest)
      : command === "warm"
        ? cmdWarm(rest)
        : command === "check"
          ? cmdCheck(rest)
          : command === "issue"
            ? cmdIssue(rest)
            : (process.stderr.write("usage: bun src/launch.ts <worktree|warm|check|issue> --repo …\n"), 2);
  process.exit(exit);
}
