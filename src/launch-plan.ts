/**
 * The launch as a value: an ordered list of steps, and the executor that performs them.
 *
 * `rooms/launch.sh` used to hold this sequence — it read the `template:` line back out of the YAML the
 * `issue` command had just written, decoded the claims preflight's exit code with a comment as its only
 * spec, carried "a prep pass already ran" in the environment across a self-exec, and removed a refused
 * launch's collateral in a block no test executed (#78). The decisions were in `src/launch.ts` and tested;
 * the order they run in was not.
 *
 * Two calls, because the tail cannot be known before the gate runs: `planLaunch(launch, null)` is
 * everything up to the claims preflight, and the second call is the tail that exit code chooses. A single
 * plan that guessed both outcomes would be fiction.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  liveRoom,
  PREP_TEMPLATE,
  prepFirst,
  readRoomState,
  templateFromRunFile,
  templatePath,
  type WorktreeAction,
} from "./launch";
import { defaultRequested, nextRunName } from "./run-slug";

// ---------------------------------------------------------------- the launch

export interface LaunchFlags {
  repo: string;
  issue: string | null;
  /** `--slug`: the name a human asked for, before the ordinal is added. */
  requested: string | null;
  /** `--template`, as a template *name*: a human's answer to "which room". */
  template: string | null;
  /** `--run`: an ask file a human wrote, instead of the one the ticket would generate. */
  runFile: string | null;
  branch: boolean;
  dryRun: boolean;
  checkOnly: boolean;
  warm: boolean;
  noClaims: boolean;
  anyState: boolean;
  ignoreBlockers: boolean;
  /** `--prep-ran`: this invocation is the second half of a launch whose prep pass is spent. */
  prepRan: boolean;
  /** `--reuse-live`: launch into a run directory whose room has not finished, on purpose. */
  reuseLive: boolean;
}

export interface Launch {
  flags: LaunchFlags;
  /** The run directory's name, ordinal included. */
  slug: string;
  runFile: string;
  runDir: string;
  worktree: string;
  /** The resolved template path: `""` until the ask names one. */
  template: string;
  /** The template's directory name, which is what the `template=` row prints. */
  name: string;
}

export interface LaunchFacts {
  worktreeAction: WorktreeAction;
  /** The claims preflight's own answer: `0` green, `1` a record disagrees, `2` it could not run. */
  claimsStatus: number;
  /** This launch created the worktree, so `run/<slug>` is its own to delete. */
  created: boolean;
  /** `--branch`: the run has a branch instead of a detached worktree. */
  branch: boolean;
  prepRan: boolean;
  templateRequested: boolean;
  /** The resolved config `room-run.ts prepare` wrote. */
  config: string;
}

export type Step =
  | { kind: "room" }
  | { kind: "check" }
  | { kind: "ask" }
  | { kind: "prepare" }
  | { kind: "worktree" }
  | { kind: "claims" }
  | { kind: "warm" }
  | { kind: "summary" }
  | { kind: "dryRun" }
  | { kind: "boot" }
  | { kind: "cleanup"; branch: string | null }
  | { kind: "hardStop" }
  | { kind: "stop" }
  | { kind: "dryRunPrep"; template: string }
  | { kind: "prep"; args: string[] }
  | { kind: "reAsk"; args: string[] };

const carried = (flags: LaunchFlags): string[] => [
  ...(flags.anyState ? ["--any-state"] : []),
  ...(flags.ignoreBlockers ? ["--ignore-blockers"] : []),
];

/**
 * The steps for a launch.
 *
 * `facts === null` is everything up to the claims preflight. With the facts, the tail is the one the
 * observed exit code chooses: the success chain, or cleanup followed by the decision `prepFirst` makes.
 *
 * `prep` and `reAsk` name a nested invocation of this same entry point rather than inlining the work: a
 * prep room is an ordinary room run, with its own run directory, and the re-ask must re-pick the template
 * from the repaired ticket body. The plan names them; the executor runs them.
 */
