import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, rebuildState } from "../src/store";
import type { LoadedConfig } from "../src/config";
import type { RoomMessage } from "../src/messages";
import type { RoomState } from "../src/state";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function msg(id: string, chainId = "c1", hop = 0): RoomMessage {
  return {
    id,
    ts: new Date().toISOString(),
    kind: "user",
    from: "supervisor",
    handle: "supervisor",
    text: "hello",
    mentions: [],
    chainId,
    hop,
  };
}

function makeConfig(roomDir: string): LoadedConfig {
  const lead = { id: "lead", handle: "@lead", role: "r" };
  const dev1 = { id: "dev1", handle: "@dev1", role: "d" };
  const allAgents = [lead, dev1];
  return {
    config: { name: "r", room_dir: roomDir, max_hops: 12, lead, agents: [dev1] },
    sourcePath: join(roomDir, "team.yaml"),
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

describe("RoomStore", () => {
  test("append + read preserves order", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await s.appendMessage(msg("m1"));
      await s.appendMessage(msg("m2"));
      const msgs = await s.readMessages();
      expect(msgs.map((m) => m.id)).toEqual(["m1", "m2"]);
    });
  });

  test("readMessages returns [] when file missing", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      expect(await s.readMessages()).toEqual([]);
    });
  });

  test("writeState + readState round-trips, no .tmp left", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      const state: RoomState = {
        name: "r",
        configPath: "/x/team.yaml",
        startedAt: new Date().toISOString(),
        status: "idle",
        leadAgentId: "lead",
        chain: null,
        agents: {},
        lastMessageId: null,
      };
      await s.writeState(state);
      expect(await s.readState()).toEqual(state);
      const files = await readdir(dir);
      expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  test("readState returns null when missing", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      expect(await s.readState()).toBeNull();
    });
  });

  test("rebuildState derives agents and lastMessageId", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await s.appendMessage(msg("m1"));
      await s.appendMessage(msg("m2"));
      const state = await rebuildState(makeConfig(dir), dir);
      expect(state.lastMessageId).toBe("m2");
      expect(state.status).toBe("idle");
      expect(state.chain).toBeNull();
      expect(state.leadAgentId).toBe("lead");
      expect(Object.keys(state.agents).sort()).toEqual(["dev1", "lead"]);
      expect(state.agents.dev1.sessionDir).toBe(join(dir, "agents", "dev1", "sessions"));
    });
  });
});
