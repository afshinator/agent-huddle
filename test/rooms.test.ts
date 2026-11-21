import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
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