export function planLaunch(launch: Launch, facts: LaunchFacts | null): Step[] {
  if (facts === null) {
    return [
      // First, because `ask` creates the directory and `prepare` rewrites the config inside it: a room that
      // has not finished owns that directory, and nothing is written into it before the verdict (#80).
      ...(launch.flags.reuseLive ? [] : [{ kind: "room" } as Step]),
      { kind: "check" },
      { kind: "ask" },
      { kind: "prepare" },
      { kind: "worktree" },
      ...(launch.flags.issue === null ? [] : [{ kind: "claims" } as Step]),
    ];
  }
  // A refused worktree removed nothing and said why; the launch ends where it stands.
  if (facts.worktreeAction === "refuse") return [];
  if (facts.claimsStatus === 0) {
    return [
      ...(launch.flags.warm ? [{ kind: "warm" } as Step] : []),
      { kind: "summary" },
      { kind: "dryRun" },
      ...(launch.flags.dryRun ? [] : [{ kind: "boot" } as Step]),
    ];
  }
  // A refused launch must not leave what it just created. The branch is this launch's to delete only
  // when it created the worktree on it: a reused worktree's branch belongs to the run that made it.
  const chain: Step[] = [{ kind: "cleanup", branch: facts.created && facts.branch ? `run/${launch.slug}` : null }];
  // 2 is the preflight's own exit for a missing tool: no room repairs that, so the launch stops here.
  if (facts.claimsStatus !== 1) return [...chain, { kind: "hardStop" }];

  const decision = prepFirst({
    refused: true,
    prepRan: facts.prepRan,
    templateRequested: facts.templateRequested,
  });
  if (decision === "stop") return [...chain, { kind: "stop" }];
  // `prepFirst` answers with the decision; the room that decision names is `PREP_TEMPLATE` (the shell asked
  // `cmdPrep` the same question, which did this mapping).
  const chosen = decision === "prep" ? PREP_TEMPLATE : decision;
  if (launch.flags.dryRun) return [...chain, { kind: "dryRunPrep", template: chosen }];

  const repo = launch.flags.repo;
  const issue = launch.flags.issue ?? "";
  return [
    ...chain,
    {
      // Its own run name: the resolver's `ticket-<n>` directory was just removed, and handing prep that
      // name would put both phases in one directory (a run name that exists is reused).
      kind: "prep",
      args: [
        "--repo", repo, "--issue", issue, "--template", chosen, "--no-claims", "--prep-ran",
        "--slug", `ticket-${issue}-prep`, ...carried(launch.flags),
      ],
    },
    {
      // Ask the original question again: the ticket body changed, so the template is picked from the new
      // one. `--branch` is the human's answer to "where does the fix land", so it survives the re-ask.
      kind: "reAsk",
      args: [
        "--repo", repo, "--issue", issue, ...carried(launch.flags),
        ...(launch.flags.warm ? [] : ["--no-warm"]),
        ...(launch.flags.branch ? ["--branch"] : []),
        "--prep-ran",
      ],
    },
  ];
}

/** The launch's paths, from the flags. Async only because the run name is: nothing is created here. */
export async function launchOf(flags: LaunchFlags): Promise<Launch> {
  const repo = resolve(flags.repo);
  const requested =
    flags.requested !== null && flags.requested !== ""
      ? flags.requested
      : defaultRequested(flags.issue === null ? undefined : Number(flags.issue), new Date());
  const slug = await nextRunName(join(repo, "_run"), requested);
  const template = flags.template === null ? "" : templatePath(flags.template);
  return {
    flags: { ...flags, repo },
    slug,
    runFile: flags.runFile ?? join(repo, "_run", slug, "run.yaml"),
    runDir: join(repo, "_run", slug),
    worktree: join(dirname(repo), `${basename(repo)}-${slug}`),
    template,
    name: template === "" ? "" : basename(dirname(template)),
  };
}

// ---------------------------------------------------------------- the executor

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Every effect outside this file is one of these three, so a test can hold the whole sequence. */
export type Exec = (cmd: string, args: string[], cwd: string) => ExecResult;

export interface LaunchDeps {
  exec: Exec;
  /** The room itself: it inherits stdio, and the launcher exits with its status. */
  boot: (config: string, worktree: string) => number;
  /** Every line this launcher prints, on stderr in production. */
  write: (line: string) => void;
}

const SELF = join(import.meta.dir, "launch-plan.ts");
const LAUNCH = join(import.meta.dir, "launch.ts");
const ROOM_RUN = join(import.meta.dir, "room-run.ts");
const INDEX = join(import.meta.dir, "index.ts");

