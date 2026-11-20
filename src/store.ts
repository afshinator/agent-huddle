import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import type { RoomMessage } from "./messages";
import type { AgentRuntime, RoomState } from "./state";

export class RoomStore {
  /** Live room-stream hook; the coordinator prints each appended message here. */
  onAppend?: (msg: RoomMessage) => void;
  private stateWrite: Promise<void> = Promise.resolve();

  constructor(private readonly roomDir: string) {}

  get messagesPath(): string {
    return join(this.roomDir, "messages.jsonl");
  }

  get statePath(): string {
    return join(this.roomDir, "state.json");
  }

  async appendMessage(msg: RoomMessage): Promise<void> {
    await mkdir(this.roomDir, { recursive: true });
    await appendFile(this.messagesPath, JSON.stringify(msg) + "\n", "utf8");
    this.onAppend?.(msg);
  }

  async readMessages(): Promise<RoomMessage[]> {
    let text: string;
    try {
      text = await readFile(this.messagesPath, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return [];
      throw e;
    }
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RoomMessage);
  }

  writeState(state: RoomState): Promise<void> {
    const serialized = JSON.stringify(state, null, 2) + "\n";
    const write = this.stateWrite.then(async () => {
      await mkdir(this.roomDir, { recursive: true });
      const tmp = `${this.statePath}.${randomUUID()}.tmp`;
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(serialized, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.statePath);
    });
    this.stateWrite = write.catch(() => undefined);
    return write;
  }

  async readState(): Promise<RoomState | null> {
    let text: string;
    try {
      text = await readFile(this.statePath, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null;
      throw e;
    }
    return JSON.parse(text) as RoomState;
  }
}

/**
 * Rebuild a valid RoomState from the message log + config (state.json is a
 * recoverable cache, not the source of truth). Chain/status are reset to idle;
 * only `lastMessageId` and per-agent runtime entries are reconstructed.
 */
export async function reconcileState(
  config: LoadedConfig,
  roomDir: string,
  existing: RoomState | null,
): Promise<RoomState> {
  const messages = await new RoomStore(roomDir).readMessages();
  const last = messages.at(-1);
  const agents: Record<string, AgentRuntime> = {};
  for (const spec of config.allAgents) {
    const previous = existing?.agents?.[spec.id];
    agents[spec.id] = {
      id: spec.id,
      handle: spec.handle,
      sessionDir: join(roomDir, "agents", spec.id, "sessions"),
      status: "starting",
      ...(previous?.sessionFile ? { sessionFile: previous.sessionFile } : {}),
    };
  }

  return {
    name: config.config.name,
    configPath: config.sourcePath,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    status: "idle",
    leadAgentId: config.config.lead.id,
    chain: null,
    agents,
    lastMessageId: last?.id ?? null,
  };
}

export async function rebuildState(
  config: LoadedConfig,
  roomDir: string,
): Promise<RoomState> {
  return reconcileState(config, roomDir, null);
}
