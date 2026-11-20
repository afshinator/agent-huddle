import { test, expect, describe } from "bun:test";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneInbox } from "../src/pane-inbox";

async function harness(
  fn: (opts: { dir: string; inbox: PaneInbox; lines: Array<[string, string]>; path: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-inbox-"));
  const lines: Array<[string, string]> = [];
  const inbox = new PaneInbox({ onLine: (agentId, line) => lines.push([agentId, line]) });
  try {
    await fn({ dir, inbox, lines, path: join(dir, "inbox") });
  } finally {
    inbox.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

describe("PaneInbox", () => {
  test("a line typed after track becomes one message line", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await writeFile(path, "", "utf8");
      await inbox.track("dev1", path);

      await appendFile(path, "please fix the bug\n", "utf8");
      await inbox.pollOnce();

      expect(lines).toEqual([["dev1", "please fix the bug"]]);
    });
  });

  test("a half-typed line waits for its newline", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await writeFile(path, "", "utf8");
      await inbox.track("dev1", path);

      await appendFile(path, "half a li", "utf8");
      await inbox.pollOnce();
      expect(lines).toEqual([]);

      await appendFile(path, "ne\n", "utf8");
      await inbox.pollOnce();
      expect(lines).toEqual([["dev1", "half a line"]]);
    });
  });

  test("restart does not replay lines that were already there", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await writeFile(path, "typed before boot\n", "utf8");
      await inbox.track("dev1", path);

      await inbox.pollOnce();
      expect(lines).toEqual([]);

      await appendFile(path, "typed after boot\n", "utf8");
      await inbox.pollOnce();
      expect(lines).toEqual([["dev1", "typed after boot"]]);
    });
  });

  test("a line is consumed once, not on every poll", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await writeFile(path, "", "utf8");
      await inbox.track("dev1", path);
      await appendFile(path, "only once\n", "utf8");

      await inbox.pollOnce();
      await inbox.pollOnce();
      await inbox.pollOnce();
      expect(lines).toEqual([["dev1", "only once"]]);
    });
  });

  test("a blank line is not a message", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await writeFile(path, "", "utf8");
      await inbox.track("dev1", path);
      await appendFile(path, "\n   \n", "utf8");
      await inbox.pollOnce();
      expect(lines).toEqual([]);
    });
  });

  test("a missing inbox file is not an error", async () => {
    await harness(async ({ inbox, lines, path }) => {
      await inbox.track("dev1", path);
      await inbox.pollOnce();
      expect(lines).toEqual([]);
    });
  });
});
