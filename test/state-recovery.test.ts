import { test, expect, describe } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Coordinator } from "../src/coordinator";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { RecordingTelemetry } from "./recording-telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import { FakeHerdrPaneManager } from "../src/seams/herdr-pane-manager";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

function config(roomDir: string): LoadedConfig {
  const allAgents = [lead, dev1];
  return { config: { name: "room", room_dir: roomDir, max_hops: 4, turn_timeout_ms: 300_000, lead, agents: [dev1] }, sourcePath: join(roomDir, "team.yaml"), allAgents, agentById: new Map(allAgents.map((a) => [a.id, a])) };
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

test("a stale active state does not make boot resume a chain", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-stale-active-"));
  try {
    await writeFile(join(dir, "state.json"), JSON.stringify({ name: "room", startedAt: "s", status: "active", chain: { chainId: "c1", status: "active", hopCount: 3 }, agents: {} }));
    const c = config(dir);
    const store = new RoomStore(dir);
    const coordinator = new Coordinator({ config: c, store, pi: new FakePiAgentClient(), telemetry: new NoopTelemetry(), panes: new FakeHerdrPaneManager() });

    await coordinator.boot();

    const state = await store.readState();
    expect(state!.status).toBe("idle");
    expect(state!.chain).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Coordinator boots from the log when state.json is corrupt", async () => {  const dir = await mkdtemp(join(tmpdir(), "ah-corrupt-state-"));
  try {
    const good = JSON.stringify({ id: "m1", ts: "t", kind: "user", from: "supervisor", handle: "supervisor", text: "a", mentions: [], chainId: "c", hop: 0 });
    await writeFile(join(dir, "messages.jsonl"), good + "\n", "utf8");
    await writeFile(join(dir, "state.json"), '{"name":"room","startedAt":"x","agents":', "utf8");

    const store = new RoomStore(dir);
    const coordinator = new Coordinator({ config: config(dir), store, pi: new FakePiAgentClient(), telemetry: new NoopTelemetry(), panes: new FakeHerdrPaneManager() });

    await expect(coordinator.boot()).resolves.toBeNull();

    const state = await store.readState();
    expect(state!.lastMessageId).toBe("m1");
    expect(Object.keys(state!.agents).sort()).toEqual(["dev1", "lead"]);
    // The unreadable cache is discarded, so startedAt comes from this boot.
    expect(Math.abs(Date.now() - Date.parse(state!.startedAt))).toBeLessThan(60_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("Coordinator boots after a truncated log line and warns once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ah-truncated-"));
  try {
    const good = JSON.stringify({ id: "m1", ts: "t", kind: "user", from: "supervisor", handle: "supervisor", text: "a", mentions: [], chainId: "c", hop: 0 });
    await writeFile(join(dir, "messages.jsonl"), good + "\n" + '{"id":"m2","ts":"t","kin', "utf8");

    const telemetry = new RecordingTelemetry();
    const store = new RoomStore(dir);
    const coordinator = new Coordinator({ config: config(dir), store, pi: new FakePiAgentClient(), telemetry });

    await expect(coordinator.boot()).resolves.toBeNull();

    const state = await store.readState();
    expect(state!.lastMessageId).toBe("m1");
    const skipped = telemetry.warns.filter((w) => w.msg.includes("skipped"));
    expect(skipped).toHaveLength(1);
    expect(skipped[0].attrs?.count).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
