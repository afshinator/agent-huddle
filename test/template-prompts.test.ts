import { test, expect, describe } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The rules that decide how much a gate costs, pinned across every template.
 *
 * Run 007 (#52) measured the cost of not having them: dev1 spent 71 tool calls and 25 minutes hand
 * re-deriving 24 claims the ticket's ```claims block had answered in 0.15 s, 11 of those calls were
 * database queries, and the reviewer answered the same gate in 24 seconds. The prompts now say (a) a green
 * check already settled its claims and is not to be re-derived, (b) a gate has a command budget, (c) the
 * database gets at most one query and only when a criterion turns on a stored number, (d) on a ticket with
 * a claims block, what a green and a red row mean.
 *
 * This test walks `rooms/templates/` rather than naming files, and refuses an unknown template: a new one
 * either carries the rules or is listed below with the reason it does not. Neither default is silent.
 */
const ROOT = resolve(import.meta.dir, "..", "rooms", "templates");

/** Templates whose job is gating a ticket's claims, so every rule below applies. */
const GATES_TICKETS = new Set(["ticket-resolver1", "ticket-resolver1-claims"]);

/** Templates doing a different job. Named on purpose: exemption is a decision, not an omission. */
const EXEMPT: Record<string, string> = {
  "docs-audit": "an inventory of docs, no ticket claims; it already carries its own two-minute budget",
};

const CHECKERS = ["dev1.md", "reviewer.md"];
const LEAD = "lead.md";

const RULES: Array<{ name: string; marker: string }> = [
  { name: "does not re-derive what is settled", marker: "Do not re-derive" },
  { name: "carries a command budget", marker: "Command budget" },
  { name: "names its own working directory", marker: "cwd is the worktree" },
  { name: "prints a report whole when it fits", marker: "Print a report whole" },
];

async function templates(): Promise<string[]> {
  const entries = await readdir(ROOT, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

const gating = async () => (await templates()).filter((n) => GATES_TICKETS.has(n));

describe("template prompts carry the gate-cost rules", () => {
  test("every template is either gating or exempt, with a reason", async () => {
    const unlisted = (await templates()).filter((n) => !GATES_TICKETS.has(n) && EXEMPT[n] === undefined);
    expect(unlisted).toEqual([]);
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
  });

  test("every gating template has a lead and both checkers", async () => {
    for (const name of await gating()) {
      for (const file of [...CHECKERS, LEAD]) {
        expect(await Bun.file(join(ROOT, name, "prompts", file)).exists()).toBe(true);
      }
    }
  });

  for (const file of CHECKERS) {
    for (const rule of RULES) {
      test(`${file} ${rule.name}`, async () => {
        const missing: string[] = [];
        for (const name of await gating()) {
          const text = await readFile(join(ROOT, name, "prompts", file), "utf8");
          if (!text.includes(rule.marker)) missing.push(name);
        }
        expect(missing).toEqual([]);
      });
    }

    test(`${file} allows at most one database query wherever it mentions the database`, async () => {
      const missing: string[] = [];
      for (const name of await templates()) {
        const text = await readFile(join(ROOT, name, "prompts", file), "utf8");
        if (!text.includes("## The database")) continue;
        if (!text.includes("at most one query")) missing.push(name);
      }
      expect(missing).toEqual([]);
    });
  }

  test("a gating lead names what was already settled before dispatching", async () => {
    for (const name of await gating()) {
      const text = await readFile(join(ROOT, name, "prompts", LEAD), "utf8");
      expect(text).toMatch(/already\s+settled|answered the\s+structural claims/);
    }
  });

  // dev1's `cd` prefix was 116 of 135 bash calls in run 007: the lead has to name the worktree, and the
  // checkers have to know their cwd already is it, or every command proves the directory again.
  test("a gating lead tells dev1 where it is working", async () => {
    for (const name of await gating()) {
      const text = await readFile(join(ROOT, name, "prompts", LEAD), "utf8");
      expect(text).toContain("cwd is the worktree");
    }
  });

  test("ran a claims block at Gate 0, the checkers know what a red row means", async () => {
    for (const name of await gating()) {
      const lead = await readFile(join(ROOT, name, "prompts", LEAD), "utf8");
      if (!lead.includes("Gate 0")) continue;
      for (const file of CHECKERS) {
        const text = await readFile(join(ROOT, name, "prompts", file), "utf8");
        expect(text).toContain("red row");
      }
    }
  });
});
