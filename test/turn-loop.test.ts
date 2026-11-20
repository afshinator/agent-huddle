import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLoop, wrapUpPrompt, CONCLUDE_PROMPT, hasDoneSignal } from "../src/turn-loop";
import { RoomStore } from "../src/store";
import { NoopTelemetry, type Span, type Telemetry } from "../src/telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };
const dev2: AgentSpec = { id: "dev2", handle: "@dev2", role: "dev" };
const reviewer: AgentSpec = { id: "reviewer", handle: "@reviewer", role: "review" };

function makeConfig(maxHops = 12, agents: AgentSpec[] = [dev1, dev2, reviewer]): LoadedConfig {
  const allAgents = [lead, ...agents];
  return {
    config: {
      name: "room",
      room_dir: "/r",
      definition_of_done: "things done",
      max_hops: maxHops,
      lead,
      agents,
    },
    sourcePath: "/r/team.yaml",
    allAgents,
    agentById: new Map(allAgents.map((a) => [a.id, a])),
  };
}

interface Harness {
  loop: TurnLoop;
  store: RoomStore;
  pi: FakePiAgentClient;
  telemetry: RecordingTelemetry;
  msgs: () => Promise<Array<{ kind: string; from: string; text: string; hop: number; mentions: string[] }>>;
}

/** Records the chain gauge and error logs so the counter can be asserted. */
class RecordingTelemetry implements Telemetry {
  chainDeltas: number[] = [];
  errors: string[] = [];

  span<T>(_name: string, _attrs: Record<string, unknown>, fn: (s: Span) => T): T {
    return fn({ addEvent() {}, setStatus() {} });
  }
  log(level: "info" | "warn" | "error", msg: string): void {
    if (level === "error") this.errors.push(msg);
  }
  counter(): void {}
  histogram(): void {}
  upDownCounter(name: string, _attrs?: Record<string, unknown>, delta = 1): void {
    if (name === "room.active_chains") this.chainDeltas.push(delta);
  }
}

