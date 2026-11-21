import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLoop, wrapUpPrompt, CONCLUDE_PROMPT, hasDoneSignal, hasAck } from "../src/turn-loop";
import { RoomStore } from "../src/store";
import type { Telemetry } from "../src/telemetry";
import { RecordingTelemetry } from "./recording-telemetry";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import type { AgentSpec, LoadedConfig } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };
const dev2: AgentSpec = { id: "dev2", handle: "@dev2", role: "dev" };
const reviewer: AgentSpec = { id: "reviewer", handle: "@reviewer", role: "review" };

function makeConfig(
  maxHops = 12,
  agents: AgentSpec[] = [dev1, dev2, reviewer],
  ackScope: "lead" | "anyone" = "lead",
  dispatchScope: "anyone" | "lead" = "anyone",
): LoadedConfig {
  const allAgents = [lead, ...agents];
  return {
    config: {
      name: "room",
      room_dir: "/r",
      definition_of_done: "things done",
      max_hops: maxHops,
      turn_timeout_ms: 300_000,
      ack_scope: ackScope,
    dispatch_scope: dispatchScope,
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

async function harness(
  fn: (h: Harness) => Promise<void>,
  opts?: {
    maxHops?: number;
    agents?: AgentSpec[];
    turnTimeoutMs?: number;
    ackScope?: "lead" | "anyone";
    dispatchScope?: "anyone" | "lead";
  },
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-loop-"));
  try {
    const config = makeConfig(opts?.maxHops, opts?.agents, opts?.ackScope, opts?.dispatchScope);
    const store = new RoomStore(dir);
    const pi = new FakePiAgentClient();
    const telemetry = new RecordingTelemetry();
    const loop = new TurnLoop({ config, store, pi, telemetry, turnTimeoutMs: opts?.turnTimeoutMs });

    for (const a of config.allAgents) await pi.spawn(a, { cwd: dir });

    let n = 0;
    const h: Harness = {
      loop,
      store,
      pi,
      telemetry,
      msgs: async () =>
        (await store.readMessages()).messages.map((m) => ({
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
  test("no mention activates nobody; every agent gets the text as context", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      const result = await loop.submit("just a status update");

      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(0);
      expect(pi.calls.filter((c) => c.op === "prompt")).toEqual([]);
      expect(pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId)).toEqual([
        "lead",
        "dev1",
        "dev2",
        "reviewer",
      ]);

      const m = await msgs();
      expect(m.map((x) => `${x.kind}:${x.from}`)).toEqual(["user:supervisor", "notice:room"]);
      expect(m[1].text).toBe("no agent addressed; 4 agents have the message as context");
      expect(m[1].hop).toBe(0);
    });
  });

  test("explicit targets win over the text's mentions", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("dev1", [{ lastText: "handled" }]);

      // A pane line: the text keeps the handle the supervisor typed, routing ignores it.
      await loop.submit("@lead @dev1 please look", "user", ["dev1"]);

      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1"]);
      const m = await msgs();
      expect(m[0].text).toBe("@lead @dev1 please look");
      expect(m[0].mentions).toEqual(["lead", "dev1"]);
    });
  });

  test("dispatch_scope: lead — a non-lead's mention is context, not a dispatch", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      // The live run: dev1's report said "@reviewer count is 28", and the reviewer started
      // verifying on its own initiative mid-report. A report is not an assignment.
      // dev1 reports and names the reviewer in the same message, exactly as the live run did.
      pi.script("dev1", [{ lastText: "Got it: tally\n@reviewer count is 28, ready\n@lead done" }]);
      pi.script("lead", [{ lastText: "Got it: ok\nDONE" }]);

      await loop.submit("@dev1 tally the docs", "user");

      const prompted = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      // The report reaches the lead; the reviewer is named but not dispatched.
      expect(prompted).toEqual(["dev1", "lead"]);
      // The reviewer still sees it — as context, which is what a report is worth to it.
      expect(pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId)).toContain("reviewer");
    }, { dispatchScope: "lead" });
  });

  test("dispatch_scope: anyone (the default) — a peer's mention still starts a turn", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("dev1", [{ lastText: "Got it: tally\n@reviewer count is 28, ready" }]);
      pi.script("reviewer", [{ lastText: "Got it: verify\ncount matches" }]);

      await loop.submit("@dev1 tally the docs", "user");

      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["dev1", "reviewer"]);
    });
  });

  test("dispatch_scope: lead — a report reaches the lead even with no mention at all", async () => {
    await harness(async ({ loop, pi }) => {
      // The live run: @reviewer replied with its evidence and "go" but never wrote "@lead", so
      // under `lead` nobody was dispatched and the room went quiet with no DONE.
      pi.script("dev1", [{ lastText: "Got it: tally\n28 rows\n@lead done" }]);
      pi.script("lead", [{ lastText: "Got it: check\n@reviewer verify the count" }, { lastText: "ok\nDONE" }]);
      pi.script("reviewer", [{ lastText: "Got it: verify\n28 rows, denominator 28; go" }]);

      await loop.submit("@dev1 tally the docs", "user");

      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual([
        "dev1",
        "lead",
        "reviewer",
        "lead",
      ]);
    }, { dispatchScope: "lead" });
  });

  test("the lead's mention dispatches the agent it names under either scope", async () => {
    for (const dispatchScope of ["anyone", "lead"] as const) {
      await harness(async ({ loop, pi }) => {
      pi.script("dev1", [{ lastText: "Got it: tally\n28 rows\n@lead done" }]);
      pi.script("lead", [{ lastText: "Got it: check\n@reviewer verify the count" }, { lastText: "count confirmed\nDONE" }]);
      pi.script("reviewer", [{ lastText: "Got it: verify\ncount is 28\n@lead go" }]);

      await loop.submit("@dev1 tally the docs", "user");

      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual([
        "dev1",
        "lead",
        "reviewer",
        "lead",
      ]);
      }, { dispatchScope });
    }
  });

  test("a startup task targets the lead even without a mention", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "all done\nDONE" }]);
      const result = await loop.submit("Design and document a small service.", "startup_task");

      expect(result.hopCount).toBe(1);
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead"]);
      const prompt = pi.calls.find((c) => c.op === "prompt");
      expect((prompt!.payload as { streamingBehavior: string }).streamingBehavior).toBe("followUp");
      const m = await msgs();
      expect(m.map((x) => `${x.kind}:${x.from}`)).toEqual(["startup_task:room", "agent:lead"]);
    });
  });

  test("a startup task that names agents dispatches the lead, and gives the named agents the text as context", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "understood\nDONE" }]);

      // A boot directive is about agents, so it names them. Naming them must not
      // dispatch them: the lead decides who works (#57).
      const result = await loop.submit("Dispatch @dev1 first, then @reviewer verifies.", "startup_task");

      expect(result.hopCount).toBe(1);
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead"]);
      // everyone who was not dispatched gets the directive as context (§6.6), named or not
      expect(pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId).sort()).toEqual(["dev1", "dev2", "reviewer"]);
      const m = await msgs();
      expect(m[0].mentions).toEqual(["dev1", "reviewer"]);
      expect(m.map((x) => `${x.kind}:${x.from}`)).toEqual(["startup_task:room", "agent:lead"]);
    });
  });

  test("a direct message answered without an acknowledgement produces one notice naming the agent", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      // the human addresses the lead directly, so the lead acknowledges first: only dev1 skips it
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 check the footer" }]);
      pi.script("dev1", [{ lastText: "checked the footer, it is stale" }]);

      await loop.submit("@lead start", "user");

      const m = await msgs();
      const notices = m.filter((x) => x.kind === "notice" && x.text.includes("Got it:"));
      expect(notices.length).toBe(1);
      expect(notices[0]!.text).toContain("@dev1");
    });
  });

  test("an acknowledgement is the reply's own first line, and silences the notice", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 check the footer" }]);
      pi.script("dev1", [{ lastText: "\nGot it: check the footer for staleness\nchecked, it is stale" }]);

      await loop.submit("@lead start", "user");

      const m = await msgs();
      expect(m.filter((x) => x.kind === "notice" && x.text.includes("Got it:")).length).toBe(0);
      expect(m.find((x) => x.kind === "agent" && x.from === "dev1")!.text).toContain("Got it: check the footer");
    });
  });

  test("a broadcast needs no acknowledgement, and a mention inside one still dispatches", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@all stand by" }]);
      pi.script("dev1", [{ lastText: "standing by" }]);
      pi.script("dev2", [{ lastText: "standing by too" }]);
      pi.script("reviewer", [{ lastText: "standing by as well" }]);

      await loop.submit("@lead start", "user");

      const m = await msgs();
      expect(m.filter((x) => x.kind === "notice" && x.text.includes("Got it:")).length).toBe(0);
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual([
        "lead",
        "dev1",
        "dev2",
        "reviewer",
      ]);
    });
  });

  test("naming two agents needs no acknowledgement from either", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 @dev2 compare notes" }]);
      pi.script("dev1", [{ lastText: "compared" }]);
      pi.script("dev2", [{ lastText: "compared too" }]);

      await loop.submit("@lead start", "user");

      expect((await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:")).length).toBe(0);
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead", "dev1", "dev2"]);
    });
  });

  test("the acknowledgement paragraph is required, and a mention inside it still dispatches", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 check it" }, { lastText: "noted\nDONE" }]);
      // quoting the sender in the acknowledgement is exactly what the contract forbids: the
      // router cannot tell a quotation from a hand-off, so it dispatches
      pi.script("dev1", [{ lastText: "Got it: @lead sent me the footer\nchecked" }]);

      await loop.submit("@lead start", "user");

      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead", "dev1", "lead"]);
      // the lead's second turn answers a peer's mention, which the default scope does not police
      expect((await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:")).length).toBe(0);
    });
  });

  test("dispatch_scope: lead — a peer mention is context, so no acknowledgement is owed", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 hand it on" }, { lastText: "ok\nDONE" }]);
      // dev1 mentions a peer; under `lead` that is a note to the room, not an assignment.
      pi.script("dev1", [{ lastText: "Got it: hand it on\n@dev2 take it" }]);

      await loop.submit("@lead start", "user");

      const ackNotices = (await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:"));
      expect(ackNotices.length).toBe(0);
      // the report goes back to the lead; @dev2 is never dispatched
      expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead", "dev1", "lead"]);
    }, { dispatchScope: "lead" });
  }, 20_000);

  test("ack_scope: anyone makes a peer mention owe an acknowledgement too", async () => {
    await harness(
      async ({ loop, pi, msgs }) => {
        pi.script("lead", [{ lastText: "Got it: start\n@dev1 hand it on" }, { lastText: "ok\nDONE" }]);
        // dev1 reports back to the lead without an acknowledgement line.
        pi.script("dev1", [{ lastText: "handed on\n@lead done" }]);

        await loop.submit("@lead start", "user");

        const ackNotices = (await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:"));
        // both edges are governed under `anyone`: the lead's assignment and dev1's report back
        expect(ackNotices.map((n) => n.text.split(" ")[0])).toEqual(["@dev1", "@lead"]);
        expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead", "dev1", "lead"]);
      },
      { ackScope: "anyone" },
    );
  }, 20_000);

  test("a human's direct message to the lead needs an acknowledgement as well", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "working on it" }]);

      await loop.submit("@lead wire the layout", "user");

      const notices = (await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:"));
      expect(notices.length).toBe(1);
      expect(notices[0]!.text).toContain("@lead");
    });
  });

  test("the startup task is a boot directive, so the lead owes it no acknowledgement", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "on it\nDONE" }]);

      await loop.submit("audit the docs and reply DONE", "startup_task");

      expect((await msgs()).filter((x) => x.kind === "notice" && x.text.includes("Got it:")).length).toBe(0);
      expect(pi.calls.filter((c) => c.op === "prompt").length).toBe(1);
    });
  });

  test("a reply with no mention ends the chain idle rather than halting", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [{ lastText: "@dev1 take a look" }]);
      pi.script("dev1", [{ lastText: "looked at it, nothing to report" }]);

      const result = await loop.submit("@lead start", "user");

      expect(result.status).toBe("completed");
      const kinds = (await msgs()).map((x) => x.kind);
      expect(kinds).not.toContain("hop_limit_reached");
    });
  });

  test("a non-Error rejection still produces a readable notice", async () => {
    await harness(async ({ loop, pi, msgs, telemetry }) => {
      pi.script("lead", [{ error: { code: 42 } as unknown as Error }]);
      await loop.submit("@lead go");

      const notice = (await msgs()).find((x) => x.kind === "notice")!;
      expect(notice.text).toContain('{"code":42}');
      expect(telemetry.errors).toContain("agent turn failed");
    });
  });

  test("mention propagation: lead hands off, dev replies, lead closes with DONE", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.script("lead", [
        { lastText: "Got it: build it\n@dev1 implement it" },
        { lastText: "Got it: verify dev1's report\nverified\nDONE" },
      ]);
      pi.script("dev1", [{ lastText: "Got it: implement it\n@lead done, please verify" }]);

      const result = await loop.submit("@lead build it");
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

  test("a reply logs why it dispatched whom, so a double turn is attributable", async () => {
    await harness(async ({ loop, pi, telemetry }) => {
      pi.script("lead", [{ lastText: "Got it: start\n@dev1 and @reviewer both look" }]);

      await loop.submit("@lead start", "user");

      // The lead's reply is the one that names two agents; the record says so, with the queue.
      const dispatch = telemetry.infos.find((l) => l.msg === "dispatch" && l.attrs?.from === "lead");
      expect(dispatch?.attrs?.queued).toEqual(["dev1", "reviewer"]);
      expect(dispatch?.attrs?.targets).toEqual(["dev1", "reviewer"]);
    });
  });

  test("a self-mention does not re-queue the author", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "@dev1 take it, report to @lead when green" }]);
      pi.script("dev1", [{ lastText: "finished, nothing to add" }]);

      const result = await loop.submit("@lead build it");
      expect(result.status).toBe("completed");
      // The lead's own handle is in the reply; that must not send the work back to it.
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["lead", "dev1"]);
    });
  });

  test("a reply that mentions only its own author queues nobody", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "I will keep @lead posted" }]);

      const result = await loop.submit("@lead go");
      expect(result.status).toBe("completed");
      const prompts = pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId);
      expect(prompts).toEqual(["lead"]);
    });
  });

  test("a turn that times out still hands on what it had written", async () => {
    await harness(
      async ({ loop, pi, msgs }) => {
        // The live failure: the lead printed its assignment, then hit the timeout, so the agent it
        // named was never dispatched and the room went quiet mid-chain.
        pi.script("lead", [{ deltas: ["Got it: start\n@dev1 tally the docs\n"], hold: true }]);
        // dev1 names nobody, so the chain ends after it and the test cannot hang on a loop.
        pi.script("dev1", [{ lastText: "Got it: tally\n28 rows" }]);

        await loop.submit("@lead start", "user");

        expect(pi.calls.filter((c) => c.op === "prompt").map((c) => c.agentId)).toEqual(["lead", "dev1"]);
        const notices = (await msgs()).filter((m) => m.kind === "notice").map((m) => m.text);
        expect(notices.some((t) => t.includes("settle timeout"))).toBe(true);
        // the text that did stream is the record of the turn, not an empty message
        const leadMsg = (await msgs()).find((m) => m.kind === "agent" && m.from === "lead");
        expect(leadMsg?.text).toContain("@dev1 tally the docs");
      },
      { turnTimeoutMs: 300 },
    );
  }, 20_000);

  test("a turn timeout is reported as a timeout, not a failure", async () => {
    await harness(async ({ loop, pi, msgs }) => {
      pi.failOn("waitForSettled", new Error("settle timeout after 5000ms"));

      const result = await loop.submit("@lead go");
      expect(result.status).toBe("halted");
      const notice = (await msgs()).find((m) => m.kind === "notice")!;
      expect(notice.text).toBe("agent lead: settle timeout after 5000ms");
      expect(notice.text).not.toContain("failed");
    });
  });

  test("the room's turn timeout reaches the client", async () => {
    await harness(
      async ({ loop, pi }) => {
        pi.script("lead", [{ lastText: "ok\nDONE" }]);
        await loop.submit("@lead go");
        expect(pi.calls.find((c) => c.op === "waitForSettled")!.payload).toBe(5000);
      },
      { turnTimeoutMs: 5000 },
    );
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
      const result = await loop.submit("@lead go");
      expect(result.status).toBe("completed");
      expect(result.hopCount).toBe(2);
    });
  });

  test("max_hops: lead gets the wrap-up prompt, dispatched agents get one concluding turn, then halt", async () => {
    await harness(
      async ({ loop, pi, msgs }) => {
        pi.script("lead", [{ lastText: "@dev1 work" }, { lastText: "@dev1 wrap up" }]);
        pi.script("dev1", [{ lastText: "@lead check" }, { lastText: "summary of work" }]);

        const result = await loop.submit("@lead start");

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
        const result = await loop.submit("@lead start");
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

        const result = await loop.submit("@lead start");
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

  test("each context push leaves one trace record with the agent and the length", async () => {
    const dev1Reply = "no mentions here";
    await harness(async ({ loop, pi, telemetry }) => {
      pi.script("dev1", [{ lastText: dev1Reply }]);
      const text = "@dev1 just this one";

      await loop.submit(text);

      const pushes = pi.calls.filter((c) => c.op === "pushContext").map((c) => c.agentId);
      const traces = telemetry.infos.filter((i) => i.msg === "context.push");
      expect(pushes.length).toBeGreaterThan(0);
      expect(traces.map((t) => t.attrs?.agentId)).toEqual(pushes);
      // Two texts get pushed: the user's, then dev1's reply.
      expect([...new Set(traces.map((t) => t.attrs?.chars))].sort()).toEqual([dev1Reply.length, text.length].sort());
    });
  });

  test("human input starts a fresh chain each time", async () => {
    await harness(async ({ loop, pi }) => {
      pi.script("lead", [{ lastText: "one\nDONE" }, { lastText: "two\nDONE" }]);
      const first = await loop.submit("@lead first");
      const second = await loop.submit("@lead second");
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
      const result = await loop.submit("@lead build it");
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
      const result = await loop.submit("@lead go");
      expect(result.status).toBe("halted");
      const m = await msgs();
      const notice = m.find((x) => x.kind === "notice");
      expect(notice).toBeDefined();
      expect(notice!.text).toContain("pi exploded");
    });
  });

  test("a failed context push is a notice, not a chain failure", async () => {
    await harness(async ({ loop, pi, msgs, telemetry }) => {
      pi.failOn("pushContext", new Error("bash rpc failed"), 99);
      pi.script("lead", [
        { lastText: "Got it: build it\n@dev1 go" },
        { lastText: "Got it: dev1's ok\nverified\nDONE" },
      ]);
      pi.script("dev1", [{ lastText: "Got it: go\n@lead ok" }]);

      const result = await loop.submit("@lead build it");

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
      await expect(loop.submit("@lead go")).rejects.toThrow("disk full");
      expect(telemetry.chainDeltas).toEqual([1, -1]);
    });
  });
});

describe("hasAck", () => {
  test("only a first line that says what was understood counts", () => {
    expect(hasAck("Got it: check the footer")).toBe(true);
    expect(hasAck("\n\nGot it: check the footer\nworking")).toBe(true);
    expect(hasAck("Got it:")).toBe(false);
    expect(hasAck("Got it:\nworking")).toBe(false);
    expect(hasAck("Sure.\nGot it: check the footer")).toBe(false);
    expect(hasAck(null)).toBe(false);
  });
});
