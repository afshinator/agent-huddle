import { test, expect, describe } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopTelemetry, JsonlTelemetry } from "../src/telemetry";

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-tel-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(p: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(p, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

describe("NoopTelemetry", () => {
  test("span runs fn and returns value; log/counter no-op", () => {
    const t = new NoopTelemetry();
    let called = false;
    const r = t.span("s", {}, (s) => {
      called = true;
      s.addEvent("e");
      return 42;
    });
    expect(r).toBe(42);
    expect(called).toBe(true);
    t.log("info", "x");
    t.counter("c");
  });
});

describe("JsonlTelemetry", () => {
  test("root span emits with parent_id null and ok status", async () => {
    await withDir(async (dir) => {
      const p = join(dir, "telemetry.jsonl");
      const t = new JsonlTelemetry(p);
      t.span("chain", { chainId: "c1" }, () => {});
      await t.flush();
      const lines = await readLines(p);
      expect(lines).toHaveLength(1);
      const s = lines[0];
      expect(s.kind).toBe("span");
      expect(s.name).toBe("chain");
      expect(s.parent_id).toBeNull();
      expect(s.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(s.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(s.attributes).toEqual({ chainId: "c1" });
      expect(s.status).toEqual({ code: "ok" });
    });
  });

  test("nested span inherits trace_id and sets parent_id", async () => {
    await withDir(async (dir) => {
      const p = join(dir, "telemetry.jsonl");
      const t = new JsonlTelemetry(p);
      t.span("chain", {}, () => {
        t.span("agent.turn", { hop: 1 }, () => {});
      });
      await t.flush();
      const lines = await readLines(p);
      const root = lines.find((l) => l.name === "chain")!;
      const child = lines.find((l) => l.name === "agent.turn")!;
      expect(child.parent_id).toBe(root.span_id);
      expect(child.trace_id).toBe(root.trace_id);
      expect(child.attributes).toEqual({ hop: 1 });
    });
  });

  test("log and counter carry current trace/span context", async () => {
    await withDir(async (dir) => {
      const p = join(dir, "telemetry.jsonl");
      const t = new JsonlTelemetry(p);
      t.span("chain", {}, () => {
        t.log("info", "hello", { k: 1 });
        t.counter("room.hops_total", { chainId: "c" }, 2);
        t.histogram("agent.settle_latency_ms", 12.5, { agentId: "lead" });
        t.upDownCounter("room.active_chains", { room: "r" }, 1);
      });
      await t.flush();
      const lines = await readLines(p);
      const chain = lines.find((l) => l.name === "chain")!;
      const log = lines.find((l) => l.kind === "log")!;
      const metric = lines.find((l) => l.kind === "metric")!;
      expect(log.trace_id).toBe(chain.trace_id);
      expect(log.span_id).toBe(chain.span_id);
      expect(log.level).toBe("info");
      expect(log.message).toBe("hello");
      expect(log.attributes).toEqual({ k: 1 });
      expect(metric.name).toBe("room.hops_total");
      expect(metric.value).toBe(2);
      expect(metric.attributes).toEqual({ chainId: "c" });
      expect(lines.some((line) => line.name === "agent.settle_latency_ms" && line.instrument === "histogram")).toBe(true);
      expect(lines.some((line) => line.name === "room.active_chains" && line.instrument === "up_down_counter")).toBe(true);
    });
  });

  test("span rethrows and records error status", async () => {
    await withDir(async (dir) => {
      const p = join(dir, "telemetry.jsonl");
      const t = new JsonlTelemetry(p);
      expect(() => t.span("fail", {}, () => { throw new Error("boom"); })).toThrow("boom");
      await t.flush();
      const lines = await readLines(p);
      const s = lines.find((l) => l.name === "fail")!;
      expect(s.status).toEqual({ code: "error", description: "boom" });
    });
  });

  test("events recorded on span", async () => {
    await withDir(async (dir) => {
      const p = join(dir, "telemetry.jsonl");
      const t = new JsonlTelemetry(p);
      t.span("chain", {}, (s) => {
        s.addEvent("dispatch", { agentId: "lead" });
      });
      await t.flush();
      const lines = await readLines(p);
      const s = lines.find((l) => l.name === "chain")!;
      expect(s.events).toHaveLength(1);
      expect(s.events[0].name).toBe("dispatch");
      expect(s.events[0].attributes).toEqual({ agentId: "lead" });
    });
  });
});
