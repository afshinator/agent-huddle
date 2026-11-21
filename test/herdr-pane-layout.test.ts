import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrPaneManagerReal } from "../src/real/herdr-pane-manager-real";
import { chooseLayout, sliceRatios } from "../src/layout";

/**
 * The manager decides geometry from `herdr pane layout` and must execute the plan with the
 * ratios herdr actually implements (the pane being split keeps the ratio). A stub `herdr`
 * records the argv, so the assertion is on the command sequence, not on internals.
 */
const STUB = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [log, counter] = [process.env.STUB_LOG!, process.env.STUB_COUNTER!];
appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\\n");
const args = process.argv.slice(2);
const next = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 1;
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\\n");
if (args[0] === "pane" && args[1] === "layout") {
  // Fabricate geometry: the chat plus one pane per split so far, stacked in creation order.
  const panes = [{ pane_id: "chat", rect: { x: 0, y: 0, width: 176, height: ${"${CHAT_HEIGHT}"} } }];
  for (let i = 1; i < next; i++) {
    panes.push({ pane_id: "p" + i, rect: { x: 0, y: 25 + (i - 1) * 12, width: 88, height: 12 } });
  }
  // herdr does not promise list order; report it reversed so assignment cannot lean on it
  panes.reverse();
  out({ id: "cli:pane:layout", result: { layout: {
    area: { x: 0, y: 0, width: 176, height: 49 },
    focused_pane_id: "chat",
    panes,
    splits: [],
  } } });
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "split") {
  writeFileSync(counter, String(next + 1));
  out({ id: "cli:pane:split", result: { pane: { pane_id: "p" + next } } });
  process.exit(0);
}
out({ id: "cli:ok", result: {} });
`;

async function withStub(
  fn: (h: { manager: HerdrPaneManagerReal; log: () => Promise<string[][]> }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "ah-pane-"));
  const stub = join(dir, "herdr");
  const log = join(dir, "argv.log");
  const counter = join(dir, "counter");
  await writeFile(stub, STUB.replace("${CHAT_HEIGHT}", "25"), "utf8");
  await chmod(stub, 0o755);
  await writeFile(log, "", "utf8");
  process.env.STUB_LOG = log;
  process.env.STUB_COUNTER = counter;
  const manager = new HerdrPaneManagerReal({ herdrBin: stub, cwd: dir });
  try {
    await fn({
      manager,
      log: async () =>
        (await readFile(log, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
    });
  } finally {
    delete process.env.STUB_LOG;
    delete process.env.STUB_COUNTER;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("HerdrPaneManagerReal layout", () => {
  test("it reads the tab, carves the chat once, then splits the host with the plan's ratios", async () => {
    await withStub(async ({ manager, log }) => {
      const first = await manager.openAgentPane({ id: "a-lead", title: "@lead", slot: 1, slots: 3 });
      const second = await manager.openAgentPane({ id: "a-dev1", title: "@dev1", slot: 2, slots: 3 });
      const third = await manager.openAgentPane({ id: "a-reviewer", title: "@reviewer", slot: 3, slots: 3 });

      const calls = await log();
      const splits = calls.filter((c) => c[0] === "pane" && c[1] === "split");
      const plan = chooseLayout({ width: 176, height: 49, count: 3 })!;

      // one layout read up front, one after splitting to assign by measured position
      expect(calls.filter((c) => c[0] === "pane" && c[1] === "layout")).toHaveLength(2);
      expect(plan.orientation).toBe("above");
      expect(plan.columns).toBe(2);

      // carve the room pane once, keeping the chat's share
      expect(splits[0]!.slice(0, 7)).toEqual([
        "pane", "split", "chat",
        "--direction", "down",
        "--ratio", (plan.chat.height / 49).toFixed(4),
      ]);
      expect(splits[0]).toContain("--no-focus");
      // then the bands and the panes inside them, ratios from the measured rule
      const ratios = splits.slice(1).map((c) => c[c.indexOf("--ratio") + 1]);
      expect(ratios).toEqual([
        sliceRatios(2)[0]!.toFixed(4), // host → two rows
        sliceRatios(2)[0]!.toFixed(4), // first row → two panes
      ]);
      // three distinct panes, assigned by measured position even though herdr listed them reversed
      expect(new Set([first, second, third]).size).toBe(3);
      expect([first, second, third]).toEqual(["p1", "p2", "p3"]);
    });
  }, 20_000);

  test("each slot is renamed and has its command run", async () => {
    await withStub(async ({ manager, log }) => {
      await manager.openAgentPane({ id: "a-lead", title: "@lead", command: ["sh", "pane.sh"], slot: 1, slots: 2 });
      const calls = await log();
      expect(calls.some((c) => c[0] === "pane" && c[1] === "run")).toBe(true);
      expect(calls.some((c) => c[0] === "pane" && c[1] === "rename" && c[3] === "@lead")).toBe(true);
    });
  }, 20_000);

  test("a tab too small for the panes fails instead of producing unreadable panes", async () => {
    await withStub(async ({ manager }) => {
      // 49 rows: 8 panes need more than the floors allow
      await expect(
        manager.openAgentPane({ id: "a", title: "@a", slot: 1, slots: 12 }),
      ).rejects.toThrow(/cannot hold 12 agent panes/);
    });
  }, 20_000);
});