const defaultExec: Exec = (cmd, args, cwd) => {
  const p = Bun.spawnSync({ cmd: [cmd, ...args], cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { status: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
};

export const defaultDeps = (): LaunchDeps => ({
  exec: defaultExec,
  boot: (config, worktree) => {
    const env = { ...process.env, HERDR_ENV: process.env.HERDR_ENV ?? "1" };
    if (env.HERDR_ENV === "1" && Bun.which("herdr") === null) {
      process.stderr.write("launch: herdr not on PATH; running headless\n");
      env.HERDR_ENV = "0";
    }
    const p = Bun.spawnSync({ cmd: ["bun", INDEX, config], cwd: worktree, env, stdio: ["inherit", "inherit", "inherit"] });
    return p.exitCode ?? 1;
  },
  write: (line) => process.stderr.write(`${line}\n`),
});

/** Perform a plan. Returns the exit status the launcher exits with. */
export function performLaunch(launch: Launch, deps: LaunchDeps): number {
  const facts: Partial<LaunchFacts> = {
    prepRan: launch.flags.prepRan,
    branch: launch.flags.branch,
    templateRequested: launch.flags.template !== null,
  };

  const forward = (result: ExecResult): void => {
    for (const line of `${result.stderr}${result.stdout}`.split("\n").filter((l) => l !== "")) deps.write(line);
  };

  const perform = (step: Step): number | null => {
    switch (step.kind) {
      case "room": {
        const verdict = liveRoom(readRoomState(launch.runDir));
        if (!verdict.live) return null;
        deps.write(
          `launch: refused — ${launch.runDir} belongs to a room that has not finished (${verdict.detail}); pass --reuse-live to launch into it anyway`,
        );
        return 1;
      }
      case "check": {
        const args = ["check", "--repo", launch.flags.repo, "--slug", launch.slug];
        if (launch.flags.issue !== null) args.push("--issue", launch.flags.issue);
        if (launch.flags.ignoreBlockers) args.push("--ignore-blockers");
        const result = deps.exec("bun", [LAUNCH, ...args], launch.flags.repo);
        forward(result);
        if (result.status !== 0) {
          deps.write("launch: stopping before anything was created");
          return 1;
        }
        if (launch.flags.checkOnly) {
          deps.write("launch: check only, nothing created");
          return 0;
        }
        return null;
      }
      case "ask": {
        if (launch.flags.issue !== null && launch.flags.runFile === null) {
          if (existsSync(launch.runFile)) {
            // An edited ask is the human's wording; regenerating it would silently drop the constraints.
            deps.write(
              `launch: reusing the ask at ${launch.runFile} — delete it to regenerate it from #${launch.flags.issue}`,
            );
          } else {
            const args = ["issue", "--repo", launch.flags.repo, "--issue", launch.flags.issue, "--out", launch.runFile];
            if (launch.template !== "") args.push("--template", launch.template);
            if (launch.flags.anyState) args.push("--any-state");
            if (launch.flags.ignoreBlockers) args.push("--ignore-blockers");
            const result = deps.exec("bun", [LAUNCH, ...args], launch.flags.repo);
            forward(result);
            if (result.status !== 0) return 1;
          }
          // The template is a consequence of the ticket, so the ask is the only record of which one it
          // was: the resolved config drops the reference so a past run cannot change its mind.
          const recorded = templateFromRunFile(readFileSync(launch.runFile, "utf8"));
          if (recorded !== null) {
            launch.template = recorded;
            launch.name = basename(dirname(recorded));
          }
        } else if (launch.flags.runFile === null) {
          mkdirSync(launch.runDir, { recursive: true });
          if (!existsSync(launch.runFile)) {
            writeFileSync(launch.runFile, skeleton(launch.template));
            deps.write(`launch: wrote a skeleton ask at ${launch.runFile} — edit it, then run this again`);
            return 1;
          }
        }
        return null;
      }
      case "prepare": {
        const result = deps.exec("bun", [ROOM_RUN, "prepare", launch.runFile, "--out", launch.runDir], launch.flags.repo);
        // The config path is this step's answer, not a row: the shell captured it, so printing it would add
        // a line the launcher never printed.
        for (const line of result.stderr.split("\n").filter((l) => l !== "")) deps.write(line);
        const config = result.stdout.trim();
        if (result.status !== 0 || !existsSync(config)) {
          deps.write("launch: prepare did not produce a resolved config");
          return 1;
        }
        facts.config = config;
        return null;
      }
      case "worktree": {
        const result = deps.exec("bun", [LAUNCH, "worktree", "--repo", launch.flags.repo, "--slug", launch.slug], launch.flags.repo);
        // The action is the answer; its reason is a row on stderr, which the shell printed.
        for (const line of result.stderr.split("\n").filter((l) => l !== "")) deps.write(line);
        if (result.status !== 0) return result.status;
        const action = result.stdout.trim() as WorktreeAction;
        facts.worktreeAction = action;
        facts.created = action === "create" || action === "replace";
        if (action === "replace") {
          // The old worktree is behind, clean and its branch is merged: it is this run's to redo.
          forward(deps.exec("git", ["-C", launch.flags.repo, "worktree", "remove", "--force", launch.worktree], launch.flags.repo));
          deps.exec("git", ["-C", launch.flags.repo, "worktree", "prune"], launch.flags.repo);
          const has = deps.exec("git", ["-C", launch.flags.repo, "branch", "--list", `run/${launch.slug}`], launch.flags.repo);
          if (has.stdout.trim() !== "") {
            forward(deps.exec("git", ["-C", launch.flags.repo, "branch", "-D", `run/${launch.slug}`], launch.flags.repo));
          }
          addWorktree();
        } else if (action === "create") {
          addWorktree();
        } else if (action !== "reuse") {
          deps.write(`launch: worktree action '${action}' is not something this script does`);
          return 1;
        }
        return null;
      }
      case "claims": {
        const args = ["claims", "--repo", launch.flags.repo, "--issue", launch.flags.issue ?? "", "--worktree", launch.worktree];
        if (launch.flags.noClaims) args.push("--no-claims");
        const result = deps.exec("bun", [LAUNCH, ...args], launch.flags.repo);
        forward(result);
        facts.claimsStatus = result.status;
        return null;
      }
      case "cleanup": {
        deps.write(`launch: claims preflight refused — removing ${launch.worktree} and ${launch.runDir}`);
        deps.exec("git", ["-C", launch.flags.repo, "worktree", "remove", "--force", launch.worktree], launch.flags.repo);
        deps.exec("git", ["-C", launch.flags.repo, "worktree", "prune"], launch.flags.repo);
        rmSync(launch.runDir, { recursive: true, force: true });
        // The worktree is gone but its branch is not: `worktree add -b` created it, and a branch left behind
        // makes the next attempt of the same slug die at `add -b`. Only a branch this launch created is
        // removed, which is what `step.branch` is null for.
        if (step.branch !== null) {
          deps.exec("git", ["-C", launch.flags.repo, "branch", "-D", step.branch], launch.flags.repo);
        }
        return null;
      }
      case "hardStop": {
        deps.write("launch: stopping — the claims preflight could not run; install claim-check or pass --no-claims");
        return 1;
      }
      case "stop": {
        deps.write("launch: stopping — the claims gate refused and prep cannot help here");
        return 1;
      }
      case "dryRunPrep": {
        deps.write(`launch: dry run — would boot ${step.template} first, then re-run this launch`);
        return 0;
      }
      case "prep": {
        const result = deps.exec("bun", [SELF, ...step.args], launch.flags.repo);
        forward(result);
        return result.status === 0 ? null : result.status;
      }
      case "reAsk": {
        // The second half of the launch replaces this process in production: its status is ours.
        const result = deps.exec("bun", [SELF, ...step.args], launch.flags.repo);
        forward(result);
        return result.status;
      }
      case "warm": {
        const result = deps.exec("bun", [LAUNCH, "warm", "--repo", launch.flags.repo, "--worktree", launch.worktree], launch.flags.repo);
        forward(result);
        return result.status === 0 ? null : result.status;
      }
      case "summary": {
        deps.write(
          `launch: template=${launch.name} run=${launch.runDir} worktree=${launch.worktree} branch=${
            launch.flags.branch ? `run/${launch.slug}` : "detached"
          }`,
        );
        return null;
      }
      case "dryRun": {
        if (launch.flags.dryRun) {
          deps.write(`launch: dry run, not booting. Resolved config: ${facts.config ?? ""}`);
          return 0;
        }
        return null;
      }
      case "boot": {
        if (facts.config === undefined) {
          deps.write("launch: no resolved config to boot");
          return 1;
        }
        return deps.boot(facts.config, launch.worktree);
      }
    }
  };

  const addWorktree = (): void => {
    const args = launch.flags.branch
      ? ["-C", launch.flags.repo, "worktree", "add", "-b", `run/${launch.slug}`, launch.worktree]
      : // No branch: this run produces nothing to check in, so nothing should be mergeable.
        ["-C", launch.flags.repo, "worktree", "add", "--detach", launch.worktree];
    forward(deps.exec("git", args, launch.flags.repo));
  };

  for (const step of planLaunch(launch, null)) {
    const stopped = perform(step);
    if (stopped !== null) return stopped;
  }
  for (const step of planLaunch(launch, facts as LaunchFacts)) {
    const stopped = perform(step);
    if (stopped !== null) return stopped;
  }
  return 0;
}

const skeleton = (template: string): string =>
  `template: ${template}\n` +
  "task: |\n" +
  "  Describe the ask for this run.\n" +
  "definition_of_done: |\n" +
  "  Describe what makes it done.\n";

// ---------------------------------------------------------------- the flags

export class FlagError extends Error {}

/** `--help` is not a bad flag: it prints the usage block and exits 2, as the shell's `usage` did. */
export class HelpRequested extends Error {}

/** Parse the launcher's own flags. `--help` and an unknown flag are held apart from a missing value. */
export function parseLaunchFlags(argv: string[]): LaunchFlags {
  const flags: LaunchFlags = {
    repo: process.cwd(),
    issue: null,
    requested: null,
    template: null,
    runFile: null,
    branch: false,
    dryRun: false,
    checkOnly: false,
    warm: true,
    noClaims: false,
    anyState: false,
    ignoreBlockers: false,
    prepRan: false,
    reuseLive: false,
  };
  const value = (i: number): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new FlagError(`launch: ${argv[i]} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--template": flags.template = value(i); i += 1; break;
      case "--repo": flags.repo = value(i); i += 1; break;
      case "--slug": flags.requested = value(i); i += 1; break;
      case "--run": flags.runFile = value(i); i += 1; break;
      case "--issue": flags.issue = value(i); i += 1; break;
      case "--any-state": flags.anyState = true; break;
      case "--ignore-blockers": flags.ignoreBlockers = true; break;
      case "--no-claims": flags.noClaims = true; break;
      case "--branch": flags.branch = true; break;
      case "--dry-run": flags.dryRun = true; break;
      case "--check": flags.checkOnly = true; break;
      case "--no-warm": flags.warm = false; break;
      case "--prep-ran": flags.prepRan = true; break;
      case "--reuse-live": flags.reuseLive = true; break;
      case "-h":
      case "--help": throw new HelpRequested();
      default: throw new FlagError(`launch: unknown argument ${argv[i]}`);
    }
  }
  return flags;
}

const USAGE = `launch: --repo <path> [--issue <n> | --run <run.yaml>] [--template <name>] [--slug <slug>]
                [--branch] [--check] [--dry-run] [--no-warm] [--any-state] [--ignore-blockers]
                [--no-claims] [--prep-ran] [--reuse-live]`;

/** `--help`: the usage block plus the templates the repo ships, the way the shell's `usage` did. */
function usage(): string {
  const dir = join(import.meta.dir, "..", "rooms", "templates");
  const names = existsSync(dir) ? readdirSync(dir).sort().join(" ") : "";
  return `${USAGE}\n${names === "" ? "" : `templates: ${names}\n`}`;
}

if (import.meta.path === Bun.main) {
  let flags: LaunchFlags;
  try {
    flags = parseLaunchFlags(process.argv.slice(2));
  } catch (error: unknown) {
    if (!(error instanceof HelpRequested)) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(usage());
    process.exit(2);
  }
  if (flags.template !== null && !existsSync(templatePath(flags.template))) {
    process.stderr.write(`launch: no template at ${templatePath(flags.template)}\n`);
    process.exit(1);
  }
  const launch = await launchOf(flags);
  process.exit(performLaunch(launch, defaultDeps()));
}
