import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
