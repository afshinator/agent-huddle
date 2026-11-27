import { test, expect } from "bun:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { HANDLE_RE } from "../src/router";

const roomsDir = join(import.meta.dir, "..", "rooms");
const templatesDir = join(roomsDir, "templates");

test("every shipped template loads and holds handles the router can match", async () => {
  const dirs = (await readdir(templatesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(dirs.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const dir of dirs) {
    const loaded = await loadConfig(join(templatesDir, dir, "template.yaml"), process.cwd());
    for (const agent of loaded.allAgents) {
      if (!HANDLE_RE.test(agent.handle)) offenders.push(`${dir}: ${agent.handle}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("one launcher takes a template name, and no template ships its own", async () => {
  // Two copies of a 108-line script drifted the moment one of them was edited. The template is an
  // argument now, and a template that grows its own launcher has quietly forked the boot path.
  const dirs = (await readdir(templatesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const forked: string[] = [];
  for (const dir of dirs) {
    for (const file of await readdir(join(templatesDir, dir))) {
      if (file.startsWith("launch")) forked.push(`${dir}/${file}`);
    }
  }
  expect(forked).toEqual([]);
  const shared = await stat(join(roomsDir, "launch.sh"));
  expect(shared.isFile()).toBe(true);
  // The launcher is run, not imported: without the executable bit it is `bash rooms/launch.sh`.
  expect(shared.mode & 0o111).toBeGreaterThan(0);
});

test("every shipped template is self-contained: its prompts sit in its own directory", async () => {
  const dirs = (await readdir(templatesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const stray: string[] = [];
  for (const dir of dirs) {
    const loaded = await loadConfig(join(templatesDir, dir, "template.yaml"), process.cwd());
    for (const agent of loaded.allAgents) {
      if (agent.system_prompt_file === undefined) continue;
      const relative = agent.system_prompt_file.slice(join(templatesDir, dir).length);
      // A template that reaches into a sibling directory has collateral it does not own.
      if (!relative.startsWith("/")) stray.push(`${dir}: ${agent.id} -> ${agent.system_prompt_file}`);
    }
  }
  expect(stray).toEqual([]);
});

test("gate 1 asks both verifiers in one message, not one after the other (b675953)", async () => {
  const lead = await readFile(join(templatesDir, "ticket-resolver1", "prompts", "lead.md"), "utf8");
  const gate1 = lead.slice(lead.indexOf("Gate 1"), lead.indexOf("Gate 2"));
  // Both handles in one dispatch line: the room queues both from a single lead turn, so the lead is
  // not the thing the second verification waits on.
  expect(gate1).toMatch(/one message[^\n]*@dev1[^\n]*@reviewer/i);
  // The old wording made the reviewer wait for the dev's report; that waiting is the defect.
  expect(gate1).not.toMatch(/When @dev1 reports/i);
});

test("both verifiers are told what the database is for, so neither improvises a rule (8980ddf)", async () => {
  for (const role of ["dev1", "reviewer"]) {
    const text = await readFile(join(templatesDir, "ticket-resolver1", "prompts", `${role}.md`), "utf8");
    // Run 002: dev1 reached for psql on its own because the ticket's claims were counts. That turned
    // out to matter (it found the one false claim), so the permission is stated rather than guessed.
    expect(text).toMatch(/read-only `select`/i);
    expect(text).toMatch(/never applied|read, never applied|applying it is a human/i);
    expect(text).toMatch(/cannot check — needs the database/i);
  }
});
