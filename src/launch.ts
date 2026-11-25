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
import { join, resolve } from "node:path";

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

export interface Ticket {
  number: number;
  title: string;
  state: string;
  labels: readonly string[];
  body: string;
}

/**
 * The ask, built from the whole ticket.
 *
 * The first version of this carried the title and nothing else, so the constraints, the dependency
 * edges and the out-of-scope list had to be typed in by hand — by the person with the least context
 * about the code, which is the one place it should never come from (#81). The body is verbatim.
 */
export type Row = { ok: boolean; fatal: boolean; label: string; detail: string };

/**
 * Which template a ticket wants, from the ticket. A ```claims block is the whole distinction: a room that
 * checks records is a different room from one that only checks prose, and asking a human to pass the flag is
 * asking them to remember a rule the body already states.
 */
export function pickTemplate(body: string): "ticket-resolver1-claims" | "ticket-resolver1" {
  return /```claims\n/.test(body) ? "ticket-resolver1-claims" : "ticket-resolver1";
}

/** The path a template name resolves to, from this file's own location: no cwd assumptions. */
export function templatePath(name: string): string {
  return resolve(import.meta.dir, "..", "rooms", "templates", name, "template.yaml");
}

/**
 * The claims binary, resolved the way this repo resolves every external tool: on `PATH`, then the repo's own
 * `AH_`-prefixed override. No machine-specific absolute path in the source, and `null` means "say so", never
 * "carry on quietly".
 */
export function resolveClaimCheck(env: NodeJS.ProcessEnv): string | null {
  const override = env.AH_CLAIM_CHECK;
  if (override !== undefined && override !== "") return existsSync(override) ? override : null;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, "claim-check");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The claims preflight, as rows. Kept pure and separate from the shells it needs: `no block`, a failing
 * `before` phase and an advisory `UNVERIFIED` are three different answers and only two of them block a room.
 */
export function claimsRows(input: { hasBlock: boolean; beforeExit: number | null; unverified: number | null; skipped?: boolean }): Row[] {
  if (input.skipped) return [{ ok: true, fatal: false, label: "claims", detail: "skipped by --no-claims" }];
  if (!input.hasBlock) {
    return [{ ok: false, fatal: true, label: "claims block", detail: "ticket has no claims block; write one or pass --no-claims" }];
  }
  const rows: Row[] = [{ ok: true, fatal: false, label: "claims block", detail: "present" }];
  rows.push({
    ok: input.beforeExit === 0,
    fatal: true,
    label: "claims before phase",
    detail: input.beforeExit === 0 ? "every claim holds" : `run --phase before exited ${input.beforeExit}`,
  });
  rows.push({
    ok: input.unverified === 0,
    fatal: false,
    label: "claims unverified",
    detail: input.unverified === 0 ? "none" : `${input.unverified} criterion(s) assert a repo fact no row covers`,
  });
  return rows;
}

export function askedFrom(ticket: Ticket): { task: string; definitionOfDone: string; source: "criteria" | "body" } {
  const criteria = criteriaOf(ticket.body);
  const task = [
    `Resolve ticket #${ticket.number} in this repo: "${ticket.title}".`,
    "",
    "The ticket body follows verbatim. It is the spec: its acceptance criteria say what done means,",
    "and its dependencies, constraints and out-of-scope sections bind this run.",
    "",
    `Run \`gh issue view ${ticket.number}\` if you want it fresh, but do not work from a summary.`,
    "",
    ticket.body.trim(),
  ].join("\n");
  return { task, definitionOfDone: criteria.text, source: criteria.source };
}

/**
 * Tickets the body says must land first, read from its Dependencies section.
 *
 * GitHub's native links are the reliable signal, but they are a thing somebody has to remember to
 * add: #54 carries both, and a ticket that only says "must not merge before #64" in prose is exactly
 * the one a native-only gate lets through (#82). Only the Dependencies section counts — a mention in
 * "References" or a `Blocks #n` line names work that comes *after* this ticket, not before it.
 */
