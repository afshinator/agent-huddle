import { test, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");

/** tsc drops dot-prefixed files from wildcard includes, so a probe named `.x.ts` proves nothing. */
async function dotPrefixedTs(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      found.push(...(await dotPrefixedTs(path)));
    } else if (entry.name.startsWith(".") && /\.[cm]?tsx?$/.test(entry.name)) {
      found.push(relative(root, path));
    }
  }
  return found;
}

test("no dot-prefixed TypeScript file survives in the tree", async () => {
  expect(await dotPrefixedTs(root)).toEqual([]);
});
