import { test, expect, describe } from "bun:test";
import { mkdtemp, appendFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneInbox } from "../src/pane-inbox";

async function harness(
  fn: (opts: {
    dir: string;
    inbox: PaneInbox;
    lines: Array<[string, string]>;
    path: string;
    errors: Array<[string, unknown]>;
  }) => Promise<void>,
  opts?: { read?: (path: string) => Promise<string> },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-inbox-"));
  const lines: Array<[string, string]> = [];
  const errors: Array<[string, unknown]> = [];
  const inbox = new PaneInbox({
    onLine: (agentId, line) => lines.push([agentId, line]),
    onError: (agentId, error) => errors.push([agentId, error]),
    ...(opts?.read ? { read: opts.read } : {}),
  });
  try {
    await fn({ dir, inbox, lines, path: join(dir, "inbox"), errors });
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

describe("PaneInbox read failures", () => {
  test("a read that fails is reported once per poll, naming the agent", async () => {
    let calls = 0;
    await harness(
      async ({ inbox, lines, path, errors }) => {
        await inbox.track("dev1", path);
        await inbox.pollOnce();
        await inbox.pollOnce();

        expect(lines).toEqual([]);
        // One read at track, then one per poll; every failure is surfaced.
        expect(calls).toBe(3);
        expect(errors).toHaveLength(3);
        expect(errors[0][0]).toBe("dev1");
        expect(String(errors[0][1])).toContain("permission denied");
      },
      {
        read: async () => {
          calls += 1;
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    );
  });

  test("a missing inbox file is silent, because that is the state before the first line", async () => {
    let calls = 0;
    await harness(
      async ({ inbox, lines, path, errors }) => {
        await inbox.track("dev1", path);
        await inbox.pollOnce();

        expect(lines).toEqual([]);
        expect(errors).toEqual([]);
        expect(calls).toBe(2);
      },
      {
        read: async () => {
          calls += 1;
          throw Object.assign(new Error("no such file"), { code: "ENOENT" });
        },
      },
    );
  });
});
