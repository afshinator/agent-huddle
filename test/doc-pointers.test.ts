// Every pointer and every test-title claim the docs make, checked against the tree.
//
// This is the probe that used to live in `probes/doc-pointers.ts` and ran nowhere: `probes/` is
// gitignored, so the docs could drift and CI would stay green. The tables below are the claims;
// nothing here counts anything, so a doc edit that moves a line fails here rather than later.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";

const repo = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(repo + p, "utf8");

describe("docs point at things that exist", () => {
  test("every file:line reference in decisions.md and STATUS.md resolves", () => {
    // `finance-hub:`-prefixed pointers are cross-repo and cannot be checked from this tree.
    const pointer = /\b(?:(finance-hub):)?((?:src|rooms|test|docs)\/[\w./-]+\.(?:ts|sh|md)):(\d+)(?:-(\d+))?\b/g;
    const bad: string[] = [];
    for (const doc of ["docs/decisions.md", "docs/STATUS.md"]) {
      for (const [, otherRepo, file, from, to] of read(doc).matchAll(pointer)) {
        if (otherRepo !== undefined) continue;
        if (!existsSync(repo + file)) {
          bad.push(`${doc}: ${file} does not exist`);
          continue;
        }
        const lines = read(file).split("\n");
        const last = Number(to ?? from);
        if (lines.length < last) bad.push(`${doc}: ${file}:${last} is past the end (${lines.length} lines)`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("every test title a STATUS row cites exists in the file it names", () => {
    const rows: Array<[string, string, string]> = [
      ["the preflight's verdict is fatal", "test/launch.test.ts", "no block is fatal"],
      ["the preflight's verdict is fatal", "test/launch.test.ts", "a clean block is green"],
      ["the template comes from the body", "test/launch.test.ts", "a body carrying a claims block wants the claims room"],
      ["the template comes from the body", "test/launch.test.ts", "a body without one wants the base room"],
      ["an issue names its run", "test/run-slug.test.ts", "a ticket names the run"],
      ["reuse / ordinal", "test/run-slug.test.ts", "a requested name that already carries a number is reused"],
      ["reuse / ordinal", "test/run-slug.test.ts", "a bare name an existing run carries is a rerun"],
      ["prep once", "test/launch.test.ts", "a refusal nobody has repaired yet runs the prep room once"],
      ["prep once", "test/launch.test.ts", "still refused after that pass stops instead of running prep again"],
      ["prep once", "test/launch.test.ts", "an explicit --template is the human's decision"],
      ["prep rules + exemption", "test/template-prompts.test.ts", "the prep room carries all nine repair rules"],
      ["prep rules + exemption", "test/template-prompts.test.ts", "is either gating or exempt, with a reason"],
    ];
    const bad = rows
      .filter(([, file, title]) => !existsSync(repo + file) || !read(file).includes(title))
      .map(([claim, file, title]) => `${claim}: ${file} has no "${title}"`);
    expect(bad).toEqual([]);
  });

  test("the launcher behaviour the docs describe is in the code", () => {
    const facts: Array<[string, string, string]> = [
      ["issue names the run", "src/run-slug.ts", "return `ticket-${issue}`"],
      ["reuse returns the seen name", "src/run-slug.ts", "if (sameName !== undefined) return sameName"],
      ["refusal removes the run dir", "rooms/launch.sh", 'rm -rf "$RUN_DIR"'],
      ["refusal removes the worktree", "rooms/launch.sh", 'worktree remove --force "$WORKTREE"'],
      ["an existing ask is reused", "rooms/launch.sh", "reusing the ask at $RUN_FILE"],
      ["template read from run.yaml", "rooms/launch.sh", "sed -n 's/^template: //p'"],
      ["no-claims is passed to the gate", "rooms/launch.sh", "CLAIMS_ARGS+=(--no-claims)"],
      ["prep run name", "rooms/launch.sh", '--slug "ticket-$ISSUE-prep"'],
      ["prep child runs before the re-ask", "rooms/launch.sh", 'AH_PREP_RAN=1 "$0"'],
      ["the re-ask is an exec", "rooms/launch.sh", 'AH_PREP_RAN=1 exec "$0"'],
      ["explicit template wins", "src/launch.ts", "requested ?? templatePath(pickTemplate"],
      ["missing binary exits 2", "src/launch.ts", "return 2;"],
      ["disagreement exits 1", "src/launch.ts", "claimsRefused(rows) ? 1 : 0"],
      ["prepFirst decides", "src/launch.ts", "export function prepFirst"],
    ];
    const bad = facts
      .filter(([, file, needle]) => !existsSync(repo + file) || !read(file).includes(needle))
      .map(([claim, file, needle]) => `${claim}: ${file} does not contain ${JSON.stringify(needle)}`);
    expect(bad).toEqual([]);
  });

  test("no prompt states a measurement a reader cannot re-derive", () => {
    // A number pasted into an instruction is right until the tree moves and then silently wrong. The patterns
    // are idioms that only appear when someone pastes a measurement, so this cannot rot: it never states a value.
    const banned: Array<[string, RegExp]> = [
      ["a count of files from a walk", /files? walked/i],
      [
        "a count of hits",
        /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty) (?:derived |total )?hits\b/i,
      ],
      ["a count of tests, assertions, rows or files", /\b\d+ (?:tests?|assertions?|rows?|files?)\b/i],
    ];
    const files = (readdirSync(repo + "rooms/templates", { recursive: true, withFileTypes: true }) as Dirent[])
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => `${e.parentPath}/${e.name}`.replace(repo, ""));
    const bad = files.flatMap((file) =>
      read(file)
        .split("\n")
        .flatMap((line, i) =>
          banned.filter(([, re]) => re.test(line)).map(([what]) => `${file}:${i + 1} states ${what}: ${line.trim()}`),
        ),
    );
    expect(bad).toEqual([]);
  });
});
