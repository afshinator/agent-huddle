import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRoom } from "../src/startup";
import { TurnLoop } from "../src/turn-loop";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

function makeConfig(opts?: { task?: string }): LoadedConfig {
  const allAgents = [lead, dev1];
  return {
    config: {
      name: "room",
      room_dir: "/r",
      ...(opts?.task !== undefined ? { task: opts.task } : {}),
      max_hops: 12,
      turn_timeout_ms: 300_000,
      ack_scope: "lead",
      lead,
      agents: [dev1],
    },
    sourcePath: "/r/team.yaml",
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

async function harness(fn: (h: { loop: TurnLoop; store: RoomStore; pi: FakePiAgentClient }) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-start-"));
  try {
    const config = makeConfig({ task: "build the thing" });
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const loop = new TurnLoop({ config, store, pi, telemetry: new NoopTelemetry() });
    for (const a of config.allAgents) await pi.spawn(a, { cwd: dir });
    await fn({ loop, store, pi });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("startRoom", () => {
  test("task present → posts startup_task and dispatches the lead first", async () => {
    await harness(async ({ loop, store, pi }) => {
      pi.script("lead", [{ lastText: "done\nDONE" }]);
      const result = await startRoom(makeConfig({ task: "build the thing" }), loop);

      expect(result).not.toBeNull();
      expect(result!.status).toBe("completed");

      const msgs = (await store.readMessages()).messages;
      expect(msgs[0].kind).toBe("startup_task");
      expect(msgs[0].from).toBe("room");
      expect(msgs[0].text).toBe("build the thing");

      const firstPrompt = pi.calls.find((c) => c.op === "prompt");
      expect(firstPrompt!.agentId).toBe("lead");
    });
  });

  test("task absent → idle: null result, no messages, no dispatch", async () => {
    await harness(async ({ loop, store, pi }) => {
      const result = await startRoom(makeConfig(), loop);
      expect(result).toBeNull();
      expect((await store.readMessages()).messages).toEqual([]);
      expect(pi.calls.filter((c) => c.op === "prompt")).toEqual([]);
      expect(pi.calls.filter((c) => c.op === "pushContext")).toEqual([]);
    });
  });
});
