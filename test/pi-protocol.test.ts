import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";
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
