import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import { RoomStore, reconcileState } from "./store";
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
  private persistQueue: Promise<void> = Promise.resolve();
  private submitQueue: Promise<unknown> = Promise.resolve();
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
    deps.store.onAppend = (msg) => {
      if (this.roomState) this.roomState.lastMessageId = msg.id;
      this.printMessage(msg);
    };
  }

  async boot(): Promise<SubmitResult | null> {
    try {
      return await this.bootRoom();
    } catch (e) {
      await this.abortBoot(e);
      throw e;
    }
  }

  private async bootRoom(): Promise<SubmitResult | null> {
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
      this.pi.on("error", agent.id, (e) => void this.handleAgentError(agent.id, e));
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

  submit(text: string): Promise<SubmitResult> {    const run = this.submitQueue.then(async () => {
      this.roomStatus = "active";
      for (const agent of Object.values(this.roomState?.agents ?? {})) agent.status = "busy";
      await this.persistState();

      const result = await this.loop.submit(text, "user");
      this.roomStatus = result.status === "halted" ? "halted" : "idle";
      for (const agent of Object.values(this.roomState?.agents ?? {})) {
        if (agent.status === "busy") agent.status = "idle";
        agent.lastActivityAt = this.now();
      }
      await this.persistState();
      return result;
    });
    this.submitQueue = run.catch(() => undefined);
    return run;
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

  /** Undo a partial boot: close panes, stop started agents, record the failure. */
  private async abortBoot(error: unknown): Promise<void> {
    const msg = error instanceof Error ? error.message : String(error);
    this.telemetry.log("error", "boot failed; rolling back", { error: msg });
    for (const agent of this.config.allAgents) {
      const runtime = this.roomState?.agents[agent.id];
      if (!runtime) continue;
      if (runtime.paneId && this.panes) {
        try {
          await this.panes.close(runtime.paneId);
        } catch {
          // best effort: the pane may already be gone
        }
      }
      if (runtime.pid !== undefined) {
        try {
          await this.pi.shutdown(agent.id);
        } catch {
          // best effort: the process may already be gone
        }
        runtime.status = "exited";
      } else {
        runtime.status = "error";
      }
    }
    try {
      await this.persistState();
    } catch {
      // the failure that caused the rollback wins over a state write error
    }
  }

  private async updateChainState(chain: RoomState["chain"]): Promise<void> {
    if (!this.roomState) return;
    this.roomState.chain = chain;
    this.roomStatus = chain ? (chain.status === "halted" ? "halted" : "active") : "idle";
    await this.persistState();
  }

  private persistState(): Promise<void> {
    const persist = this.persistQueue.then(async () => {
      if (!this.roomState) this.roomState = await this.loadOrCreateState();
      this.roomState.status = this.roomStatus;
      await this.store.writeState(this.roomState);
    });
    this.persistQueue = persist.catch(() => undefined);
    return persist;
  }

  private async loadOrCreateState(): Promise<RoomState> {
    const messages = await this.store.readMessages();
    if (this.store.skippedLines > 0) {
      this.telemetry.log("warn", "skipped unparsable room log lines", {
        path: this.store.messagesPath,
        count: this.store.skippedLines,
      });
    }
    return reconcileState(
      this.config,
      this.config.config.room_dir,
      await this.store.readState(),
      messages,
    );
  }

  private async handleAgentError(agentId: string, error: Error): Promise<void> {
    await this.appendAgentLog(agentId, "error", error.message);
    if (this.roomState?.agents[agentId]) {
      this.roomState.agents[agentId].status = "error";
      this.roomState.agents[agentId].lastActivityAt = this.now();
      await this.persistState();
    }
    const chain = this.roomState?.chain;
    if (chain?.status === "active" || chain?.status === "wrap_up") {
      await this.store.appendMessage({
        id: crypto.randomUUID(),
        ts: this.now(),
        kind: "notice",
        from: "room",
        handle: "room",
        text: `agent ${agentId} failed: ${error.message}`,
        mentions: [],
        chainId: chain.chainId,
        hop: chain.hopCount,
      });
      this.roomStatus = "halted";
      await this.persistState();
    }
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
