import { test, expect, describe } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { shellWord } from "../src/shell";
import { paneScript } from "../src/pane-command";

const execFileP = promisify(execFile);

/** What a shell sees as one word, proven by the shell rather than by string comparison. */
async function asShellSees(value: string): Promise<string> {
  const { stdout } = await execFileP("sh", ["-c", `printf '%s' ${shellWord(value)}`]);
  return stdout;
}

describe("shellWord", () => {
  test("a value survives the shell unchanged, including quotes, newlines and dollars", async () => {
    for (const value of [
      "plain",
      "with space",
      "it's",
      "two\nlines",
      "$HOME and `whoami` and $(date)",
      "back\\slash",
      "",
    ]) {
      expect(await asShellSees(value)).toBe(value);
    }
  });

  test("a quote cannot end the word early", async () => {
    // Without escaping this would run `date` as a second command.
    const { stdout } = await execFileP("sh", ["-c", `printf '%s' ${shellWord("a'; date; echo 'b")}`]);
    expect(stdout).not.toMatch(/\d{2}:\d{2}/);
    expect(stdout).toBe("a'; date; echo 'b");
  });
});

/** The two spellings of the escape call, as they appear in source. */
const QUOTING_CALLS = [`replaceAll("'",`, "replace(/'/g"];

describe("one quoting rule", () => {
  test("both shell callers quote through the shared module", async () => {
    const dir = new URL("../src", import.meta.url).pathname;
    const files: string[] = [];
    const walk = async (path: string): Promise<void> => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    await walk(dir);

    // The escaping call itself may appear once, in the shared module.
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("/shell.ts")) continue;
      const text = await readFile(file, "utf8");
      if (QUOTING_CALLS.some((needle) => text.includes(needle))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  test("the pane script uses the shared helper for paths with spaces and quotes", () => {
    const script = paneScript({ stream: "/r/a b/it's.log", inbox: "/r/a b/it's.inbox" });
    expect(script).toContain("'/r/a b/it'\\''s.log'");
    expect(script).toContain("'/r/a b/it'\\''s.inbox'");
  });
});
