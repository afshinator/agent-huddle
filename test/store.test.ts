import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, reconcileState } from "../src/store";
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
      const { messages, skipped } = await s.readMessages();
      expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(skipped).toBe(0);
    });
  });

  test("readMessages returns nothing when file missing", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      expect(await s.readMessages()).toEqual({ messages: [], skipped: 0 });
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

  test("readMessages skips a truncated final line and counts it", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await s.appendMessage(msg("m1"));
      await s.appendMessage(msg("m2"));
      const text = await Bun.file(s.messagesPath).text();
      await writeFile(s.messagesPath, text + '{"id":"m3","ts":"t","kin', "utf8");

      const { messages, skipped } = await s.readMessages();
      expect(messages.map((m) => m.id)).toEqual(["m1", "m2"]);
      expect(skipped).toBe(1);
    });
  });

  test("readMessages skips a JSON line that is not an object", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await s.appendMessage(msg("m1"));
      const text = await Bun.file(s.messagesPath).text();
      await writeFile(s.messagesPath, text + "5\nnull\n", "utf8");

      const { messages, skipped } = await s.readMessages();
      expect(messages.map((m) => m.id)).toEqual(["m1"]);
      expect(skipped).toBe(2);
    });
  });

  test("each read reports its own count, so a throwaway store cannot lose it", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "messages.jsonl"), "not json\n", "utf8");
      const first = await new RoomStore(dir).readMessages();
      expect(first).toEqual({ messages: [], skipped: 1 });

      await writeFile(join(dir, "messages.jsonl"), JSON.stringify(msg("m1")) + "\n", "utf8");
      const second = await new RoomStore(dir).readMessages();
      expect(second.messages).toHaveLength(1);
      expect(second.skipped).toBe(0);
    });
  });

  test("readState returns null for a corrupt cache instead of throwing", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await writeFile(s.statePath, '{"name":"r","agents":', "utf8");
      expect(await s.readState()).toBeNull();
    });
  });

  test("reconcileState derives agents and lastMessageId", async () => {
    await withDir(async (dir) => {
      const s = new RoomStore(dir);
      await s.appendMessage(msg("m1"));
      await s.appendMessage(msg("m2"));
      const state = await reconcileState(makeConfig(dir), null, (await s.readMessages()).messages);
      expect(state.lastMessageId).toBe("m2");
      expect(state.status).toBe("idle");
      expect(state.chain).toBeNull();
      expect(state.leadAgentId).toBe("lead");
      expect(Object.keys(state.agents).sort()).toEqual(["dev1", "lead"]);
      expect(state.agents.dev1.sessionDir).toBe(join(dir, "agents", "dev1", "sessions"));
    });
  });
});

describe("RoomStore (hostile filesystem)", () => {
  test("appendMessage and writeState reject when the room directory is unwritable", async () => {
    await withDir(async (dir) => {
      const room = join(dir, "room");
      const store = new RoomStore(join(dir, "room"));
      await chmod(dir, 0o500); // read + execute, no write: mkdir fails with EACCES
      try {
        await expect(store.appendMessage(msg("m1"))).rejects.toThrow(/EACCES|permission denied/);
        const state = await reconcileState(makeConfig(room), null, []);
        await expect(store.writeState(state)).rejects.toThrow(/EACCES|permission denied/);
      } finally {
        await chmod(dir, 0o700);
      }

      // The store does not stay poisoned: once the directory is writable it appends.
      await store.appendMessage(msg("m2"));
      expect((await store.readMessages()).messages.map((m) => m.id)).toEqual(["m2"]);
    });
  });
});
