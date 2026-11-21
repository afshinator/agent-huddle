import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";
import { waitUntil } from "./helpers";
import type { AgentSpec } from "../src/config";

/**
 * The real client's record mapping, driven by a stub that speaks pi's RPC framing.
 *
 * This proves the protocol half without a model: `tool_execution_start` in, `tool`
 * event out. Whether real `pi` emits that record is documented in the pi package
 * (`docs/json.md`, "Tool execution events"); whether a model chooses to call a tool
 * is a model question, not a client question.
 */
const STUB = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const out = (o: unknown): void => {
  process.stdout.write(JSON.stringify(o) + "\\n");
};
createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim() === "") return;
  const cmd = JSON.parse(line) as { id?: string; type?: string };
  if (cmd.type === "prompt") {
    out({ id: cmd.id, type: "response", success: true, data: {} });
    out({ type: "agent_start" });
    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: {}, isError: false, durationMs: 1 });
    out({ type: "agent_settled" });
    return;
  }
  if (cmd.type === "get_last_assistant_text") {
    out({ id: cmd.id, type: "response", success: true, data: { text: "stub done" } });
    return;
  }
  if (cmd.id) out({ id: cmd.id, type: "response", success: true, data: {} });
});
`;

const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

describe("RealPiAgentClient (stub pi, protocol level)", () => {
  test("a tool_execution_start record becomes one tool event, and the turn still settles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-stub-"));
    const stub = join(dir, "fake-pi");
    await writeFile(stub, STUB, "utf8");
    await chmod(stub, 0o755);

    const client = new RealPiAgentClient({ roomDir: dir, piBin: stub });
    const tools: Array<{ name: string; args: unknown }> = [];
    try {
      await client.spawn(dev1, { cwd: dir });
      client.on("tool", "dev1", (t) => tools.push(t));

      await client.prompt("dev1", { message: "look at the files" });
      const settled = await client.waitForSettled("dev1", 5000);

      expect(tools).toEqual([{ name: "bash", args: { command: "ls" } }]);
      expect(settled.lastText).toBe("stub done");
    } finally {
      await client.shutdown("dev1").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

/**
 * A child's stderr belongs to the agent, not to the room (#50). The room's terminal is
 * the conversation; pi's runtime warnings go to that agent's own file, and reach the
 * terminal only when the operator asks for them.
 */
const NOISY_STUB = `#!/usr/bin/env bun
process.stderr.write("Warning: something the model process wants to say\\n");
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", () => {});
`;

describe("RealPiAgentClient lifecycle trace", () => {
  test("a spawn and the child's exit are traced with pid, code and signal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-trace-"));
    const stub = join(dir, "fake-pi");
    await writeFile(stub, STUB, "utf8");
    await chmod(stub, 0o755);

    const lines: string[] = [];
    const client = new RealPiAgentClient({
      roomDir: dir,
      piBin: stub,
      stderr: { write: () => {} },
      debug: (message) => lines.push(message),
    });
    try {
      await client.spawn(dev1, { cwd: dir });
      await client.shutdown("dev1");
      await waitUntil(() => lines.some((line) => line.startsWith("child exit")), 5000);

      expect(lines.filter((line) => line.startsWith("child spawn"))).toHaveLength(1);
      expect(lines.find((line) => line.startsWith("child exit"))).toMatch(/^child exit dev1 code=0 signal=null$/);
      // the exit is traced after the spawn, never before it
      expect(lines.findIndex((line) => line.startsWith("child spawn"))).toBeLessThan(
        lines.findIndex((line) => line.startsWith("child exit")),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("RealPiAgentClient child stderr", () => {
  async function withStub(
    env: string | undefined,
    fn: (h: { dir: string; client: RealPiAgentClient; said: string[] }) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "ah-stderr-"));
    const stub = join(dir, "fake-pi");
    await writeFile(stub, NOISY_STUB, "utf8");
    await chmod(stub, 0o755);
    const said: string[] = [];
    const client = new RealPiAgentClient({
      roomDir: dir,
      piBin: stub,
      stderr: { write: (s: string) => said.push(s) },
    });
    const previous = process.env.PI_STDERR;
    if (env === undefined) delete process.env.PI_STDERR;
    else process.env.PI_STDERR = env;
    try {
      await client.spawn(dev1, { cwd: dir });
      const log = join(dir, "agents", "dev1", "stderr.log");
      await waitUntil(() => said.length > 0 || Bun.file(log).size > 0, 5000);
      await fn({ dir, client, said });
    } finally {
      if (previous === undefined) delete process.env.PI_STDERR;
      else process.env.PI_STDERR = previous;
      await client.shutdown("dev1").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a warning goes to the agent's own file and not to the room's terminal", async () => {
    await withStub(undefined, async ({ dir, said }) => {
      expect(said).toEqual([]);
      const log = await readFile(join(dir, "agents", "dev1", "stderr.log"), "utf8");
      expect(log).toContain("Warning: something the model process wants to say");
    });
  }, 20_000);

  test("PI_STDERR=1 passes it through, prefixed with the agent", async () => {
    await withStub("1", async ({ said }) => {
      expect(said.join("")).toContain("[pi:dev1] Warning: something the model process wants to say");
    });
  }, 20_000);
});

describe("RealPiAgentClient child environment", () => {
  test("a room child cannot reach the live adapters, whatever the coordinator's own env says", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-child-env-"));
    const dump = join(dir, "child-env.txt");
    const stub = join(dir, "fake-pi");
    // dump the environment this child was actually given, then linger so the spawn settles
    await writeFile(stub, `#!/bin/sh\nenv > '${dump}'\nexec cat\n`, "utf8");
    await chmod(stub, 0o755);
    const client = new RealPiAgentClient({ roomDir: dir, piBin: stub, stderr: { write: () => {} } });
    const saved = { integration: process.env.PI_TEST_INTEGRATION, herdr: process.env.HERDR_ENV };
    process.env.PI_TEST_INTEGRATION = "1";
    process.env.HERDR_ENV = "1";
    try {
      await client.spawn(dev1, { cwd: dir });
      await waitUntil(() => Bun.file(dump).size > 0, 5000);
      const env = await Bun.file(dump).text();
      // the live adapter tests open real panes; a room's agent must never reach them
      expect(env).toContain("PI_TEST_INTEGRATION=0");
      // panes are the room's own business, so the herdr gate passes through untouched
      expect(env).toContain("HERDR_ENV=1");
    } finally {
      if (saved.integration === undefined) delete process.env.PI_TEST_INTEGRATION;
      else process.env.PI_TEST_INTEGRATION = saved.integration;
      if (saved.herdr === undefined) delete process.env.HERDR_ENV;
      else process.env.HERDR_ENV = saved.herdr;
      await client.shutdown("dev1").catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
