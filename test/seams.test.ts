import { test, expect, describe } from "bun:test";
import { FakePiAgentClient } from "../src/seams/pi-agent-client";
import type { SettledResult } from "../src/seams/pi-agent-client";
import { FakeHerdrPaneManager } from "../src/seams/herdr-pane-manager";
import type { AgentSpec } from "../src/config";

const lead: AgentSpec = { id: "lead", handle: "@lead", role: "lead" };
const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

describe("FakePiAgentClient", () => {
  test("spawn registers agent and returns process info", async () => {
    const c = new FakePiAgentClient("/tmp/base");
    const info = await c.spawn(lead, { cwd: "/work" });
    expect(info.pid).toBeGreaterThan(0);
    expect(info.sessionDir).toBe("/tmp/base/lead/sessions");
    expect(c.calls.filter((x) => x.op === "spawn")).toHaveLength(1);
  });

  test("prompt records call; scripted turn emits stream then settled", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });

    const deltas: string[] = [];
    const settled: SettledResult[] = [];
    c.on("stream", "dev1", (d) => deltas.push(d));
    c.on("settled", "dev1", (r) => settled.push(r));

    c.script("dev1", [{ deltas: ["hel", "lo"], lastText: "hello" }]);
    await c.prompt("dev1", { message: "hi" });
    const result = await c.waitForSettled("dev1", 1000);

    expect(deltas).toEqual(["hel", "lo"]);
    expect(settled).toEqual([{ aborted: false, lastText: "hello" }]);
    expect(result).toEqual({ aborted: false, lastText: "hello" });
    expect(c.calls.filter((x) => x.op === "prompt")).toHaveLength(1);
  });

  test("a scripted turn's tool calls arrive before its deltas, in order", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });

    const seen: string[] = [];
    c.on("tool", "dev1", (t) => seen.push(`tool:${t.name}`));
    c.on("stream", "dev1", (d) => seen.push(`delta:${d}`));

    c.script("dev1", [
      {
        tools: [
          { name: "bash", args: { command: "ls" } },
          { name: "read", args: { path: "a.ts" } },
        ],
        deltas: ["done"],
        lastText: "done",
      },
    ]);
    await c.prompt("dev1", { message: "look" });
    await c.waitForSettled("dev1", 1000);

    expect(seen).toEqual(["tool:bash", "tool:read", "delta:done"]);
  });

  test("each event delivers its own payload type", async () => {    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });

    const received: { settled?: SettledResult; stream?: string; error?: Error } = {};
    c.on("settled", "dev1", (r) => {
      received.settled = r;
    });
    c.on("stream", "dev1", (d) => {
      received.stream = d;
    });
    c.on("error", "dev1", (e) => {
      received.error = e;
    });

    c.script("dev1", [{ deltas: ["x"], lastText: "x" }]);
    await c.prompt("dev1", { message: "go" });
    await c.waitForSettled("dev1", 1000);
    expect(received.stream).toBe("x");
    expect(received.settled).toEqual({ aborted: false, lastText: "x" });
    expect(received.error).toBeUndefined();

    c.script("dev1", [{ error: new Error("boom") }]);
    await c.prompt("dev1", { message: "go" });
    await expect(c.waitForSettled("dev1", 1000)).rejects.toThrow("boom");
    expect(received.error).toBeInstanceOf(Error);
    expect(received.error!.message).toBe("boom");
  });

  test("pushContext records without starting a turn", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });
    await c.pushContext("dev1", "room message");
    expect(c.calls.filter((x) => x.op === "pushContext")).toHaveLength(1);
    expect(c.calls.filter((x) => x.op === "prompt")).toHaveLength(0);
  });

  test("failOn makes spawn, prompt, pushContext and shutdown reject", async () => {
    const c = new FakePiAgentClient();

    c.failOn("spawn", new Error("spawn refused"));
    await expect(c.spawn(dev1, { cwd: "/w" })).rejects.toThrow("spawn refused");

    await c.spawn(dev1, { cwd: "/w" });
    c.failOn("prompt", new Error("queue full"));
    await expect(c.prompt("dev1", { message: "go" })).rejects.toThrow("queue full");

    c.failOn("pushContext", new Error("host rejected"));
    await expect(c.pushContext("dev1", "ctx")).rejects.toThrow("host rejected");

    c.failOn("shutdown", new Error("already gone"));
    await expect(c.shutdown("dev1")).rejects.toThrow("already gone");

    // One knob fires once: the next call goes through.
    await c.prompt("dev1", { message: "go" });
    await c.waitForSettled("dev1", 1000);
    await c.shutdown("dev1");
    // A rejected call is not recorded: `calls` counts operations that happened.
    expect(c.calls.filter((x) => x.op === "prompt")).toHaveLength(1);
  });

  test("scripted error emits error event and rejects the settle", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });
    const errors: Error[] = [];
    c.on("error", "dev1", (e) => errors.push(e));
    c.script("dev1", [{ error: new Error("boom") }]);
    await c.prompt("dev1", { message: "x" });
    await expect(c.waitForSettled("dev1", 1000)).rejects.toThrow("boom");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  test("aborted turn reports aborted=true", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });
    c.script("dev1", [{ lastText: "partial", aborted: true }]);
    await c.prompt("dev1", { message: "x" });
    const r = await c.waitForSettled("dev1", 1000);
    expect(r).toEqual({ aborted: true, lastText: "partial" });
  });

  test("shutdown records", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(lead, { cwd: "/w" });
    await c.shutdown("lead");
    expect(c.calls.filter((x) => x.op === "shutdown")).toHaveLength(1);
  });

  test("unknown agent throws on prompt", async () => {
    const c = new FakePiAgentClient();
    await expect(c.prompt("nope", { message: "x" })).rejects.toThrow(/unknown agent/);
  });
});

