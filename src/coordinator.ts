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
import type { RoomState, RoomStatus } from "./state";

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
  private roomState: RoomState | null = null;
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
    this.loop = new TurnLoop({
      config: deps.config,
      store: deps.store,
      pi: deps.pi,
      telemetry: deps.telemetry,
      onChainState: (chain) => this.updateChainState(chain),
    });
    deps.store.onAppend = (msg) => this.printMessage(msg);
  }

  async boot(): Promise<SubmitResult | null> {
    const roomDir = this.config.config.room_dir;
    await mkdir(roomDir, { recursive: true });
    this.roomState = await this.loadOrCreateState();

    for (const agent of this.config.allAgents) {
      const rolePrompt = await buildRolePrompt(agent, this.config);
      const socialContract = buildSocialContract(agent, this.config);
      const info = await this.pi.spawn(agent, {
        cwd: this.cwd,
        systemPrompt: rolePrompt,
        appendSystemPrompt: socialContract,
      });
      if (this.roomState) {
        this.roomState.agents[agent.id].pid = info.pid;
        this.roomState.agents[agent.id].status = "idle";
        this.roomState.agents[agent.id].lastActivityAt = this.now();
      }

      const agentDir = join(roomDir, "agents", agent.id);
      await mkdir(agentDir, { recursive: true });
      const logPath = join(agentDir, "log.jsonl");
      this.agentLogs.set(agent.id, logPath);

      this.pi.on("stream", agent.id, (delta) => void this.appendAgentLog(agent.id, "delta", delta));
      this.pi.on("settled", agent.id, (r) => void this.appendAgentLog(agent.id, "settled", r.lastText ?? ""));
      this.pi.on("error", agent.id, (e) => void this.appendAgentLog(agent.id, "error", e.message));
      await this.appendAgentLog(agent.id, "spawned", `pid=${info.pid}`);

      if (this.panes) {
        const paneId = await this.panes.openAgentPane({
          id: `agent-${agent.id}`,
          title: agent.handle,
          command: ["tail", "-f", logPath],
        });
        if (this.roomState) this.roomState.agents[agent.id].paneId = paneId;
      }
      await this.persistState();
    }

    const result = await startRoom(this.config, this.loop);
    this.roomStatus = result?.status === "halted" ? "halted" : "idle";
    await this.persistState();
    return result;
  }

  async submit(text: string): Promise<SubmitResult> {
    this.roomStatus = "active";
    for (const agent of Object.values(this.roomState?.agents ?? {})) agent.status = "busy";
    await this.persistState();

    const result = await this.loop.submit(text, "user");
    this.roomStatus = result.status === "halted" ? "halted" : "idle";
    for (const agent of Object.values(this.roomState?.agents ?? {})) {
      agent.status = result.status === "halted" ? "error" : "idle";
      agent.lastActivityAt = this.now();
    }
    await this.persistState();
    return result;
  }

  async shutdown(): Promise<void> {
    for (const agent of this.config.allAgents) {
      await this.appendAgentLog(agent.id, "shutdown", "");
      await this.pi.shutdown(agent.id);
      if (this.roomState) {
        this.roomState.agents[agent.id].status = "exited";
        this.roomState.agents[agent.id].lastActivityAt = this.now();
      }
    }
    await this.persistState();
  }

  private async updateChainState(chain: RoomState["chain"]): Promise<void> {
    if (!this.roomState) return;
    this.roomState.chain = chain;
    this.roomStatus = chain ? (chain.status === "halted" ? "halted" : "active") : "idle";
    await this.persistState();
  }

  private async persistState(): Promise<void> {
    if (!this.roomState) this.roomState = await this.loadOrCreateState();
    this.roomState.status = this.roomStatus;
    this.roomState.lastMessageId = (await this.store.readMessages()).at(-1)?.id ?? null;
    await this.store.writeState(this.roomState);
  }

  private async loadOrCreateState(): Promise<RoomState> {
    return (await this.store.readState()) ?? (await rebuildState(this.config, this.config.config.room_dir));
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
