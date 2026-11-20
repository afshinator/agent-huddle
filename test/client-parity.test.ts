import { test, expect, describe } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePiAgentClient, type PiAgentClient } from "../src/seams/pi-agent-client";
import { RealPiAgentClient } from "../src/real/pi-agent-client-real";
import type { AgentSpec } from "../src/config";

/**
 * The two `PiAgentClient` implementations must agree on what a caller can observe, or a
 * test written against the fake passes while a room run against the real client does
 * something else. That is what #51 cost: the fake let a held turn outlive `shutdown()`,
 * so the suite called a wrong fix green and CI found the leak instead.
 *
 * The comparison is of effects only — what a caller sees through the seam: the settle
 * outcome, the events, and whether a second stop is harmless.
 */
const HOLD_STUB = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const out = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim() === "") return;
  const cmd = JSON.parse(line) as { id?: string; type?: string };
  // A turn that starts and never settles: held open across the stop.
  if (cmd.type === "prompt") out({ type: "agent_start" });
  if (cmd.id) out({ id: cmd.id, type: "response", success: true, data: {} });
});
`;

const dev1: AgentSpec = { id: "dev1", handle: "@dev1", role: "dev" };

interface Observed {
  settle: string;
  errorEvents: string[];
  afterStop: string;
  secondStop: string;
}

async function stopMidTurn(client: PiAgentClient, agentId: string): Promise<Observed> {
  const errorEvents: string[] = [];
  client.on("error", agentId, (e) => errorEvents.push(e.message));

  await client.prompt(agentId, { message: "hold the turn" });
  const pending = client.waitForSettled(agentId, 5_000).then(
    (r) => `resolved: ${r.lastText}`,
    (e: Error) => `rejected: ${e.message}`,
  );

  await client.shutdown(agentId);
  const settle = await pending;

  const afterStop = await client.waitForSettled(agentId, 200).then(
    (r) => `resolved: ${r.lastText}`,
    (e: Error) => `rejected: ${e.message}`,
  );

  let secondStop = "ok";
  try {
    await client.shutdown(agentId);
  } catch (e) {
    secondStop = `threw: ${(e as Error).message}`;
  }

  return { settle, errorEvents, afterStop, secondStop };
}

async function realClient(): Promise<{ client: RealPiAgentClient; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ah-parity-"));
  const stub = join(dir, "hold-pi");
  await writeFile(stub, HOLD_STUB, "utf8");
  await chmod(stub, 0o755);
  return { client: new RealPiAgentClient({ roomDir: dir, piBin: stub, stderr: { write: () => {} } }), dir };
}

async function fakeClient(): Promise<FakePiAgentClient> {
  const client = new FakePiAgentClient();
  client.script(dev1.id, [{ hold: true }]);
  await client.spawn(dev1, { cwd: "/fake" });
  return client;
}

describe("PiAgentClient parity", () => {
  test("a stop mid-turn looks the same to a caller through either implementation", async () => {
    const { client: real, dir } = await realClient();
    try {
      await real.spawn(dev1, { cwd: dir });
      const realObserved = await stopMidTurn(real, dev1.id);
      const fakeObserved = await stopMidTurn(await fakeClient(), dev1.id);

      // Anchor the shared expectation, so two identically wrong clients cannot pass.
      expect(realObserved).toEqual({
        settle: "rejected: pi process for dev1 exited before settling",
        errorEvents: [],
        afterStop: "resolved: null",
        secondStop: "ok",
      } satisfies Observed);
      expect(fakeObserved).toEqual(realObserved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