export function dependencyReferences(body: string): number[] {
  const heading = /^#{1,6}\s*dependencies\b.*$/im.exec(body);
  if (heading === null) return [];
  const level = (heading[0].match(/^#+/) ?? ["#"])[0].length;
  const section: string[] = [];
  for (const line of body.slice(heading.index + heading[0].length).split("\n")) {
    const next = /^(#{1,6})\s/.exec(line);
    if (next !== null && next[1]!.length <= level) break;
    section.push(line);
  }
  // A line counts only when it opens by naming what this ticket waits for. "Blocks #54" and
  // "#54 and #55 must not merge before this" are the other direction, and reading them as blockers
  // refused the one ticket that was runnable.
  const WAITING = /^\s*[-*]?\s*[*_]{0,2}(needs?|needed|blocked by|requires?|depends on)\b/i;
  const found = new Set<number>();
  for (const line of section) {
    if (!WAITING.test(line)) continue;
    for (const m of line.matchAll(/#(\d+)/g)) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}

/** A blocker that is still open, named. Null when the ticket may be dispatched. */
export function blockerReason(blockers: readonly { number: number; state: string }[]): string | null {
  const open = blockers.filter((b) => b.state.toLowerCase() !== "closed");
  if (open.length === 0) return null;
  return `blocked by ${open.map((b) => `#${b.number} (${b.state})`).join(", ")}`;
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
  const rows: Row[] = [];
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
    const issue = Number(args.get("issue"));
    if (auth && Number.isFinite(issue)) {
      try {
        const body = sh("gh", ["issue", "view", String(issue), "--json", "body", "--jq", ".body"], repo);
        const blocked = blockerReason(blockersOf(repo, issue, body));
        // The override the issue command already honours has to reach the gate that runs first, or the flag is
        // dead: `check` runs on every launch, so a fatal row here refuses before `--ignore-blockers` is read.
        const ignored = args.get("ignore-blockers") !== undefined;
        rows.push({
          ok: blocked === null || ignored,
          fatal: true,
          label: `#${issue} unblocked`,
          detail: blocked === null ? "" : ignored ? `${blocked} (ignored by --ignore-blockers)` : blocked,
        });
      } catch (e) {
        rows.push({ ok: false, fatal: true, label: `#${issue} unblocked`, detail: (e as Error).message });
      }
    }
  }
  for (const row of rows) {
    process.stderr.write(`launch: ${row.ok ? "ok  " : row.fatal ? "FAIL" : "warn"} ${row.label}${row.detail === "" ? "" : ` — ${row.detail}`}\n`);
  }
  return rows.some((r) => !r.ok && r.fatal) ? 1 : 0;
}

/**
 * Native GitHub dependencies of an issue: the ones that must close first. Empty when none.
 *
 * Throws rather than returning empty on a failed read: "no blockers" and "could not ask" must not
 * look the same, or the gate that exists to stop a blocked ticket lets it through when the API blips.
 */
function repoSlug(repo: string): string {
  return sh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], repo);
}

function issueState(repo: string, issue: number): string {
  return sh("gh", ["api", `repos/${repoSlug(repo)}/issues/${issue}`, "--jq", ".state"]).trim();
}

/**
 * Every reason this ticket must wait: GitHub's native links, plus the ones its body states in prose.
 *
 * Both are read because either can be missing. #54 has both; a ticket that only says "must not merge
 * before #64" is the one a native-only gate waves through (#82).
 */
function blockersOf(repo: string, issue: number, body: string): Array<{ number: number; state: string }> {
  const merged = new Map<number, string>();
  for (const b of blockedBy(repo, issue)) merged.set(b.number, b.state);
  for (const n of dependencyReferences(body)) {
    if (n === issue || merged.has(n)) continue;
    merged.set(n, issueState(repo, n));
  }
  return [...merged].map(([number, state]) => ({ number, state }));
}

function blockedBy(repo: string, issue: number): Array<{ number: number; state: string }> {
  const slug = repoSlug(repo);
  const raw = trySh("gh", ["api", `repos/${slug}/issues/${issue}/dependencies/blocked_by`]);
  if (raw === null) throw new Error(`could not read the dependencies of #${issue}`);
  if (raw.trim() === "") return [];
  const parsed = JSON.parse(raw) as Array<{ number?: unknown; state?: unknown }>;
  return parsed
    .filter((i) => typeof i.number === "number" && typeof i.state === "string")
    .map((i) => ({ number: i.number as number, state: i.state as string }));
}

function cmdIssue(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const issue = args.get("issue")!;
  const out = args.get("out")!;
  const requested = args.get("template");
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
  // A ticket can be triaged and still be unsafe to dispatch: its own body asks for another ticket
  // first, and GitHub records that as a native dependency (#81).
  let blocked: string | null;
  try {
    blocked = blockerReason(blockersOf(repo, json.number, json.body));
  } catch (e) {
    process.stderr.write(`launch: refusing — ${(e as Error).message}; dispatch needs to know its blockers\n`);
    return 1;
  }
  if (blocked !== null && args.get("ignore-blockers") === undefined) {
    process.stderr.write(`launch: refusing — #${json.number} is ${blocked}. Re-run with --ignore-blockers to override.\n`);
    return 1;
  }
  const asked = askedFrom({ ...json, labels });
  // The template is a consequence of the ticket, not a question for a human: the body says whether the room
  // will check records. `run.yaml` records the choice, because the resolved config deliberately drops it.
  const template = requested ?? templatePath(pickTemplate(json.body));
  if (asked.source === "body") {
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
      block("task", asked.task) +
      block("definition_of_done", asked.definitionOfDone) +
      `# Generated from #${json.number}: the whole body, and the bar taken from its ${asked.source === "criteria" ? "acceptance criteria" : "body"}.\n` +
      `# Nothing here needs editing. Delete this file to regenerate it from the ticket.\n`,
  );
  process.stderr.write(`launch: wrote the ask at ${out} (whole body; bar from its ${asked.source})\n`);
  return 0;
}

/**
 * The claims preflight, run inside the worktree. Records resolve against the working directory
 * (`claim-check`'s `root = process.cwd()`), so this must not run in the main checkout: that one may be dirty
 * and the room would then disagree for reasons the room never sees.
 */
function cmdClaims(argv: string[]): number {
  const args = argsOf(argv);
  const repo = args.get("repo")!;
  const issue = args.get("issue")!;
  const worktree = args.get("worktree")!;
  const skipped = args.get("no-claims") !== undefined;

  if (!skipped) {
    const cc = resolveClaimCheck(process.env);
    if (cc === null) {
      process.stderr.write("launch: FAIL claims binary — claim-check is not on PATH and $AH_CLAIM_CHECK is unset\n");
      return 1;
    }
    const body = sh("gh", ["issue", "view", issue, "--json", "body", "--jq", ".body"], repo);
    const hasBlock = /```claims\n/.test(body);
    let beforeExit: number | null = null;
    let unverified: number | null = null;
    if (hasBlock) {
      const slug = repoSlug(repo);
      try {
        execFileSync(cc, ["run", "--phase", "before", "--from-issue", issue, "--repo", slug], { cwd: worktree, stdio: "pipe" });
        beforeExit = 0;
      } catch (e) {
        beforeExit = (e as { status?: number }).status ?? 1;
        process.stderr.write(`launch: claims run disagreed — ${cc} run --phase before --from-issue ${issue} --repo ${slug}\n`);
      }
      try {
        const out = execFileSync(cc, ["lint", "--json", "--from-issue", issue, "--repo", slug], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        unverified = (JSON.parse(out) as { unverified?: number }).unverified ?? null;
      } catch {
        unverified = null;
      }
    }
    for (const row of claimsRows({ hasBlock, beforeExit, unverified })) {
      process.stderr.write(`launch: ${row.ok ? "ok  " : row.fatal ? "FAIL" : "warn"} ${row.label}${row.detail === "" ? "" : ` — ${row.detail}`}\n`);
    }
    return hasBlock && beforeExit !== 0 ? 1 : 0;
  }

  for (const row of claimsRows({ hasBlock: false, beforeExit: null, unverified: null, skipped: true })) {
    process.stderr.write(`launch: ok   ${row.label} — ${row.detail}\n`);
  }
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
            : command === "claims"
              ? cmdClaims(rest)
              : (process.stderr.write("usage: bun src/launch.ts <worktree|warm|check|issue|claims> --repo …\n"), 2);
  process.exit(exit);
}
