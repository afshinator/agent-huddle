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
  test("a tool call is one line naming the tool and its arguments", async () => {
    await harness(async (stream, _path, read) => {
      await stream.tool("dev1", { name: "bash", args: { command: "ls -la" } });
      expect(await read()).toBe('[tool] bash {"command":"ls -la"}\n');
    });
  });

  test("lifecycle lines are one line each, in order", async () => {
    await harness(async (stream, _path, read) => {
      await stream.line("dev1", "[started] pid=1");
      await stream.tool("dev1", { name: "bash", args: { command: "ls" } });
      await stream.line("dev1", "[exited]");
      expect(await read()).toBe('[started] pid=1\n[tool] bash {"command":"ls"}\n[exited]\n');
    });
  });

  test("concurrent writes keep their order", async () => {
    // The writers race: three `appendFile` calls in flight completed out of order before the
    // stream serialized them.
    await harness(async (stream, _path, read) => {
      void stream.line("dev1", "[one]");
      void stream.line("dev1", "[two]");
      void stream.line("dev1", "[three]");
      await stream.line("dev1", "[four]");
      expect(await read()).toBe("[one]\n[two]\n[three]\n[four]\n");
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
});

describe("AgentStream across boots", () => {
  test("opening an agent's stream again starts a clean file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-stream-boot-"));
    try {
      const path = join(dir, "output.log");
      const stream = new AgentStream();
      stream.open("dev1", path);
      await stream.line("dev1", "[started] pid=1");
      await stream.line("dev1", "[exited]");

      // a second boot, same room directory
      stream.open("dev1", path);
      await stream.line("dev1", "[started] pid=2");

      const text = await readFile(path, "utf8");
      expect(text).toBe("[started] pid=2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
