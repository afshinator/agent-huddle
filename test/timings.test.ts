import { test, expect, describe } from "bun:test";
import { formatRun, turnTimings } from "../src/timings";

const t = (seconds: number): string => new Date(Date.UTC(2026, 10, 21, 5, 0, 0) + seconds * 1000).toISOString();

describe("turnTimings", () => {
  test("separates the provider's first token from a tool from the model thinking", () => {
    const turns = turnTimings("dev1", [
      // The live shape: dispatched, 4s until the first token, a 30s tool, then 6s of thinking.
      { ts: t(0), event: "turn_start" },
      { ts: t(4), event: "delta", text: "Got it" },
      { ts: t(4.2), event: "tool_start", text: "bash" },
      { ts: t(34.2), event: "tool_end", text: "bash 30000ms" },
      { ts: t(40.2), event: "delta", text: "done" },
      { ts: t(41), event: "settled", text: "Got it … done" },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.firstEventMs).toBe(4000);
    expect(turns[0]!.firstEvent).toBe("delta");
    expect(turns[0]!.toolMs).toBe(30000);
    // the longest wait is the tool itself, named as such
    expect(turns[0]!.longest?.after).toBe("tool_start");
    expect(turns[0]!.longest?.ms).toBe(30000);
    expect(turns[0]!.totalMs).toBe(41000);
  });

  test("time before the agent was dispatched is not part of a turn", () => {
    const turns = turnTimings("reviewer", [
      // The live shape: spawned at boot, dispatched three minutes later, answered at once.
      { ts: t(0), event: "spawned" },
      { ts: t(175), event: "turn_start" },
      { ts: t(176), event: "delta", text: "Got it" },
      { ts: t(180), event: "settled", text: "Got it …" },
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.totalMs).toBe(5000);
    expect(turns[0]!.firstEventMs).toBe(1000);
  });

  test("a turn reports what it spent, from its stats record (#T12)", () => {
    const turns = turnTimings("dev1", [
      { ts: t(0), event: "turn_start" },
      { ts: t(1), event: "delta", text: "Got it" },
      { ts: t(2), event: "tool_start", text: "bash" },
      { ts: t(3), event: "tool_end", text: "bash 1000ms" },
      { ts: t(4), event: "stats", text: JSON.stringify({ tokens: 31240, cost: 0.0001, toolCalls: 9 }) },
      { ts: t(5), event: "settled", text: "done" },
    ]);
    expect(turns[0]!.tokens).toBe(31240);
    expect(turns[0]!.cost).toBeCloseTo(0.0001, 6);
    expect(formatRun(new Map([["dev1", turns]]))).toContain("31240 tokens");
  });

  test("a turn without stats reports no cost rather than zero", () => {
    const turns = turnTimings("dev1", [
      { ts: t(0), event: "turn_start" },
      { ts: t(1), event: "delta", text: "hi" },
      { ts: t(2), event: "settled", text: "hi" },
    ]);
    expect(turns[0]!.tokens).toBe(0);
    expect(turns[0]!.cost).toBeNull();
    expect(formatRun(new Map([["dev1", turns]]))).not.toContain("tokens");
  });

  test("a gap with nothing in it is reported as the wait it is", () => {
    const turns = turnTimings("lead", [
      { ts: t(0), event: "turn_start" },
      { ts: t(120), event: "settled", text: "" },
    ]);
    expect(turns[0]!.longest?.ms).toBe(120000);
    expect(turns[0]!.longest?.until).toBe("settled");
  });

  test("several turns are separate, and an open one is kept", () => {
    const turns = turnTimings("lead", [
      { ts: t(0), event: "turn_start" },
      { ts: t(1), event: "settled", text: "one" },
      { ts: t(2), event: "turn_start" },
      { ts: t(9), event: "delta", text: "two" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1]!.totalMs).toBe(7000);
  });
});

describe("formatRun", () => {
  test("one line per turn, with the wait named", () => {
    const text = formatRun(
      new Map([
        [
          "dev1",
          turnTimings("dev1", [
            { ts: t(0), event: "turn_start" },
            { ts: t(2), event: "tool_start", text: "bash" },
            { ts: t(32), event: "tool_end", text: "bash 30000ms" },
            { ts: t(35), event: "settled", text: "x" },
          ]),
        ],
      ]),
    );
    expect(text).toContain("dev1");
    expect(text).toContain("longest 30.0s after tool_start → tool_end");
  });
});
