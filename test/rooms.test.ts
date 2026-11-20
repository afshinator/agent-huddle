import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { HANDLE_RE } from "../src/router";

const roomsDir = join(import.meta.dir, "..", "rooms");

test("every shipped room file loads and holds handles the router can match", async () => {
  const files = (await readdir(roomsDir)).filter((f) => f.endsWith(".yaml")).sort();
  expect(files.length).toBeGreaterThan(0);

  const offenders: string[] = [];
  for (const file of files) {
    const loaded = await loadConfig(join(roomsDir, file), process.cwd());
    for (const agent of loaded.allAgents) {
      if (!HANDLE_RE.test(agent.handle)) offenders.push(`${file}: ${agent.handle}`);
    }
  }
  expect(offenders).toEqual([]);
});
