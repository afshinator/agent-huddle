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
    expect(await c.getLastAssistantText("dev1")).toBe("hello");
  });

  test("pushContext records without starting a turn", async () => {
    const c = new FakePiAgentClient();
    await c.spawn(dev1, { cwd: "/w" });
    await c.pushContext("dev1", "room message");
    expect(c.calls.filter((x) => x.op === "pushContext")).toHaveLength(1);
    expect(c.calls.filter((x) => x.op === "prompt")).toHaveLength(0);
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
});
