/**
 * Run directory names start with an ordinal, so `ls _run/` shows the order runs were
 * created in. The number is the highest existing one plus one — never the first gap, since
 * a gap means a run was deleted and reusing its number would put a newer run in an older
 * slot. A name handed in already carrying a number is reused, so restarting a run does not
 * create a second directory.
 */
import { readdir } from "node:fs/promises";

const ORDINAL = /^(\d{3,})-(.+)$/;

/** The name to use for a run, given the names already present in the run root. */
export function formatRunName(existing: readonly string[], requested: string): string {
  const numbers = existing
    .map((name) => ORDINAL.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  const highest = numbers.length === 0 ? 0 : Math.max(...numbers);

  // A bare name that an existing run already carries is a rerun of that run: reuse its
  // directory instead of starting a second one beside it.
  // Lowest ordinal wins: `readdir` order is not creation order, so picking the first match
  // by directory order can hand back the most recent run instead of the original.
  const sameName = existing
    .filter((name) => ORDINAL.exec(name)?.[2] === requested)
    .sort()[0];
  if (sameName !== undefined) return sameName;

  // Already numbered: keep it when it is one of ours, otherwise strip it and renumber.
  const prefix = ORDINAL.exec(requested);
  if (prefix !== null) {
    const number = Number(prefix[1]);
    if (number > 0 && number <= highest) return `${String(number).padStart(3, "0")}-${prefix[2]}`;
    return `${String(highest + 1).padStart(3, "0")}-${prefix[2]}`;
  }

  return `${String(highest + 1).padStart(3, "0")}-${requested}`;
}

/**
 * The name a run gets when nobody typed one: `ticket-<n>` for a run against a ticket, because `ls _run/`
 * should say which ticket a directory belongs to, and a timestamp only when there is no ticket to name.
 */
export function defaultRequested(issue: number | undefined, now: Date): string {
  if (issue !== undefined && Number.isFinite(issue)) return `ticket-${issue}`;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Read the run root (absent means "no runs yet") and return the name to use. */
export async function nextRunName(runRoot: string, requested: string): Promise<string> {
  let existing: string[];
  try {
    existing = await readdir(runRoot);
  } catch {
    existing = [];
  }
  return formatRunName(existing, requested);
}

if (import.meta.path === Bun.main) {
  const argv = process.argv.slice(2);
  const issueAt = argv.indexOf("--issue");
  const issue = issueAt < 0 ? undefined : Number(argv[issueAt + 1]);
  const positional = argv.filter((_, i) => issueAt < 0 || i < issueAt || i > issueAt + 1);
  const [command, runRoot, requested] = positional;
  if (command !== "next" || !runRoot) {
    console.error("usage: bun src/run-slug.ts next <run-root> [<requested-name>] [--issue N]");
    process.exit(2);
  }
  // One line on stdout: the directory name the launcher should use. An empty name means `--issue` or nothing.
  const asked = requested !== undefined && requested !== "" ? requested : defaultRequested(issue, new Date());
  console.log(await nextRunName(runRoot, asked));
}
