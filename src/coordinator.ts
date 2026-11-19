import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import { RoomStore, rebuildState } from "./store";
import { buildRolePrompt, buildSocialContract } from "./prompts";
import { TurnLoop, type SubmitResult } from "./turn-loop";
import { startRoom } from "./startup";
import type { PiAgentClient } from "./seams/pi-agent-client";
import type { HerdrPaneManager } from "./seams/herdr-pane-manager";
import type { Telemetry } from "./telemetry";
import type { RoomMessage } from "./messages";
import type { RoomStatus } from "./state";

export interface CoordinatorDeps {
  config: LoadedConfig;
  store: RoomStore;
  pi: PiAgentClient;
  telemetry: Telemetry;
  panes?: HerdrPaneManager | null;
  cwd?: string;
  stdout?: { write(s: string): void };
  now?: () => string;
}

/**
 * Wires config → store → telemetry → prompts → turn loop → pi → panes.
 *
 * The room pane is the coordinator's terminal: `stdout` prints each appended
 * room message (§8); the human's stdin is read by the CLI (`src/index.ts`).
 * `state.json` is persisted on boot, after each chain, and on shutdown.
 */
export class Coordinator {
  private readonly config: LoadedConfig;
  private readonly store: RoomStore;
  private readonly pi: PiAgentClient;
  private readonly telemetry: Telemetry;
  private readonly loop: TurnLoop;
  private readonly panes: HerdrPaneManager | null;
  private readonly cwd: string;
  private readonly stdout: { write(s: string): void };
  private readonly now: () => string;
  private readonly agentLogs = new Map<string, string>();
  private roomStatus: RoomStatus = "idle";

  constructor(deps: CoordinatorDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.pi = deps.pi;
    this.telemetry = deps.telemetry;
    this.panes = deps.panes ?? null;
    this.cwd = deps.cwd ?? process.cwd();
    this.stdout = deps.stdout ?? process.stdout;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.loop = new TurnLoop({ config: deps.config, store: deps.store, pi: deps.pi, telemetry: deps.telemetry });
    deps.store.onAppend = (msg) => this.printMessage(msg);
  }

  async boot(): Promise<SubmitResult | null> {
    const roomDir = this.config.config.room_dir;
    await mkdir(roomDir, { recursive: true });

    for (const agent of this.config.allAgents) {
      const rolePrompt = await buildRolePrompt(agent, this.config);
      const socialContract = buildSocialContract(agent, this.config);
      const info = await this.pi.spawn(agent, {
        cwd: this.cwd,
        systemPrompt: rolePrompt,
        appendSystemPrompt: socialContract,
      });

      const agentDir = join(roomDir, "agents", agent.id);
      await mkdir(agentDir, { recursive: true });
      const logPath = join(agentDir, "log.jsonl");
      this.agentLogs.set(agent.id, logPath);

      this.pi.on("stream", agent.id, (delta) => void this.appendAgentLog(agent.id, "delta", delta));
      this.pi.on("settled", agent.id, (r) => void this.appendAgentLog(agent.id, "settled", r.lastText ?? ""));
      this.pi.on("error", agent.id, (e) => void this.appendAgentLog(agent.id, "error", e.message));
      await this.appendAgentLog(agent.id, "spawned", `pid=${info.pid}`);

      if (this.panes) {
        await this.panes.openAgentPane({
          id: `agent-${agent.id}`,
          title: agent.handle,
          command: ["tail", "-f", logPath],
        });
      }
    }

    const result = await startRoom(this.config, this.loop);
    this.roomStatus = result?.status === "halted" ? "halted" : "idle";
    await this.persistState();
    return result;
  }

  async submit(text: string): Promise<SubmitResult> {
    const result = await this.loop.submit(text, "user");
    this.roomStatus = result.status === "halted" ? "halted" : "idle";
    await this.persistState();
    return result;
  }

  async shutdown(): Promise<void> {
    for (const agent of this.config.allAgents) {
      await this.appendAgentLog(agent.id, "shutdown", "");
      await this.pi.shutdown(agent.id);
    }
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    const state = await rebuildState(this.config, this.config.config.room_dir);
    state.status = this.roomStatus;
    await this.store.writeState(state);
  }

  private async appendAgentLog(agentId: string, event: string, text: string): Promise<void> {
    const path = this.agentLogs.get(agentId);
    if (!path) return;
    await appendFile(path, JSON.stringify({ ts: this.now(), event, text }) + "\n", "utf8");
  }

  private printMessage(msg: RoomMessage): void {
    const prefix =
      msg.kind === "notice" || msg.kind === "hop_limit_reached" ? "[room]" : `[${msg.handle}]`;
    this.stdout.write(`${prefix} ${msg.text}\n`);
  }
}
