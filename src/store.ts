import { appendFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import type { RoomMessage } from "./messages";
import type { AgentRuntime, RoomState } from "./state";

/** One read of `messages.jsonl`: the readable messages plus the lines dropped. */
export interface LogRead {
  messages: RoomMessage[];
  skipped: number;
}

/** A line that is not a JSON object is a crash artefact, not a message. */
function parseLine(line: string): RoomMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as RoomMessage) : null;
  } catch {
    return null;
  }
}

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

  async readMessages(): Promise<LogRead> {
    let text: string;
    try {
      text = await readFile(this.messagesPath, "utf8");
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return { messages: [], skipped: 0 };
      throw e;
    }
    const messages: RoomMessage[] = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      // A crash mid-append can leave one partial line; it must not make the
      // log unreadable, so a bad line is dropped and counted.
      const message = parseLine(line);
      if (message === null) {
        skipped += 1;
        continue;
      }
      messages.push(message);
    }
    return { messages, skipped };
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
    try {
      return JSON.parse(text) as RoomState;
    } catch {
      // state.json is a recoverable cache: a damaged file is rebuilt, not fatal.
      return null;
    }
  }
}

/**
 * Rebuild a valid RoomState from the message log + config (state.json is a
 * recoverable cache, not the source of truth). Chain/status are reset to idle;
 * only `lastMessageId` and per-agent runtime entries are reconstructed.
 */
export async function reconcileState(
  config: LoadedConfig,
  existing: RoomState | null,
  messages: RoomMessage[],
): Promise<RoomState> {
  const roomDir = config.config.room_dir;
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
