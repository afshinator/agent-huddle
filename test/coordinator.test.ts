import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator";
import { RoomStore } from "../src/store";
import { NoopTelemetry } from "../src/telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import { FakeHerdrPaneManager } from "../src/seams/herdr-pane-manager";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

function makeConfig(roomDir: string, opts?: { maxHops?: number; task?: string }): LoadedConfig {
  const allAgents = [lead, dev1];
  return {
    config: {
      name: "room",
      room_dir: roomDir,
      ...(opts?.task !== undefined ? { task: opts.task } : {}),
      definition_of_done: "done",
      max_hops: opts?.maxHops ?? 12,
      lead,
      agents: [dev1],
    },
    sourcePath: join(roomDir, "team.yaml"),
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

interface Harness {
  coordinator: Coordinator;
  store: RoomStore;
  pi: FakePiAgentClient;
  panes: FakeHerdrPaneManager;
  out: string[];
}

async function harness(
  opts: { maxHops?: number; task?: string },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-coord-"));
  try {
    const config = makeConfig(dir, opts);
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const panes = new FakeHerdrPaneManager();
    const out: string[] = [];
    const coordinator = new Coordinator({
      config,
      store,
      pi,
      telemetry: new NoopTelemetry(),
      panes,
      stdout: { write: (s) => out.push(s) },
    });
    await fn({ coordinator, store, pi, panes, out });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Coordinator (fakes)", () => {
  test("boot: startup task → lead → specialist → DONE, persists state and opens panes", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, store, pi, panes, out }) => {
      pi.script("lead", [{ lastText: "@dev1 implement it" }, { lastText: "verified\nDONE" }]);
      pi.script("dev1", [{ lastText: "@lead ready" }]);

      const result = await coordinator.boot();

      expect(result!.status).toBe("completed");
      expect(result!.hopCount).toBe(3);

      const msgs = await store.readMessages();
      expect(msgs.map((m) => `${m.kind}:${m.from}`)).toEqual([
        "startup_task:room",
        "agent:lead",
        "agent:dev1",
        "agent:lead",
      ]);

      const state = await store.readState();
      expect(state!.status).toBe("idle");
      expect(state!.name).toBe("room");
      expect(Object.keys(state!.agents).sort()).toEqual(["dev1", "lead"]);

      // per-agent panes opened with a tail command
      expect(panes.calls.filter((c) => c.op === "open")).toHaveLength(2);
      for (const c of panes.calls.filter((c) => c.op === "open")) {
        expect((c.payload as { command: string[] }).command[0]).toBe("tail");
      }

      // live room stream printed to stdout
      const stream = out.join("");
      expect(stream).toContain("[room] do the work");
      expect(stream).toContain("[@lead]");
      expect(stream).toContain("[@dev1]");
    });
  });

  test("boot with no task starts idle and persists idle state", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      const result = await coordinator.boot();
      expect(result).toBeNull();
      expect(await store.readMessages()).toEqual([]);
      expect(pi.calls.filter((c) => c.op === "prompt")).toEqual([]);
      expect((await store.readState())!.status).toBe("idle");
    });
  });

  test("preserves one startedAt and live agent runtime across submit and shutdown", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi, panes }) => {
      await coordinator.boot();
      const bootState = await store.readState();
      const startedAt = bootState!.startedAt;
      const bootPid = bootState!.agents.lead.pid;
      const bootPaneId = bootState!.agents.lead.paneId;
      expect(bootPid).toBeGreaterThan(0);
      expect(bootPaneId).toBe("agent-lead");

      pi.script("lead", [{ lastText: "ack\nDONE" }]);
      await coordinator.submit("status");
      const submittedState = await store.readState();
      expect(submittedState!.startedAt).toBe(startedAt);
      expect(submittedState!.agents.lead.pid).toBe(bootPid);
      expect(submittedState!.agents.lead.paneId).toBe(bootPaneId);

      await coordinator.shutdown();
      const shutdownState = await store.readState();
      expect(shutdownState!.startedAt).toBe(startedAt);
      expect(shutdownState!.agents.lead.pid).toBe(bootPid);
      expect(panes.panes.has("agent-lead")).toBe(true);
    });
  });

  test("hop-cap halt persists halted state", async () => {
    await harness({ task: "do the work", maxHops: 2 }, async ({ coordinator, store, pi }) => {
      pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "@dev1 wrap" }]);
      pi.script("dev1", [{ lastText: "@lead ok" }, { lastText: "summary" }]);

      const result = await coordinator.boot();

      expect(result!.status).toBe("halted");
      expect((await store.readState())!.status).toBe("halted");
      const msgs = await store.readMessages();
      expect(msgs.some((m) => m.kind === "hop_limit_reached")).toBe(true);
    });
  });

  test("submit routes a user message and persists state", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      pi.script("lead", [{ lastText: "ack\nDONE" }]);

      const result = await coordinator.submit("status please");
      expect(result.status).toBe("completed");

      const msgs = await store.readMessages();
      expect(msgs[0].kind).toBe("user");
      expect(msgs[0].from).toBe("supervisor");
      expect(msgs[1].from).toBe("lead");
      expect((await store.readState())!.status).toBe("idle");
    });
  });

  test("concurrent submissions run FIFO without interleaving prompts", async () => {
    await harness({ task: undefined }, async ({ coordinator, pi, store }) => {
      pi.script("lead", [
        { lastText: "first\nDONE" },
        { lastText: "second\nDONE" },
      ]);
      await coordinator.boot();

      const first = coordinator.submit("first");
      const second = coordinator.submit("second");
      const results = await Promise.all([first, second]);

      expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
      expect(pi.calls.filter((call) => call.op === "prompt").map((call) => call.agentId)).toEqual(["lead", "lead"]);
      const messages = await store.readMessages();
      expect(messages.filter((message) => message.kind === "user").map((message) => message.text)).toEqual(["first", "second"]);
      expect(messages.filter((message) => message.kind === "agent").map((message) => message.text)).toEqual(["first\nDONE", "second\nDONE"]);
    });
  });

  test("shutdown stops every agent and persists state", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, store, pi }) => {
      pi.script("lead", [{ lastText: "done\nDONE" }]);
      await coordinator.boot();
      await coordinator.shutdown();

      const shutdownCalls = pi.calls.filter((c) => c.op === "shutdown").map((c) => c.agentId);
      expect(shutdownCalls.sort()).toEqual(["dev1", "lead"]);
      expect((await store.readState())!.status).toBe("idle");
    });
  });
});
