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

const STEER_STUB = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const out = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim() === "") return;
  const cmd = JSON.parse(line) as { id?: string; type?: string; streamingBehavior?: string };
  if (cmd.type === "prompt") {
    out({ type: "agent_start" });
    // A steer is the agent answering a status request and stopping: production settles the turn there.
    if (cmd.streamingBehavior === "steer") {
      out({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "still on it" } });
      out({ type: "agent_settled" });
    }
  }
  if (cmd.id) out({ id: cmd.id, type: "response", success: true, data: {} });
});
`;

const FAILED_TOOL_STUB = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const out = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim() === "") return;
  const cmd = JSON.parse(line) as { id?: string; type?: string };
  if (cmd.type === "prompt") {
    // The harness's own refusal shape: no duration, an error verdict, the reason in the result.
    out({ type: "agent_start" });
    out({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.ts" } });
    out({ type: "tool_execution_end", toolCallId: "c1", toolName: "write", isError: true, result: { content: [{ type: "text", text: "the tool call was not executed" }] } });
    out({ type: "agent_settled", aborted: false });
  }
  if (cmd.type === "get_last_assistant_text") out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { text: "gave up" } });
  else if (cmd.id) out({ id: cmd.id, type: "response", success: true, data: {} });
});
`;

const PROVIDER_ERROR_STUB = `#!/usr/bin/env bun
import { createInterface } from "node:readline";
const out = (o: unknown): void => { process.stdout.write(JSON.stringify(o) + "\\n"); };
createInterface({ input: process.stdin }).on("line", (line: string) => {
  if (line.trim() === "") return;
  const cmd = JSON.parse(line) as { id?: string; type?: string };
  if (cmd.type === "prompt") {
    // How a run that ends on a provider error reports itself: the completed message carries both.
    out({ type: "agent_start" });
    out({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" } });
    out({ type: "agent_settled", aborted: false });
  }
  if (cmd.type === "get_last_assistant_text") out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { text: null } });
  else if (cmd.id) out({ id: cmd.id, type: "response", success: true, data: {} });
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
  client.subscribe(agentId, (e) => {
    if (e.type === "error") errorEvents.push(e.error.message);
  });

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

async function realClient(stubSource: string = HOLD_STUB): Promise<{ client: RealPiAgentClient; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ah-parity-"));
  const stub = join(dir, "hold-pi");
  await writeFile(stub, stubSource, "utf8");
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

  /**
   * The room nudges a quiet turn with a `steer`, and the agent answers the status request and stops.
   * The settle the caller is already waiting on has to be the one that resolves (T16): a steer that
   * replaces it leaves `waitForSettled` with a promise nothing will resolve, and the turn only ends
   * when `turn_timeout_ms` fires.
   */
  test("a steer mid-turn resolves the settle the caller is waiting on", async () => {
    const steerMidTurn = async (
      client: PiAgentClient,
      agentId: string,
      settleHeldTurn: () => void,
    ): Promise<string> => {
      await client.prompt(agentId, { message: "work until the room asks for a status line" });
      const pending = client.waitForSettled(agentId, 2_000).then(
        (r) => `resolved: ${r.lastText}`,
        (e: Error) => `rejected: ${e.message}`,
      );
      await client.prompt(agentId, { message: "status only", streamingBehavior: "steer" });
      settleHeldTurn();
      return pending;
    };

    const { client: real, dir } = await realClient(STEER_STUB);
    try {
      await real.spawn(dev1, { cwd: dir });
      // The stub settles itself when the steer arrives; the fake needs the same moment released.
      const realSettle = await steerMidTurn(real, dev1.id, () => {});
      const fake = await fakeClient();
      const fakeSettle = await steerMidTurn(fake, dev1.id, () => fake.release(dev1.id, "still on it"));

      expect(realSettle).toBe("resolved: still on it");
      expect(fakeSettle).toBe(realSettle);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  /**
   * #81: the fake must be able to say what the harness says when it refuses a call, or every test of a
   * failure is written against a shape the real client never produces. Compared field by field, with the
   * fields the harness owns (the call id) left out.
   */
  test("a refused tool end looks the same to a caller through either implementation", async () => {
    interface Verdict {
      type: string;
      name: string;
      isError: boolean;
      result?: string;
      ran: boolean;
    }
    const verdict = (e: { type: string; name: string; isError: boolean; result?: string; durationMs?: number }): Verdict => ({
      type: e.type,
      name: e.name,
      isError: e.isError,
      result: e.result,
      ran: "durationMs" in e,
    });
    const seen = async (client: PiAgentClient, drive: () => Promise<void>): Promise<Verdict[]> => {
      const ends: Verdict[] = [];
      client.subscribe(dev1.id, (e) => {
        if (e.type === "tool_end") ends.push(verdict(e));
      });
      await drive();
      return ends;
    };

    const { client: real, dir } = await realClient(FAILED_TOOL_STUB);
    try {
      await real.spawn(dev1, { cwd: dir });
      const realEnds = await seen(real, async () => {
        await real.prompt(dev1.id, { message: "write the file" });
        await real.waitForSettled(dev1.id, 5_000);
      });

      const fake = await fakeClient();
      const fakeEnds = await seen(fake, async () => {
        await fake.prompt(dev1.id, { message: "write the file" });
        fake.toolFailed(dev1.id, "write", "the tool call was not executed");
        fake.release(dev1.id, "gave up");
      });

      // Anchor the shared expectation, so two identically wrong clients cannot pass.
      expect(realEnds).toEqual([
        { type: "tool_end", name: "write", isError: true, result: "the tool call was not executed", ran: false },
      ]);
      expect(fakeEnds).toEqual(realEnds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  /**
   * #82 reports a provider error from the settle, so the fake has to deliver the same settle a stub pi
   * delivers — otherwise the room's test of that path is written against a shape only the fake produces.
   */
  test("a turn ended on a provider error settles the same way through either implementation", async () => {
    const shape = (r: { stopReason?: string; errorMessage?: string; lastText: string | null }): unknown => ({
      stopReason: r.stopReason,
      errorMessage: r.errorMessage,
      lastText: r.lastText,
    });

    const { client: real, dir } = await realClient(PROVIDER_ERROR_STUB);
    try {
      await real.spawn(dev1, { cwd: dir });
      await real.prompt(dev1.id, { message: "go" });
      const realSettled = await real.waitForSettled(dev1.id, 5_000);

      const fake = new FakePiAgentClient();
      await fake.spawn(dev1, { cwd: "/fake" });
      fake.script(dev1.id, [{ lastText: null, stopReason: "error", errorMessage: "529 overloaded" }]);
      await fake.prompt(dev1.id, { message: "go" });
      const fakeSettled = await fake.waitForSettled(dev1.id, 5_000);

      expect(shape(realSettled)).toEqual({ stopReason: "error", errorMessage: "529 overloaded", lastText: null });
      expect(shape(fakeSettled)).toEqual(shape(realSettled));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
