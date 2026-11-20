import { test, expect, describe } from "bun:test";
import { createShutdown } from "../src/shutdown";

describe("createShutdown", () => {
  test("shuts the room down, flushes, then exits 0, in that order", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      shutdown: async () => {
        order.push("shutdown");
      },
      flush: async () => {
        order.push("flush");
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });

    await shutdown();
    expect(order).toEqual(["shutdown", "flush", "exit:0"]);
  });

  test("a repeated signal does not run the sequence twice", async () => {
    let shuts = 0;
    let exits = 0;
    const shutdown = createShutdown({
      shutdown: async () => {
        shuts++;
      },
      flush: async () => {},
      exit: () => {
        exits++;
      },
    });

    await Promise.all([shutdown(), shutdown()]);
    await shutdown();
    expect(shuts).toBe(1);
    expect(exits).toBe(1);
  });

  test("a failing coordinator shutdown still flushes and exits 0", async () => {
    const order: string[] = [];
    const shutdown = createShutdown({
      shutdown: async () => {
        order.push("shutdown");
        throw new Error("boom");
      },
      flush: async () => {
        order.push("flush");
      },
      exit: (code) => {
        order.push(`exit:${code}`);
      },
    });

    await shutdown();
    expect(order).toEqual(["shutdown", "flush", "exit:0"]);
  });
});
