import { test, expect, describe } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

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
  "ticket-prep": "repairs a ticket's claims block before a resolver room starts; it writes no code and no ask",
};

const CHECKERS = ["dev1.md", "reviewer.md"];
const LEAD = "lead.md";

const RULES: Array<{ name: string; marker: string }> = [
  { name: "does not re-derive what is settled", marker: "Do not re-derive" },
  { name: "reports every criterion rather than a sample", marker: "Definition of Done is reported" },
  { name: "allows exactly one throwaway probe", marker: "one probe allowed" },
  { name: "names its own working directory", marker: "cwd is the worktree" },
  { name: "prints a report whole when it fits", marker: "Print a report whole" },
  { name: "treats a false reason as a false criterion", marker: "A false reason is a false criterion" },
];

/**
 * The prep room's rules. `RULES` above is applied to `GATES_TICKETS` only, so an exempt room is pinned by
 * nothing there; these nine decide what the prep agent may repair and what it must refuse, and a later edit
 * that drops one turns the room into one that rewrites tickets instead of correcting them.
 */
const PREP_RULES = [
  "Find the file that decides the fact",
  "A false supporting reason is deleted, never reworded",
  "Never propose or rewrite the ask",
  "never move a state label",
  "No observable end state means stop",
  "Re-running must be safe",
  "A criterion needs a record that would go red if it were false",
  "A criterion about the future gets its `after` record",
  "An absence claim is scoped to the tree that could declare the symbol",
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
        // A template whose agents are not called dev1/reviewer has no such file. The rule is about
        // wherever the database is mentioned, not about every room naming its agents the same way.
        const text = await readFile(join(ROOT, name, "prompts", file), "utf8").catch(() => "");
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

  // Run 008: both checkers proved `probes` was not gitignored and the run shipped it anyway, because
  // criterion 1 named the exact exclude line. The lead is the one who can correct the ticket.
  test("a gating lead corrects a criterion whose reason fell", async () => {
    for (const name of await gating()) {
      const text = await readFile(join(ROOT, name, "prompts", LEAD), "utf8");
      expect(text).toContain("A false reason is a false criterion");
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

  test("the prep room carries all nine repair rules", async () => {
    const text = await readFile(join(ROOT, "ticket-prep", "prompts", "prep.md"), "utf8");
    expect(PREP_RULES.filter((rule) => !text.includes(rule))).toEqual([]);
  });
});

/** The two fields this test needs from a template's agent entry. */
type Writer = { id: string; tools?: string[]; system_prompt_file?: string };

/**
 * Every prompt that grants `write` carries the rule for a call the harness refused.
 *
 * Run 008's dev1 lost eight responses to the provider's cap between 23:06 and 23:30, two of them
 * mid-`write` with an unterminated argument string, then wrote the same file in one small call after one
 * sentence of steering: the rule was missing, not the capability. The writers come from each template's own
 * agent list, under any id — the prep room's writer is `prep`, not `dev1` — so a fourth template is covered
 * the day it exists.
 */
describe("every agent that may write is told what a refused call means", () => {
  test("a prompt granting write carries the rule", async () => {
    const marker = "refused for truncation";
    const missing: string[] = [];
    const checked: string[] = [];

    for (const name of await templates()) {
      const source = await readFile(join(ROOT, name, "template.yaml"), "utf8");
      const config = parseYaml(source) as { lead?: Writer; agents?: Writer[] };
      const agents = [config.lead, ...(config.agents ?? [])].filter((a): a is Writer => a !== undefined);
      // A template whose agents this parse cannot see would pass while checking nothing.
      expect(agents.length).toBeGreaterThan(0);

      for (const agent of agents) {
        if (!agent.tools?.includes("write")) continue;
        if (agent.system_prompt_file === undefined) {
          missing.push(`${name}: ${agent.id} grants write and names no system_prompt_file`);
          continue;
        }
        const text = await readFile(join(ROOT, name, agent.system_prompt_file), "utf8");
        if (!text.includes(marker)) missing.push(`${name}/${agent.system_prompt_file} (${agent.id})`);
        else checked.push(`${name}:${agent.id}`);
      }
    }

    expect(missing).toEqual([]);
    // A run that checked no prompt would prove nothing, so the derivation has to have found one.
    expect(checked.length).toBeGreaterThan(0);
  });
});
