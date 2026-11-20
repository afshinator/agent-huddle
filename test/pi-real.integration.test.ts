import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";
import type { AgentSpec } from "../src/config";

function piAvailable(): boolean {
  const r = spawnSync("pi", ["--version"], { stdio: "ignore" });
  return r.status === 0 && !r.error;
}

function integrationDisabled(): boolean {
  const v = (process.env.PI_TEST_INTEGRATION ?? "1").toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

const provider = process.env.PI_TEST_PROVIDER ?? "commandcode";
const model = process.env.PI_TEST_MODEL ?? "deepseek/deepseek-v4.1-flash";

const agent: AgentSpec = { id: "itest", handle: "@itest", role: "test", provider, model };

describe("RealPiAgentClient (controlled RPC)", () => {
  test("uses authoritative final text and reports malformed/unmatched records", async () => {
    const roomDir = await mkdtemp(join(tmpdir(), "ah-rpc-fixture-"));
    const fixture = join(roomDir, "rpc-fixture.ts");
    const launcher = join(roomDir, "rpc-fixture.sh");
    await writeFile(
      fixture,
      `const reader = Bun.stdin.stream().pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
const out = (value: unknown) => console.log(JSON.stringify(value));
while (true) {
  const next = await reader.read();
  if (next.done) break;
  buffer += next.value;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === "prompt") {
      console.log("not-json");
      out({ type: "response", success: false, error: "orphan failure" });
      out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      out({ type: "agent_start" });
      out({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "TEXT_END" } });
      out({ type: "agent_settled", aborted: false });
    } else {
      out({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "AUTHORITATIVE" } });
    }
  }
}`,
      "utf8",
    );
    await chmod(fixture, 0o755);
    await writeFile(launcher, `#!/bin/sh\nexec bun ${fixture} "$@"\n`, "utf8");
    await chmod(launcher, 0o755);
    const client = new RealPiAgentClient({ roomDir, piBin: launcher });
    const errors: Error[] = [];
    try {
      await client.spawn({ id: "fixture", handle: "@fixture", role: "test" }, { cwd: roomDir });
      client.on("error", "fixture", (error) => errors.push(error));
      await client.prompt("fixture", { message: "go" });
      const result = await client.waitForSettled("fixture", 2_000);
      expect(result.lastText).toBe("AUTHORITATIVE");
      expect(errors.map((error) => error.message)).toEqual([
        expect.stringContaining("invalid JSON record"),
        expect.stringContaining("unmatched failed response"),
      ]);
      await client.shutdown("fixture");
    } finally {
      await rm(roomDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!piAvailable() || integrationDisabled())("RealPiAgentClient (integration)", () => {
  test(
    "spawn → prompt → settle → last text; pushContext produces no reply; shutdown",
    async () => {
      const roomDir = await mkdtemp(join(tmpdir(), "ah-real-"));
      const client = new RealPiAgentClient({ roomDir });
      try {
        const info = await client.spawn(agent, {
          cwd: roomDir,
          systemPrompt: "You are a terse test agent.",
          appendSystemPrompt: "Reply with the fewest characters possible.",
        });
        expect(info.sessionDir).toBe(join(roomDir, "agents", "itest", "sessions"));
        expect(info.pid).toBeGreaterThan(0);

        let settledEvents = 0;
        client.on("settled", "itest", () => settledEvents++);

        await client.prompt("itest", { message: "Reply with exactly: OK" });
        const result = await client.waitForSettled("itest", 120_000);
        expect(result.aborted).toBe(false);
        expect(result.lastText).toContain("OK");
        expect(settledEvents).toBe(1);

        const before = await client.getLastAssistantText("itest");
        await client.pushContext("itest", "room context: another agent said hello");
        // pushContext runs a bash echo (no run), so it must not produce a reply.
        expect(settledEvents).toBe(1);
        expect(await client.getLastAssistantText("itest")).toBe(before);

        await client.shutdown("itest");
      } finally {
        await rm(roomDir, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
