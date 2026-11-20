import { mkdtemp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RoomStore } from "../src/store";
import type { RoomMessage } from "../src/messages";

const execFileP = promisify(execFile);

/** A temporary git repository root, for the launch guard. */
export async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ah-repo-"));
  await execFileP("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/**
 * Poll a condition. Used instead of a fixed sleep: a sleep either wastes time or
 * fails on a loaded machine, and this repo has already paid for that once.
 */
export async function waitUntil(ok: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Poll a file until it contains `needle`, then return its contents. */
export async function waitForText(path: string, needle: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes(needle) || Date.now() > deadline) return text;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Poll the room log for a message that matches. */
export async function waitForMessage(
  store: RoomStore,
  match: (m: RoomMessage) => boolean,
  timeoutMs = 2000,
): Promise<RoomMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await store.readMessages()).messages.find((m) => match(m));
    if (found) return found;
    if (Date.now() > deadline) throw new Error("message never appeared");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
