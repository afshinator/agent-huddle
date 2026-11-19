import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator";
import { loadConfig } from "../src/config";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";

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

const yaml = `name: coord-itest
max_hops: 6
lead:
  id: lead
  handle: "@lead"
  role: "Lead coordinator."
  system_prompt: "You are the lead. Reply tersely to the supervisor."
  provider: ${provider}
  model: ${model}
agents:
  - id: dev1
    handle: "@dev1"
    role: "Implementer."
    system_prompt: "Reply tersely."
    provider: ${provider}
    model: ${model}
`;

describe.skipIf(!piAvailable() || integrationDisabled())("Coordinator (real pi, headless)", () => {
  test("boot (idle) → submit → state persisted → shutdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-coord-it-"));
    await writeFile(join(dir, "team.yaml"), yaml, "utf8");

    const config = await loadConfig(join(dir, "team.yaml"), dir);
    const store = new RoomStore(config.config.room_dir);
    const pi = new RealPiAgentClient({ roomDir: config.config.room_dir });
    const coordinator = new Coordinator({ config, store, pi, telemetry: new NoopTelemetry() });

    try {
      const boot = await coordinator.boot();
      expect(boot).toBeNull(); // no task → idle
      expect((await store.readState())!.status).toBe("idle");

      const result = await coordinator.submit("Reply with exactly: OK");
      expect(result.status).toBe("completed");

      const msgs = await store.readMessages();
      expect(msgs.length).toBeGreaterThanOrEqual(2); // user + at least one agent reply
      expect(msgs[0].kind).toBe("user");

      const state = await store.readState();
      expect(state!.name).toBe("coord-itest");
      expect(["idle", "halted"]).toContain(state!.status);

      await coordinator.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
