import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator";
import { loadConfig } from "../src/config";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";

function integrationDisabled(): boolean {
  const v = (process.env.PI_TEST_INTEGRATION ?? "1").toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

async function writeRpcFixture(dir: string): Promise<string> {
  const fixture = join(dir, "rpc-fixture.ts");
  const launcher = join(dir, "rpc-fixture.sh");
  await writeFile(fixture, `
const reader = Bun.stdin.stream().pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
const sessionId = process.argv[process.argv.indexOf("--session-id") + 1] ?? "lead";
let lastText = "";
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
      out({ id: command.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      out({ type: "agent_start" });
      const text = sessionId === "lead" && command.message.includes("startup mission")
        ? "@dev1 implement the requested change"
        : sessionId === "dev1"
          ? "Got it: implement it\\n@lead implementation complete"
          : "Got it: dev1 is done\\nverified\\nDONE";
      lastText = text;
      for (const part of text.match(/[\\s\\S]{1,12}/g) ?? []) {
        out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: part } });
      }
      out({ type: "agent_settled", aborted: false });
    } else if (command.type === "get_session_stats") {
      out({
        id: command.id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.01, toolCalls: 1 },
      });
    } else if (command.type === "get_last_assistant_text") {
      out({ id: command.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: lastText } });
    } else if (command.type === "bash") {
      out({ id: command.id, type: "response", command: "bash", success: true, data: {} });
    }
  }
}
`, "utf8");
  await writeFile(launcher, `#!/bin/sh\nexec bun ${fixture} "$@"\n`, "utf8");
  await chmod(launcher, 0o755);
  return launcher;
}

describe.skipIf(integrationDisabled())("Coordinator (controlled real RPC)", () => {
  test("startup task → lead → specialist → DONE persists the room state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-coord-rpc-"));
    const fixture = await writeRpcFixture(dir);
    const yaml = `name: coord-rpc\ntask: startup mission\nmax_hops: 6\nlead:\n  id: lead\n  handle: "@lead"\n  role: lead\n  provider: fixture\n  model: fixture\nagents:\n  - id: dev1\n    handle: "@dev1"\n    role: developer\n    provider: fixture\n    model: fixture\n`;
    await writeFile(join(dir, "team.yaml"), yaml, "utf8");
    const config = await loadConfig(join(dir, "team.yaml"), dir);
    const store = new RoomStore(config.config.room_dir);
    const pi = new RealPiAgentClient({ roomDir: config.config.room_dir, piBin: fixture });
    const coordinator = new Coordinator({ config, store, pi, telemetry: new NoopTelemetry(), color: false });
    try {
      const result = await coordinator.boot();
      expect(result?.status).toBe("completed");
      expect(result?.hopCount).toBe(3);
      const messages = (await store.readMessages()).messages;
      expect(messages.map((message) => `${message.kind}:${message.from}`)).toEqual([
        "startup_task:room",
        "agent:lead",
        "agent:dev1",
        "agent:lead",
      ]);
      expect(messages[1].mentions).toEqual(["dev1"]);
      expect(messages[2].mentions).toEqual(["lead"]);
      expect(messages[3].doneSignal).toBe(true);
      expect((await store.readState())!.status).toBe("idle");
    } finally {
      await coordinator.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe.skipIf(integrationDisabled())("Coordinator (real pi, headless)", () => {
  test("boot (idle) → submit → state persisted → shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-coord-it-"));
    await writeFile(join(dir, "team.yaml"), `name: coord-itest\nmax_hops: 6\nlead:\n  id: lead\n  handle: "@lead"\n  role: "Lead coordinator."\n  system_prompt: "You are the lead. Reply tersely to the supervisor."\n  provider: commandcode\n  model: deepseek/deepseek-v4.1-flash\nagents:\n  - id: dev1\n    handle: "@dev1"\n    role: "Implementer."\n    system_prompt: "Reply tersely."\n    provider: commandcode\n    model: deepseek/deepseek-v4.1-flash\n`, "utf8");
    const config = await loadConfig(join(dir, "team.yaml"), dir);
    const store = new RoomStore(config.config.room_dir);
    const pi = new RealPiAgentClient({ roomDir: config.config.room_dir });
    const coordinator = new Coordinator({ config, store, pi, telemetry: new NoopTelemetry(), color: false });
    try {
      const boot = await coordinator.boot();
      expect(boot).toBeNull();
      const result = await coordinator.submit("@lead Reply with exactly: OK");
      expect(result.status).toBe("completed");
      expect((await store.readMessages()).messages.length).toBeGreaterThanOrEqual(2);
      expect((await store.readState())!.name).toBe("coord-itest");
    } finally {
      await coordinator.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
