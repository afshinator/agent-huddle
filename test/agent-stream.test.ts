import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStream } from "../src/agent-stream";

async function harness(fn: (stream: AgentStream, path: string, read: () => Promise<string>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-stream-"));
  const path = join(dir, "output.log");
  try {
    const stream = new AgentStream();
    stream.open("dev1", path);
    await fn(stream, path, async () => readFile(path, "utf8").catch(() => ""));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("AgentStream", () => {
  test("deltas become one paragraph, not one line per fragment", async () => {
    await harness(async (stream, _path, read) => {
      for (const delta of ["The ", "quick ", "brown ", "fox"]) await stream.delta("dev1", delta);
      await stream.settle("dev1", "The quick brown fox");

      const out = await read();
      expect(out).toBe("The quick brown fox\n\n");
      expect(out).not.toContain("{");
    });
  });

  test("a turn that streams nothing writes its settled text", async () => {
    await harness(async (stream, _path, read) => {
      await stream.settle("dev1", "answered without streaming");
      expect(await read()).toBe("answered without streaming\n\n");
    });
  });

  test("a settled text does not repeat prose that already streamed", async () => {
    await harness(async (stream, _path, read) => {
      await stream.delta("dev1", "streamed once");
      await stream.settle("dev1", "streamed once");
      expect(await read()).toBe("streamed once\n\n");
    });
  });

  test("a lifecycle line closes an open paragraph and starts its own line", async () => {
    await harness(async (stream, _path, read) => {
      await stream.delta("dev1", "half a sentence");
      await stream.line("dev1", "[error] pi process for dev1 exited");
      await stream.line("dev1", "[exited]");

      expect(await read()).toBe("half a sentence\n[error] pi process for dev1 exited\n[exited]\n");
    });
  });

  test("concurrent deltas keep their order", async () => {
    // The writers race: three `appendFile` calls in flight completed out of order
    // ("Answered prose.\nin ") before the stream serialized them.
    await harness(async (stream, _path, read) => {
      void stream.delta("dev1", "Answered ");
      void stream.delta("dev1", "in ");
      void stream.delta("dev1", "prose.");
      await stream.settle("dev1", "Answered in prose.");

      expect(await read()).toBe("Answered in prose.\n\n");
    });
  });

  test("a tool call is one line naming the tool and its arguments", async () => {
    await harness(async (stream, _path, read) => {
      await stream.delta("dev1", "let me look");
      await stream.tool("dev1", { name: "bash", args: { command: "ls -la" } });
      await stream.settle("dev1", "let me look");

      expect(await read()).toBe('let me look\n[tool] bash {"command":"ls -la"}\n\n');
    });
  });

  test("a tool line comes before the settled text even when nothing streamed", async () => {
    await harness(async (stream, _path, read) => {
      await stream.tool("dev1", { name: "bash", args: { command: "ls" } });
      await stream.settle("dev1", "the answer");

      expect(await read()).toBe('[tool] bash {"command":"ls"}\nthe answer\n\n');
    });
  });

  test("long tool arguments are cut to one readable line", async () => {
    await harness(async (stream, _path, read) => {
      await stream.tool("dev1", { name: "write", args: { content: "x".repeat(500) } });
      const out = await read();
      const line = out.split("\n")[0];
      // The cut applies to the arguments: 199 characters plus "…".
      const args = line.slice("[tool] write ".length);
      expect(args.length).toBe(200);
      expect(args).toBe(`${JSON.stringify({ content: "x".repeat(500) }).slice(0, 199)}…`);
    });
  });

  test("turns stay separate: two turns separated by a blank line", async () => {
    await harness(async (stream, _path, read) => {
      await stream.delta("dev1", "first");
      await stream.settle("dev1", "first");
      await stream.delta("dev1", "second");
      await stream.settle("dev1", "second");

      expect(await read()).toBe("first\n\nsecond\n\n");
    });
  });
});
