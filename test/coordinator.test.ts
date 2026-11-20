import { test, expect, describe } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/coordinator";
import { RoomStore } from "../src/store";
import { RecordingTelemetry } from "./recording-telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import { FakeHerdrPaneManager } from "../src/seams/herdr-pane-manager";
import { createShutdown } from "../src/shutdown";
import { AgentStream } from "../src/agent-stream";
import { gitRepo, waitForMessage, waitForText, waitUntil } from "./helpers";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

function makeConfig(
  roomDir: string,
  opts?: { maxHops?: number; task?: string; dev1Writable?: boolean; launchGuard?: "refuse" | "warn" | "off" },
): LoadedConfig {
  const agent: AgentSpec = opts?.dev1Writable === false ? { ...dev1, pane_writable: false } : dev1;
  const allAgents = [lead, agent];
  return {
    config: {
      name: "room",
      room_dir: roomDir,
      ...(opts?.task !== undefined ? { task: opts.task } : {}),
      definition_of_done: "done",
      max_hops: opts?.maxHops ?? 12,
      turn_timeout_ms: 300_000,
      ...(opts?.launchGuard ? { launch_guard: opts.launchGuard } : {}),
      lead,
      agents: [agent],
    },
    sourcePath: join(roomDir, "team.yaml"),
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

interface Harness {
  dir: string;
  coordinator: Coordinator;
  store: RoomStore;
  pi: FakePiAgentClient;
  panes: FakeHerdrPaneManager;
  telemetry: RecordingTelemetry;
  out: string[];
}

async function harness(
  opts: {
    maxHops?: number;
    task?: string;
    now?: () => string;
    dev1Writable?: boolean;
    cwd?: string;
    launchGuard?: "refuse" | "warn" | "off";
    agentStream?: AgentStream;
    inboxRead?: (path: string) => Promise<string>;
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-coord-"));
  try {
    const config = makeConfig(dir, opts);
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const panes = new FakeHerdrPaneManager();
    const out: string[] = [];
    const telemetry = new RecordingTelemetry();
    const coordinator = new Coordinator({
      config,
      store,
      pi,
      telemetry,
      panes,
      stdout: { write: (s) => out.push(s) },
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : { cwd: dir }),
      inboxPollMs: 5,
      ...(opts.agentStream ? { agentStream: opts.agentStream } : {}),
      ...(opts.inboxRead ? { inboxRead: opts.inboxRead } : {}),
    });
    await fn({ dir, coordinator, store, pi, panes, telemetry, out });
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

      const msgs = (await store.readMessages()).messages;
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

      // per-agent panes opened on the readable stream
      expect(panes.calls.filter((c) => c.op === "open")).toHaveLength(2);
      for (const c of panes.calls.filter((c) => c.op === "open")) {
        const scriptPath = (c.payload as { command: string[] }).command[1];
        expect(await readFile(scriptPath, "utf8")).toContain("output.log");
      }

      // live room stream printed to stdout
      const stream = out.join("");
      expect(stream).toContain("[room] do the work");
      expect(stream).toContain("[@lead]");
      expect(stream).toContain("[@dev1]");
    });
  });

  test("lastActivityAt moves only for agents that ran a turn", async () => {
    let tick = 0;
    const now = (): string => new Date(1_700_000_000_000 + tick++ * 1000).toISOString();
    await harness({ now }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      const before = (await store.readState())!;

      // No mention: the lead answers alone, dev1 never runs.
      pi.script("lead", [{ lastText: "answered\nDONE" }]);
      await coordinator.submit("@lead just answer me");

      const after = (await store.readState())!;
      expect(after.agents.lead.lastActivityAt).not.toBe(before.agents.lead.lastActivityAt);
      expect(after.agents.dev1.lastActivityAt).toBe(before.agents.dev1.lastActivityAt);
    });
  });

  test("boot with no task starts idle and persists idle state", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      const result = await coordinator.boot();
      expect(result).toBeNull();
      expect((await store.readMessages()).messages).toEqual([]);
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
      await coordinator.submit("@lead status");
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
      const msgs = (await store.readMessages()).messages;
      expect(msgs.some((m) => m.kind === "hop_limit_reached")).toBe(true);
    });
  });

  test("submit routes a user message and persists state", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      pi.script("lead", [{ lastText: "ack\nDONE" }]);

      const result = await coordinator.submit("@lead status please");
      expect(result.status).toBe("completed");

      const msgs = (await store.readMessages()).messages;
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

      const first = coordinator.submit("@lead first");
      const second = coordinator.submit("@lead second");
      const results = await Promise.all([first, second]);

      expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
      expect(pi.calls.filter((call) => call.op === "prompt").map((call) => call.agentId)).toEqual(["lead", "lead"]);
      const messages = (await store.readMessages()).messages;
      expect(messages.filter((message) => message.kind === "user").map((message) => message.text)).toEqual(["@lead first", "@lead second"]);
      expect(messages.filter((message) => message.kind === "agent").map((message) => message.text)).toEqual(["first\nDONE", "second\nDONE"]);
    });
  });

  test("a pane is not opened until the stream file exists", async () => {
    // The [started] line is the first thing that creates output.log. If the pane
    // starts `tail -f` before it lands, tail exits and the pane is a dead shell.
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new AgentStream(async (path, data) => {
      if (String(data).includes("[started]")) {
        events.push("started-pending");
        await gate;
        events.push("started-written");
      }
      await appendFile(path, String(data), "utf8");
    });

    await harness({ task: undefined, agentStream: stream }, async ({ dir, coordinator, pi, panes }) => {
      const open = panes.openAgentPane.bind(panes);
      panes.openAgentPane = async (spec) => {
        events.push("pane-open");
        return open(spec);
      };

      const booting = coordinator.boot();
      await waitUntil(() => events.includes("started-pending"));
      release();
      await booting;

      // The file must exist before the tail starts, for every agent, not once.
      expect(events.filter((e) => e === "started-written")).toHaveLength(2);
      expect(events.filter((e) => e === "pane-open")).toHaveLength(2);
      for (let i = 0; i < events.length; i += 1) {
        if (events[i] !== "pane-open") continue;
        const writtenBefore = events.slice(0, i).filter((e) => e === "started-written").length;
        expect(writtenBefore).toBeGreaterThan(0);
      }
      expect(await readFile(join(dir, "agents", "lead", "output.log"), "utf8")).toContain("[started]");
      void pi;
    });
  });

  test("a failed [started] write still opens the pane and reports once", async () => {
    const stream = new AgentStream(async (path, data) => {
      if (String(data).includes("[started]") && String(path).includes("lead")) {
        throw new Error("disk full");
      }
      await appendFile(path, String(data), "utf8");
    });

    await harness({ task: undefined, agentStream: stream }, async ({ coordinator, pi, panes, telemetry }) => {
      await coordinator.boot();

      // A missing header is not a reason to refuse the room.
      expect(pi.calls.filter((c) => c.op === "spawn")).toHaveLength(2);
      expect(panes.calls.filter((c) => c.op === "open")).toHaveLength(2);
      const failures = telemetry.errors.filter((e) => e.includes("agent pane write"));
      expect(failures).toHaveLength(1);
    });
  });

  test("launch_guard: refuse stops boot before any agent spawns or pane opens", async () => {
    const repo = await gitRepo();
    try {
      await harness({ task: undefined, cwd: repo, launchGuard: "refuse" }, async ({ dir, coordinator, pi, panes }) => {
        const resolved = await realpath(repo);
        await expect(coordinator.boot()).rejects.toThrow(
          new RegExp(`${resolved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is the git repository root \\(branch (main|master)\\)`),
        );
        expect(pi.calls.filter((c) => c.op === "spawn")).toEqual([]);
        expect(panes.calls).toEqual([]);
        // A refusal leaves no room files behind either: nothing is written before the check.
        expect(await readFile(join(dir, "state.json"), "utf8").catch(() => null)).toBeNull();
        expect(await readFile(join(dir, "telemetry.jsonl"), "utf8").catch(() => null)).toBeNull();
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("the default launch_guard warns once, names the directory, and starts", async () => {
    const repo = await gitRepo();
    try {
      await harness({ task: undefined, cwd: repo }, async ({ coordinator, pi, telemetry }) => {
        await coordinator.boot();

        const guardWarns = telemetry.warns.filter((w) => w.msg.includes("git repository root"));
        expect(guardWarns).toHaveLength(1);
        expect(guardWarns[0].attrs?.dir).toBe(await realpath(repo));
        expect(guardWarns[0].attrs?.branch).toMatch(/^(main|master)$/);
        expect(pi.calls.filter((c) => c.op === "spawn")).toHaveLength(2);
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("launch_guard: off starts in a repo root with no record", async () => {
    const repo = await gitRepo();
    try {
      await harness({ task: undefined, cwd: repo, launchGuard: "off" }, async ({ coordinator, telemetry }) => {
        await coordinator.boot();
        expect(telemetry.warns.filter((w) => w.msg.includes("git repository root"))).toEqual([]);
      });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("boot outside a git repository is silent", async () => {
    await harness({ task: undefined }, async ({ coordinator, telemetry }) => {
      await coordinator.boot();
      expect(telemetry.warns.filter((w) => w.msg.includes("git repository root"))).toEqual([]);
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

  test("shutdown starts every agent's stop before it waits for any of them", async () => {
    // Ctrl-C reaches the children as SIGINT too, and the coordinator's handler runs
    // first (measured: probes/sigint-order). A stop that is only flagged once the
    // previous agent finished leaves the later child to be reported as a crash (#51).
    await harness({ task: "do the work" }, async ({ coordinator, pi }) => {
      const started: string[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stop = pi.shutdown.bind(pi);
      pi.shutdown = async (agentId: string) => {
        started.push(agentId);
        if (started.length === 1) await gate;
        return stop(agentId);
      };

      await coordinator.boot();
      const shuttingDown = coordinator.shutdown();
      await waitUntil(() => started.length === 2);
      release();
      await shuttingDown;

      expect(started.sort()).toEqual(["dev1", "lead"]);
    });
  });

  test("shutdown closes the panes it opened", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, pi, panes }) => {
      pi.script("lead", [{ lastText: "done\nDONE" }]);
      await coordinator.boot();
      expect(panes.calls.filter((c) => c.op === "open")).toHaveLength(2);

      await coordinator.shutdown();

      const closed = panes.calls.filter((c) => c.op === "close").map((c) => c.paneId).sort();
      expect(closed).toEqual(["agent-dev1", "agent-lead"]);
    });
  });

  test("a pane close that throws still flushes telemetry and exits 0", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, pi, panes }) => {
      pi.script("lead", [{ lastText: "done\nDONE" }]);
      await coordinator.boot();
      panes.failOn("close", new Error("close boom"), 2);

      const order: string[] = [];
      const shutdown = createShutdown({
        shutdown: () => coordinator.shutdown(),
        flush: async () => {
          order.push("flush");
        },
        exit: (code) => order.push(`exit:${code}`),
      });
      await shutdown();

      expect(order).toEqual(["flush", "exit:0"]);
    });
  });

  test("shutdown during a running turn leaves a terminal status", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, pi, store }) => {
      pi.script("lead", [{ hold: true }]);
      void coordinator.boot();
      // Wait for the lead's turn to be in flight; sleeping a fixed time races on a fast machine.
      for (let i = 0; i < 500 && !pi.calls.some((c) => c.op === "waitForSettled"); i++) await Bun.sleep(1);
      expect(pi.calls.some((c) => c.op === "waitForSettled")).toBe(true);

      await coordinator.shutdown();

      const state = await store.readState();
      expect(state!.status).not.toBe("active");
      expect(state!.status).toBe("idle");
    });
  });

  test("a stop during a turn cancels it instead of reporting a failure", async () => {
    await harness({ task: undefined }, async ({ coordinator, pi, store }) => {
      pi.script("lead", [{ hold: true }]);
      await coordinator.boot();
      const running = coordinator.submit("@lead start the work");
      await waitUntil(() => pi.calls.some((c) => c.op === "prompt"));

      await coordinator.shutdown();
      await running;

      expect((await store.readMessages()).messages.filter((m) => m.text.includes("pi process for lead"))).toEqual([]);
      const state = await store.readState();
      expect(state!.status).toBe("idle");
      expect(state!.chain).toBeNull();
    });
  });

  test("shutdown keeps a halted room halted", async () => {
    await harness({ task: "do the work" }, async ({ coordinator, pi, store }) => {
      pi.script("lead", [{ error: new Error("turn boom") }]);
      await coordinator.boot();
      expect((await store.readState())!.status).toBe("halted");

      await coordinator.shutdown();
      expect((await store.readState())!.status).toBe("halted");
    });
  });

  test("a failed boot shuts down started agents and closes their panes", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi, panes }) => {
      // The lead spawns; the second spawn rejects, via the fake's failure knob.
      pi.failOn("spawn", new Error("spawn boom"), 1, 1);
      await expect(coordinator.boot()).rejects.toThrow("spawn boom");

      // The agent that did start is shut down, and its pane is closed.
      expect(pi.calls.filter((c) => c.op === "shutdown").map((c) => c.agentId)).toEqual(["lead"]);
      expect(panes.calls.filter((c) => c.op === "close").map((c) => c.paneId)).toEqual(["agent-lead"]);
      expect(panes.isClosed("agent-lead")).toBe(true);

      // The failure is visible in the persisted state, not hidden.
      const state = await store.readState();
      expect(state!.agents.lead.status).toBe("exited");
      expect(state!.agents.dev1.status).toBe("error");
    });
  });

  test("the agent pane tails readable prose, while log.jsonl keeps the JSON records", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, pi, panes }) => {
      await coordinator.boot();
      // The pane must tail the readable file, not the JSON log.
      const opened = panes.calls.find((c) => c.op === "open");
      expect(await readFile((opened!.payload as { command: string[] }).command[1], "utf8")).toContain("output.log");
      pi.script("lead", [{ deltas: ["Answered ", "in ", "prose."], lastText: "Answered in prose.\nDONE" }]);
      await coordinator.submit("@lead go");

      // The coordinator does not await the pane write, so poll rather than sleep.
      const stream = await waitForText(join(dir, "agents", "lead", "output.log"), "Answered in prose.");
      expect(stream).toContain("Answered in prose.");
      expect(stream).not.toContain("{");
      expect(stream).not.toContain("delta");
      // The machine record is unchanged: one JSON line per event.
      const log = await readFile(join(dir, "agents", "lead", "log.jsonl"), "utf8");
      expect(log.trim().split("\n")[0]).toStartWith('{"ts":');
      expect(log).toContain('"event":"delta"');
    });
  });

  test("a line typed in an agent pane becomes a public message to that agent", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, store, pi, panes }) => {
      await coordinator.boot();
      const inbox = join(dir, "agents", "dev1", "inbox");
      // The pane command the writable pane runs.
      const opened = panes.calls.filter((c) => c.op === "open");
      const scripts = await Promise.all(opened.map((c) => readFile((c.payload as { command: string[] }).command[1], "utf8")));
      expect(scripts.some((s) => s.includes(inbox) && s.includes("output.log"))).toBe(true);

      pi.script("dev1", [{ lastText: "looking now" }]);
      await appendFile(inbox, "check the parser\n", "utf8");

      const msg = await waitForMessage(store, (m) => m.text === "@dev1 check the parser");
      expect(msg.kind).toBe("user");
      expect(msg.from).toBe("supervisor");
      expect(msg.mentions).toEqual(["dev1"]);

      // The message is appended before dispatch, so wait for the turn it starts.
      await waitUntil(() => pi.calls.some((c) => c.op === "prompt"));
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1"]);

      // Only the lead ingests it, and dev1's reply is pushed to the lead in turn.
      await waitUntil(() => pi.calls.some((c) => c.op === "pushContext"));
      const pushed = pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId);
      expect(new Set(pushed)).toEqual(new Set(["lead"]));
    });
  });

  test("a no-mention message leaves the room idle with no chain", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      const result = await coordinator.submit("just a status update");

      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(0);
      const state = await store.readState();
      expect(state!.status).toBe("idle");
      expect(state!.chain).toBeNull();
      expect(pi.calls.filter((c) => c.op === "prompt")).toEqual([]);
    });
  });

  test("a handle typed into a pane does not dispatch that agent", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, store, pi }) => {
      await coordinator.boot();
      const inbox = join(dir, "agents", "dev1", "inbox");

      pi.script("dev1", [{ lastText: "on it" }]);
      // @lead exists in this room and is not the pane's agent: without the pin it runs.
      await appendFile(inbox, "@lead look at this\n", "utf8");

      // The text is recorded as typed, after the implied handle (#40).
      const msg = await waitForMessage(store, (m) => m.text === "@dev1 @lead look at this");
      expect(msg.from).toBe("supervisor");
      expect(msg.mentions).toEqual(["dev1", "lead"]);

      await waitUntil(() => pi.calls.some((c) => c.op === "prompt"));
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1"]);

      // Everyone else still sees it, as context: the lead is pushed before the turn runs.
      const pushes = (): string[] => pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId);
      expect(pushes()[0]).toBe("lead");
    });
  });

  test("an unknown handle typed into a pane is still reported", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, store, pi }) => {
      await coordinator.boot();
      pi.script("dev1", [{ lastText: "ok" }]);
      await appendFile(join(dir, "agents", "dev1", "inbox"), "@nobody hi\n", "utf8");

      // The notice is appended before dispatch, so wait for the turn it starts.
      await waitForMessage(store, (m) => m.kind === "notice" && m.text.includes("@nobody"));
      await waitUntil(() => pi.calls.some((c) => c.op === "prompt"));
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1"]);
    });
  });

  test("a failing inbox read is reported once and the room keeps working", async () => {
    let reads = 0;
    const read = async (path: string): Promise<string> => {
      reads += 1;
      if (String(path).includes("dev1")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return readFile(path, "utf8");
    };

    await harness({ task: undefined, inboxRead: read }, async ({ coordinator, store, pi, telemetry }) => {
      await coordinator.boot();

      // Several polls must pass before the "once" claim means anything.
      await waitUntil(() => reads >= 6);
      const failures = telemetry.warns.filter((w) => w.msg.includes("pane inbox read"));
      expect(failures).toHaveLength(1);
      expect(failures[0].attrs?.agentId).toBe("dev1");
      expect(String(failures[0].attrs?.error)).toContain("permission denied");

      // A dead inbox is not a dead room: the chat pane still routes.
      pi.script("lead", [{ lastText: "still here\nDONE" }]);
      const result = await coordinator.submit("@lead ping");
      expect(result.status).toBe("completed");
      expect((await store.readMessages()).messages.some((m) => m.text === "still here\nDONE")).toBe(true);
    });
  });

  test("a missing inbox file produces no record", async () => {
    let reads = 0;
    const read = async (): Promise<string> => {
      reads += 1;
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    };
    await harness({ task: undefined, inboxRead: read }, async ({ coordinator, telemetry }) => {
      await coordinator.boot();
      // Proof that polls happened, rather than a sleep long enough to hope so.
      await waitUntil(() => reads >= 6);
      expect(telemetry.warns.filter((w) => w.msg.includes("pane inbox read"))).toEqual([]);
    });
  });

  test("pane_writable: false gives a read-only pane and ignores the inbox", async () => {
    let reads = 0;
    const read = async (path: string): Promise<string> => {
      reads += 1;
      return readFile(path, "utf8");
    };
    await harness({ task: undefined, dev1Writable: false, inboxRead: read }, async ({ dir, coordinator, store, pi, panes }) => {
      await coordinator.boot();
      const opened = panes.calls.filter((c) => c.op === "open");
      const scripts = await Promise.all(opened.map((c) => readFile((c.payload as { command: string[] }).command[1], "utf8")));
      expect(scripts.some((s) => s.includes("read-only - type in the chat pane"))).toBe(true);

      // Even if a line lands in the file, nothing is dispatched: wait for the
      // inbox to be polled at least once more, which is what a sleep was standing in for.
      const before = reads;
      await appendFile(join(dir, "agents", "dev1", "inbox"), "should be ignored\n", "utf8");
      await waitUntil(() => reads > before);
      expect((await store.readMessages()).messages.filter((m) => m.kind === "user")).toEqual([]);
      expect(pi.calls.filter((c) => c.op === "prompt")).toEqual([]);
    });
  });

  test("a tool call reaches the pane as one [tool] line", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, pi }) => {
      await coordinator.boot();
      // The settled text is deliberately different from anything streamed, so the
      // order of tool line and settled text is observable.
      pi.script("lead", [
        { tools: [{ name: "bash", args: { command: "ls" } }], lastText: "settled after the tool\nDONE" },
      ]);
      await coordinator.submit("@lead go");

      const stream = await waitForText(join(dir, "agents", "lead", "output.log"), "settled after the tool");
      expect(stream).toContain('[tool] bash {"command":"ls"}\n');
      expect(stream).not.toContain("tool_execution_start");
      expect(stream.indexOf("[tool] bash")).toBeLessThan(stream.indexOf("settled after the tool"));
    });
  });

  test("an agent error reaches the pane as one line, not a JSON record", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, pi }) => {
      await coordinator.boot();
      pi.script("lead", [{ error: new Error("provider exploded") }]);
      await coordinator.submit("@lead go");

      const stream = await waitForText(join(dir, "agents", "lead", "output.log"), "[error] provider exploded");
      expect(stream).toContain("[error] provider exploded\n");
    });
  });

  test("a failing agent log write is reported once and does not crash the room", async () => {
    await harness({ task: undefined }, async ({ dir, coordinator, store, pi, telemetry }) => {
      await coordinator.boot();

      // Point the agent log at a directory so every append fails.
      const logPath = join(dir, "agents", "lead", "log.jsonl");
      await rm(logPath, { force: true });
      await mkdir(logPath, { recursive: true });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        pi.script("lead", [{ deltas: ["a", "b", "c"], lastText: "done\nDONE" }]);
        const result = await coordinator.submit("@lead go");
        expect(result.status).toBe("completed");
        await coordinator.shutdown();
        await waitUntil(() => telemetry.errors.filter((m) => m === "agent log write failed").length === 1);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(unhandled).toEqual([]);
      expect(telemetry.errors.filter((m) => m === "agent log write failed")).toHaveLength(1);
    });
  });

  test("persisting state does not re-read the message log", async () => {    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "done\nDONE" }]);
      pi.script("dev1", [{ lastText: "@lead ok" }]);

      let reads = 0;
      const realRead = store.readMessages.bind(store);
      store.readMessages = async () => {
        reads += 1;
        return realRead();
      };

      await coordinator.submit("@lead build it");

      expect(reads).toBe(0);
    });
  });

  test("lastMessageId tracks the newest appended message", async () => {
    await harness({ task: undefined }, async ({ coordinator, store, pi }) => {
      await coordinator.boot();
      pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "done\nDONE" }]);
      pi.script("dev1", [{ lastText: "@lead ok" }]);

      await coordinator.submit("@lead build it");
      await coordinator.shutdown();

      const messages = (await store.readMessages()).messages;
      expect(messages.at(-1)!.id).toBe((await store.readState())!.lastMessageId!);
    });
  });
});
