import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import type { RoomMessage } from "./messages";
import type { AgentRuntime, RoomState } from "./state";

export class RoomStore {
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

  async writeState(state: RoomState): Promise<void> {
    await mkdir(this.roomDir, { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(JSON.stringify(state, null, 2) + "\n", "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.statePath);
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
export async function rebuildState(
  config: LoadedConfig,
  roomDir: string,
): Promise<RoomState> {
  const store = new RoomStore(roomDir);
  const messages = await store.readMessages();
  const last = messages.length > 0 ? messages[messages.length - 1] : null;

  const agents: Record<string, AgentRuntime> = {};
  for (const a of config.allAgents) {
    agents[a.id] = {
      id: a.id,
      handle: a.handle,
      sessionDir: join(roomDir, "agents", a.id, "sessions"),
      status: "idle",
    };
  }

  return {
    name: config.config.name,
    configPath: config.sourcePath,
    startedAt: new Date().toISOString(),
    status: "idle",
    leadAgentId: config.config.lead.id,
    chain: null,
    agents,
    lastMessageId: last ? last.id : null,
  };
}