describe("FakeHerdrPaneManager", () => {
  test("openAgentPane returns id and records", async () => {
    const m = new FakeHerdrPaneManager();
    const id = await m.openAgentPane({ id: "p1", title: "@dev1", command: ["tail", "-f", "x"] });
    expect(id).toBe("p1");
    expect(m.calls.filter((x) => x.op === "open")).toHaveLength(1);
  });

  test("tailLog records; readOutput returns scripted text", async () => {
    const m = new FakeHerdrPaneManager();
    await m.openAgentPane({ id: "p1", title: "@dev1" });
    await m.tailLog("p1", "/log/dev1.log");
    m.setOutput("p1", "line1\nline2");
    expect(await m.readOutput("p1")).toBe("line1\nline2");
    expect(m.calls.filter((x) => x.op === "tail")).toHaveLength(1);
  });

  test("close marks closed and records", async () => {
    const m = new FakeHerdrPaneManager();
    await m.openAgentPane({ id: "p1", title: "@dev1" });
    await m.close("p1");
    expect(m.isClosed("p1")).toBe(true);
    expect(m.calls.filter((x) => x.op === "close")).toHaveLength(1);
  });

  test("unknown pane readOutput throws", async () => {
    const m = new FakeHerdrPaneManager();
    await expect(m.readOutput("nope")).rejects.toThrow(/unknown pane/);
  });

  test("failOn makes the next open, tail or close reject", async () => {
    const m = new FakeHerdrPaneManager();
    m.failOn("open", new Error("no pseudo-terminal"));
    await expect(m.openAgentPane({ id: "p1", title: "@dev1" })).rejects.toThrow("no pseudo-terminal");

    await m.openAgentPane({ id: "p1", title: "@dev1" });
    m.failOn("tail", new Error("pane gone"));
    await expect(m.tailLog("p1", "/log")).rejects.toThrow("pane gone");

    m.failOn("close", new Error("already closed"));
    await expect(m.close("p1")).rejects.toThrow("already closed");

    // One knob fires once: the next call goes through.
    await m.tailLog("p1", "/log");
    expect(m.calls.filter((x) => x.op === "tail")).toHaveLength(1);
  });
});
