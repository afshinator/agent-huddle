import { test, expect, describe } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrPaneManagerReal } from "../src/real/herdr-pane-manager-real";
import { paneScript } from "../src/pane-command";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const execFileP = promisify(execFile);

/** Type a line into a pane the way a human does: text, then Enter. */
async function typeIntoPane(paneId: string, text: string): Promise<void> {
  await execFileP("herdr", ["pane", "run", paneId, text]);
}

function herdrAvailable(): boolean {
  const r = spawnSync("herdr", ["--version"], { stdio: "ignore" });
  return r.status === 0 && !r.error;
}

function insideHerdr(): boolean {
  return process.env.HERDR_ENV === "1";
}

function integrationDisabled(): boolean {
  const v = (process.env.PI_TEST_INTEGRATION ?? "1").toLowerCase();
  return v === "0" || v === "false" || v === "no";
}

async function pollFor(
  fn: () => Promise<string>,
  marker: string,
  attempts = 20,
  delayMs = 150,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if ((await fn()).includes(marker)) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`marker ${JSON.stringify(marker)} never appeared`);
}

const skip = !herdrAvailable() || !insideHerdr() || integrationDisabled();

describe.skipIf(skip)("HerdrPaneManagerReal (integration)", () => {
  test("open → tail → read appended output; close does not kill a child process", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-herdr-"));
    const log = join(dir, "agent.log");
    await writeFile(log, "", "utf8");

    // A coordinator-owned child that must survive a pane close (D1).
    const survivor = spawn("sleep", ["30"]);

    const mgr = new HerdrPaneManagerReal({ direction: "down" });
    let paneId: string | null = null;
    try {
      paneId = await mgr.openAgentPane({
        id: "t9test",
        title: "@t9test",
        command: ["tail", "-f", log],
      });
      expect(paneId).toMatch(/^\w+:\w+$/);

      await appendFile(log, "hello t9 marker\n", "utf8");
      await pollFor(() => mgr.readOutput(paneId!), "hello t9 marker");

      await mgr.tailLog(paneId, log);
      await appendFile(log, "direct tail marker\n", "utf8");
      await pollFor(() => mgr.readOutput(paneId!), "direct tail marker");

      await mgr.close(paneId);
      paneId = null;

      // The pane's tail process is gone, but the coordinator's own child is not.
      expect(survivor.exitCode).toBeNull();
    } finally {
      if (paneId !== null) await mgr.close(paneId).catch(() => {});
      survivor.kill("SIGKILL");
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a writable pane carries a typed line into the agent inbox (D7)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ah-herdr-inbox-"));
    const stream = join(dir, "output.log");
    const inbox = join(dir, "inbox");
    const scriptPath = join(dir, "pane.sh");
    await writeFile(stream, "agent output marker\n", "utf8");
    await writeFile(inbox, "", "utf8");
    await writeFile(scriptPath, paneScript({ stream, inbox }), "utf8");

    const mgr = new HerdrPaneManagerReal({ direction: "down" });
    let paneId: string | null = null;
    try {
      paneId = await mgr.openAgentPane({
        id: "t37test",
        title: "@t37test",
        command: ["sh", scriptPath],
      });

      // The tail is running: the pane shows the stream.
      await pollFor(() => mgr.readOutput(paneId!), "agent output marker");

      // A human types a line. It must reach the inbox the coordinator watches.
      await typeIntoPane(paneId, "check the parser");
      await pollFor(() => readFile(inbox, "utf8"), "check the parser");
    } finally {
      if (paneId !== null) await mgr.close(paneId).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