async function harness(fn: (h: Harness) => Promise<void>, opts?: { maxHops?: number; agents?: AgentSpec[] }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-loop-"));
  try {
    const config = makeConfig(opts?.maxHops, opts?.agents);
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const telemetry = new RecordingTelemetry();
    const loop = new TurnLoop({ config, store, pi, telemetry });

    for (const a of config.allAgents) await pi.spawn(a, { cwd: dir });

    let n = 0;
    const h: Harness = {
      loop,
      store,
      pi,
      telemetry,
      msgs: async () =>
        (await store.readMessages()).map((m) => ({
          kind: m.kind,
          from: m.from,
          text: m.text,
          hop: m.hop,
          mentions: m.mentions,
        })),
    };
    void n;
    await fn(h);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("hasDoneSignal", () => {
  test("matches a line that is exactly DONE after trimming", () => {
    expect(hasDoneSignal("all good\nDONE")).toBe(true);
    expect(hasDoneSignal("  DONE  ")).toBe(true);
    expect(hasDoneSignal("DONE.")).toBe(false);
    expect(hasDoneSignal("almost DONE")).toBe(false);
    expect(hasDoneSignal(null)).toBe(false);
  });
});

describe("TurnLoop", () => {
  test("no mention routes to lead and completes when lead says DONE", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "all done\nDONE" }]);
      const result = await loop.submit("please build the thing");

      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(1);

      const m = await msgs();
      expect(m.map((x) => `${x.kind}:${x.from}`)).toEqual(["user:supervisor", "agent:lead"]);
      expect(m[1].text).toBe("all done\nDONE");
      expect(m[1].hop).toBe(1);
      const prompt = pi.calls.find((c) => c.op === "prompt");
      expect((prompt!.payload as { streamingBehavior: string }).streamingBehavior).toBe("followUp");
    });
  });

  test("mention propagation: lead hands off, dev replies, lead closes with DONE", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "@dev1 implement it" }, { lastText: "verified\nDONE" }]);
      pi.script("dev1", [{ lastText: "@lead done, please verify" }]);

      const result = await loop.submit("build it");
      expect(result.status).toBe("completed");

      const m = await msgs();
      expect(m.map((x) => x.from)).toEqual(["supervisor", "lead", "dev1", "lead"]);
      expect(m.map((x) => x.hop)).toEqual([0, 1, 2, 3]);
      // hop 1 lead message routed to dev1
      expect(m[1].mentions).toEqual(["dev1"]);
      expect((await pi.calls.filter((c) => c.op === "prompt")).map((c) => c.agentId)).toEqual([
        "lead",
        "dev1",
        "lead",
      ]);
    });
  });

  test("DONE from a non-lead agent does not complete the chain", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("dev1", [{ lastText: "DONE @lead" }]);
      pi.script("lead", [{ lastText: "not done yet\nDONE" }]);
      const result = await loop.submit("@dev1 go");
      expect(result.status).toBe("completed");
      // dev1's DONE did not end it: lead still ran (2 dispatches)
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["dev1", "lead"]);
    });
  });

  test("aborted turn halts with a notice and does not route partial mentions", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("dev1", [{ lastText: "@lead partial work", aborted: true }]);

      const result = await loop.submit("@dev1 work");

      expect(result.status).toBe("halted");
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1"]);
      const messages = await msgs();
      expect(messages.some((m) => m.kind === "notice" && m.text.includes("aborted"))).toBe(true);
      expect(messages.some((m) => m.from === "lead")).toBe(false);
    });
  });

  test("unknown-only mention emits a notice without dispatching", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      const result = await loop.submit("@nobody do this");
      expect(result.status).toBe("completed");
      expect(pi.calls.filter((call) => call.op === "prompt")).toEqual([]);
      expect((await msgs()).some((message) => message.kind === "notice" && message.text.includes("@nobody"))).toBe(true);
    });
  });

  test("agent reply with no mention ends the chain", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "@dev1 do it" }]);
      pi.script("dev1", [{ lastText: "finished, nothing else to say" }]);
      const result = await loop.submit("go");
      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(2);
    });
  });

  test("max_hops: lead gets the wrap-up prompt, dispatched agents get one concluding turn, then halt", async () => {
    await harness(
      async ({ loop, pi, msgs }) => {
        pi.script("lead", [{ lastText: "@dev1 work" }, { lastText: "@dev1 wrap up" }]);
        pi.script("dev1", [{ lastText: "@lead check" }, { lastText: "summary of work" }]);

        const result = await loop.submit("start");

        expect(result.status).toBe("halted");
        expect(result.hopCount).toBe(2);

        const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => ({
          agentId: c.agentId,
          message: (c.payload as { message: string }).message,
        }));

        // 2 counted hops, then lead wrap-up, then dev1 concluding turn
        expect(prompts.map((p) => p.agentId)).toEqual(["lead", "dev1", "lead", "dev1"]);
        expect(prompts[2].message).toBe(wrapUpPrompt(2));
        expect(prompts[3].message).toBe(CONCLUDE_PROMPT);

        const m = await msgs();
        const halt = m.find((x) => x.kind === "hop_limit_reached");
        expect(halt).toBeDefined();
        expect(halt!.from).toBe("room");
      },
      { maxHops: 2 },
    );
  });

  test("wrap-up does not increment hopCount", async () => {
    await harness(
      async ({ loop, pi }) => {
        pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "wrap" }]);
        pi.script("dev1", [{ lastText: "@lead ok" }, { lastText: "summary" }]);
        const result = await loop.submit("start");
        expect(result.hopCount).toBe(2);
      },
      { maxHops: 2 },
    );
  });

  test("DONE in the wrap-up turn completes instead of halting", async () => {
    await harness(
      async ({ loop, pi, msgs }) => {
        pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "closing\nDONE" }]);
        pi.script("dev1", [{ lastText: "@lead ok" }]);

        const result = await loop.submit("start");
        expect(result.status).toBe("completed");
        const m = await msgs();
        expect(m.find((x) => x.kind === "hop_limit_reached")).toBeUndefined();
      },
      { maxHops: 2 },
    );
  });

  test("unmentioned agents receive pushContext, targeted ones do not", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("dev1", [{ lastText: "no mentions here" }]);
      await loop.submit("@dev1 just this one");

      const pushed = pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId);
      expect(pushed).toContain("lead");
      expect(pushed).toContain("dev2");
      expect(pushed).toContain("reviewer");
      expect(pushed).not.toContain("dev1");
    });
  });

  test("human input starts a fresh chain each time", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "one\nDONE" }, { lastText: "two\nDONE" }]);
      const first = await loop.submit("first");
      const second = await loop.submit("second");
      expect(first.chainId).not.toBe(second.chainId);
      expect(second.hopCount).toBe(1);
    });
  });

  test("@all dispatches every agent in order", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "lead ack" }]);
      pi.script("dev1", [{ lastText: "dev1 ack" }]);
      pi.script("dev2", [{ lastText: "dev2 ack" }]);
      pi.script("reviewer", [{ lastText: "reviewer ack" }]);
      const result = await loop.submit("@all go");
      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(4);
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["lead", "dev1", "dev2", "reviewer"]);
    });
  });

  test("multiple @mentions in one message dispatch all named agents", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("dev1", [{ lastText: "dev1 ack" }]);
      pi.script("dev2", [{ lastText: "dev2 ack" }]);
      const result = await loop.submit("@dev1 @dev2 both go");
      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(2);
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["dev1", "dev2"]);
    });
  });

  test("lead delegating to two devs dispatches both", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "@dev1 @dev2 split the work" }]);
      pi.script("dev1", [{ lastText: "part A done" }]);
      pi.script("dev2", [{ lastText: "part B done" }]);
      const result = await loop.submit("build it");
      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(3);
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["lead", "dev1", "dev2"]);
    });
  });

  test("startup_task kind is recorded as startup_task from room", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "ok\nDONE" }]);
      await loop.submit("mission", "startup_task");
      const m = await msgs();
      expect(m[0].kind).toBe("startup_task");
      expect(m[0].from).toBe("room");
    });
  });

  test("a failing agent halts the chain with a notice", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ error: new Error("pi exploded") }]);
      const result = await loop.submit("go");
      expect(result.status).toBe("halted");
      const m = await msgs();
      const notice = m.find((x) => x.kind === "notice");
      expect(notice).toBeDefined();
      expect(notice!.text).toContain("pi exploded");
    });
  });

  test("a failed context push is a notice, not a chain failure", async () => {
    await harness(async ({ loop, pi, msgs, telemetry }) => {
      pi.pushContext = async () => {
        throw new Error("bash rpc failed");
      };
      pi.script("lead", [{ lastText: "@dev1 go" }, { lastText: "verified\nDONE" }]);
      pi.script("dev1", [{ lastText: "@lead ok" }]);

      const result = await loop.submit("build it");

      expect(result.status).toBe("completed");
      const m = await msgs();
      expect(m.map((x) => `${x.kind}:${x.from}`)).toEqual([
        "user:supervisor",
        "notice:room",
        "agent:lead",
        "agent:dev1",
        "agent:lead",
      ]);
      expect(m[1].text).toContain("dev1");
      expect(m[1].text).toContain("bash rpc failed");
      expect(telemetry.errors).toContain("context push failed");
    }, { agents: [dev1] });
  });

  test("the active_chains gauge is balanced when a chain throws", async () => {
    await harness(async ({ loop, store, telemetry }) => {
      store.appendMessage = async () => {
        throw new Error("disk full");
      };
      await expect(loop.submit("go")).rejects.toThrow("disk full");
      expect(telemetry.chainDeltas).toEqual([1, -1]);
    });
  });
});
