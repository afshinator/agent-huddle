import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import { FakeHerdrPaneManager } from "../src/seams/herdr-pane-manager";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

function config(roomDir: string): LoadedConfig {
  const allAgents = [lead, dev1];
  return { config: { name: "room", room_dir: roomDir, max_hops: 4, lead, agents: [dev1] }, sourcePath: join(roomDir, "team.yaml"), allAgents, agentById: new Map(allAgents.map((a) => [a.id, a])) };
}

test("Coordinator repairs a partial state cache before boot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-repair-"));
  try {
    await writeFile(join(dir, "state.json"), JSON.stringify({ name: "old", startedAt: "stable", agents: { lead: { id: "lead", handle: "@lead", status: "busy", sessionDir: "old" } } }));
    const c = config(dir);
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const coordinator = new Coordinator({ config: c, store, pi, telemetry: new NoopTelemetry(), panes: new FakeHerdrPaneManager() });
    const result = await coordinator.boot();
    expect(result).toBeNull();
    const state = await store.readState();
    expect(state!.startedAt).toBe("stable");
    expect(Object.keys(state!.agents).sort()).toEqual(["dev1", "lead"]);
    expect(state!.agents.dev1.pid).toBeGreaterThan(0);
    expect(state!.agents.lead.status).toBe("idle");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
