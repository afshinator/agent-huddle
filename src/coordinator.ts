import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedConfig } from "./config";
import { RoomStore, reconcileState } from "./store";
import { buildRolePrompt, buildSocialContract } from "./prompts";
import { TurnLoop, type SubmitResult } from "./turn-loop";
import { startRoom } from "./startup";
import type { PiAgentClient } from "./seams/pi-agent-client";
import { AgentStream } from "./agent-stream";
import { PaneInbox } from "./pane-inbox";
import { paneScript } from "./pane-command";
import type { HerdrPaneManager } from "./seams/herdr-pane-manager";
import type { Telemetry } from "./telemetry";
import { errorMessage } from "./errors";
import type { Debug } from "./debug";
import { guardMessage, guardWarning, inspectLaunchDir, LaunchGuardError } from "./launch-guard";
import type { RoomMessage } from "./messages";
import type { RoomState, RoomStatus } from "./state";
import { ChatStream } from "./chat-stream";
import { colorOf, paintHandles, paintTag } from "./colors";

/** The banner shows the ask as a pointer, not a transcript: its first non-blank line. */
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

export interface CoordinatorDeps {
  config: LoadedConfig;
  store: RoomStore;
  pi: PiAgentClient;
  telemetry: Telemetry;
  panes?: HerdrPaneManager | null;
  cwd?: string;
  stdout?: { write(s: string): void };
  /** Where the human-readable transcript lives, printed in the banner (#59). */
  roomLogPath?: string;
  /** Colour on or off, decided by the caller: the coordinator cannot see a terminal through a
   *  wrapped stdout, and guessing got it wrong (#67). */
  color: boolean;
  stderr?: { write(s: string): void };
  now?: () => string;
  inboxPollMs?: number;
  agentStream?: AgentStream;
  inboxRead?: (path: string) => Promise<string>;
  /** Lifecycle trace; `AH_DEBUG=1` in the CLI wires it (#55). Silent by default. */
  debug?: Debug;
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
  private readonly roomLogPath?: string;
  /** Agent prose as it arrives, so the room reads like a chat rather than minutes (#63). */
  private readonly chat: ChatStream;
  /** Agents that have shown activity this turn, so the "working" marker is written once. */
  private readonly working = new Set<string>();
  /** Decided by the caller (#67): `AH_COLOR`, `NO_COLOR`, or "the output is a terminal". */
  private readonly color: boolean;
  private readonly stderr: { write(s: string): void };
  private readonly now: () => string;
  private persistQueue: Promise<void> = Promise.resolve();
  private submitQueue: Promise<unknown> = Promise.resolve();
  private readonly agentLogs = new Map<string, string>();
  private readonly agentStream: AgentStream;
  private readonly inbox: PaneInbox;
  private readonly reportedFailures = new Set<string>();
  private roomState: RoomState | null = null;
  private roomStatus: RoomStatus = "idle";
  /** Set the moment shutdown begins: a turn that dies after this was stopped, not failed. */
  private stopping = false;
  /** The boot-time chain, so a stop during boot waits for it like a supervisor turn. */
  private bootRun: Promise<unknown> = Promise.resolve();
  /** Chains and boot runs currently running, for a test that ends before its room does. */
  private inFlight = 0;
  private readonly debug: Debug;

  constructor(deps: CoordinatorDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.pi = deps.pi;
    this.telemetry = deps.telemetry;
    this.panes = deps.panes ?? null;
    this.cwd = deps.cwd ?? process.cwd();
    this.stdout = deps.stdout ?? process.stdout;
    this.roomLogPath = deps.roomLogPath;
    this.color = deps.color;
    this.chat = new ChatStream(
      { write: (s) => this.stdout.write(this.paint(s)) },
      (agentId) => this.config.agentById.get(agentId)?.handle ?? agentId,
    );
    this.stderr = deps.stderr ?? process.stderr;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.debug = deps.debug ?? (() => {});
    this.agentStream = deps.agentStream ?? new AgentStream();
    this.inbox = new PaneInbox({
      pollMs: deps.inboxPollMs,
      onLine: (agentId, line) => this.submitFromPane(agentId, line),
      // Same rule as the launch guard: a warn that only a telemetry file sees is nearly
      // silence, so the first record of a dead inbox also prints one line (#46, #48).
      onError: (agentId, error) => {
        if (this.reportFailure("pane inbox read", agentId, error)) {
          this.stderr.write(`warning: cannot read ${agentId}'s pane inbox: ${errorMessage(error)}\n`);
        }
      },
      ...(deps.inboxRead ? { read: deps.inboxRead } : {}),
    });
    this.loop = new TurnLoop({
      config: deps.config,
      store: deps.store,
      pi: deps.pi,
      telemetry: deps.telemetry,
      turnTimeoutMs: deps.config.config.turn_timeout_ms,
      onChainState: (chain) => this.updateChainState(chain),
      isStopping: () => this.stopping,
    });
    deps.store.onAppend = (msg) => {
      if (this.roomState) this.roomState.lastMessageId = msg.id;
      this.printMessage(msg);
    };
  }

  async boot(): Promise<SubmitResult | null> {
    // Before anything that writes: a refusal must not create room files in the
    // directory it refuses to write into (abortBoot would, via its state write).
    await this.checkLaunchDir();
    try {
      this.inFlight += 1;
      // The counter comes back to zero inside the promise the caller awaits: a caller that
      // asks "is the room quiet" right after boot() must not see a phantom boot (#53, CI).
      const run = this.bootRoom().finally(() => {
        this.inFlight -= 1;
      });
      this.bootRun = run.catch(() => undefined);
      return await run;
    } catch (e) {
      await this.abortBoot(e);
      throw e;
    }
  }

  private async bootRoom(): Promise<SubmitResult | null> {
    const roomDir = this.config.config.room_dir;
    await mkdir(roomDir, { recursive: true });
    this.roomState = await this.loadOrCreateState();
    this.printBanner();

    for (const [agentIndex, agent] of this.config.allAgents.entries()) {
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
      // The pane tails this file (D7); `log.jsonl` stays the machine record.
      const streamPath = join(agentDir, "output.log");
      this.agentStream.open(agent.id, streamPath);
      // Awaited: this write is what creates output.log, and the pane starts
      // `tail -f` on that file a few statements later. A failed write still must
      // not abort boot, which is what watchFailure's never-rejecting promise buys.
      await this.watchFailure("agent pane write", agent.id, this.agentStream.line(agent.id, `[started] pid=${info.pid}`));
      // Without this a pane that has never been used shows only a pid, which reads as
      // activity: say what the agent's state actually is (#62).
      const slot = this.panes ? ` · slot ${agentIndex + 1}/${this.config.allAgents.length}` : "";
      await this.watchFailure(
        "agent pane write",
        agent.id,
        this.agentStream.line(agent.id, `${agent.handle} — idle, never dispatched${slot}`),
      );

      // A writable pane carries typed lines through an inbox file (D7): a pane
      // cannot tail and read a keyboard at once.
      const writable = agent.pane_writable !== false;
      const inboxPath = writable ? join(agentDir, "inbox") : null;
      if (inboxPath !== null) {
        await appendFile(inboxPath, "", "utf8");
        await this.inbox.track(agent.id, inboxPath);
      }
      // The pane runs a script file, not an inline `sh -c`: herdr types the command
      // into the pane shell one word per argument, which strips inline quoting.
      const scriptPath = join(agentDir, "pane.sh");
      await writeFile(scriptPath, paneScript({ stream: streamPath, inbox: inboxPath }), "utf8");

      const markWorking = (): void => {
        if (this.working.has(agent.id)) return;
        this.working.add(agent.id);
        this.watchFailure("agent pane write", agent.id, this.agentStream.line(agent.id, `${agent.handle} — working`));
      };

      this.pi.on("stream", agent.id, (delta) => {
        markWorking();
        this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "delta", delta));
        // The room sees the prose as it is written, not when the turn ends (#63).
        this.chat.delta(agent.id, delta);
      });
      this.pi.on("tool", agent.id, (tool) => {
        markWorking();
        this.watchFailure("agent pane write", agent.id, this.agentStream.tool(agent.id, tool));
      });
      this.pi.on("settled", agent.id, (r) => {
        // A turn that streamed nothing still ran: mark it before its text lands, so the pane
        // never shows words from an agent that was "never dispatched".
        markWorking();
        // Only an agent that actually ran a turn moves its activity stamp.
        if (this.roomState) {
          const runtime = this.roomState.agents[agent.id];
          runtime.status = "idle";
          runtime.lastActivityAt = this.now();
        }
        this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "settled", r.lastText ?? ""));
        // A provider may settle with text and no deltas; then the room still needs the words.
        if (!this.chat.end(agent.id)) this.printAgentText(agent.handle, r.lastText);
        this.working.delete(agent.id);
      });
      this.pi.on("error", agent.id, (e) => {
        this.chat.end(agent.id, "turn failed");
        this.watchFailure("agent error handling", agent.id, this.handleAgentError(agent.id, e));
      });
      this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "spawned", `pid=${info.pid}`));
      if (this.panes) {
        const paneId = await this.panes.openAgentPane({
          id: `agent-${agent.id}`,
          title: agent.handle,
          command: ["sh", scriptPath],
          slot: agentIndex + 1,
          slots: this.config.allAgents.length,
        });
        if (this.roomState) this.roomState.agents[agent.id].paneId = paneId;
      }
      await this.persistState();
    }

    this.printLayout();
    const result = await startRoom(this.config, this.loop);
    this.roomStatus = result?.status === "halted" ? "halted" : "idle";
    this.inbox.start();
    await this.persistState();
    return result;
  }

  /** `targets` pins the first dispatch (pane input, #40); the chat pane leaves it unset. */
  submit(text: string, targets?: readonly string[]): Promise<SubmitResult> {    this.inFlight += 1;
    const run = this.submitQueue.then(async () => {
      this.roomStatus = "active";
      for (const agent of Object.values(this.roomState?.agents ?? {})) agent.status = "busy";
      await this.persistState();

      const result = await this.loop.submit(text, "user", targets);
      this.roomStatus = result.status === "halted" ? "halted" : "idle";
      for (const agent of Object.values(this.roomState?.agents ?? {})) {
        if (agent.status === "busy") agent.status = "idle";
      }
      await this.persistState();
      return result;
    }).finally(() => {
      // Same rule as boot(): the counter settles with the promise the caller awaits.
      this.inFlight -= 1;
    });
    this.submitQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether a chain or the boot run is still running. A test that returns with work in
   * flight leaves writes for whatever runs next — the room dir is gone by then (#53).
   */
  workInFlight(): boolean {
    return this.inFlight > 0;
  }

  async shutdown(): Promise<void> {
    this.debug("room stop start");
    this.stopping = true;
    this.inbox.stop();
    // Start every stop in one tick, then wait: Ctrl-C sends SIGINT to the children in
    // this process group as well, and the coordinator's handler runs first (measured:
    // probes/sigint-order). Flagging an agent only after the previous one finished leaves
    // the later child dead-but-unflagged, so its pane reports a crash (#51).
    const stops = this.config.allAgents.map((agent) => {
      this.debug(`agent stop start ${agent.id}`);
      return this.pi.shutdown(agent.id).then(() => this.debug(`agent stop end ${agent.id}`));
    });
    await Promise.all(stops);
    // A rejected turn unwinds as cancelled (D11). Wait for the chains that own it — the
    // supervisor's and boot's — or the final state is written while one is still writing.
    await this.submitQueue;
    await this.bootRun;
    for (const agent of this.config.allAgents) {
      this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "shutdown", ""));
      this.watchFailure("agent pane write", agent.id, this.agentStream.line(agent.id, "[exited]"));
      if (this.roomState) {
        this.roomState.agents[agent.id].status = "exited";
        this.roomState.agents[agent.id].lastActivityAt = this.now();
      }
    }
    // Close what boot opened: a pane whose agent is gone is a dead terminal. Best-effort,
    // so one bad close cannot cost the flush or the exit code.
    for (const agent of this.config.allAgents) {
      const paneId = this.roomState?.agents[agent.id]?.paneId;
      if (!paneId || !this.panes) continue;
      try {
        await this.panes.close(paneId);
      } catch (error: unknown) {
        this.telemetry.log("warn", "pane close failed", { agentId: agent.id, error: errorMessage(error) });
      }
    }
    // A stopped room is idle unless it halted; leaving `active` on disk advertises work
    // no process is doing.
    if (this.roomStatus !== "halted") this.roomStatus = "idle";
    await this.persistState();
    this.debug("room stop end");
  }

  /** Undo a partial boot: close panes, stop started agents, record the failure. */
  private async abortBoot(error: unknown): Promise<void> {
    const msg = errorMessage(error);
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

  /**
   * Refuse or warn when the room is about to write into a git working tree (#38).
   * Runs before the first spawn, so a refusal costs nothing.
   */
  private async checkLaunchDir(): Promise<void> {
    const mode = this.config.config.launch_guard ?? "warn";
    if (mode === "off") return;
    const launch = await inspectLaunchDir(this.cwd);
    // A linked worktree is a repository root but a throwaway one: it is where AGENTS.md
    // says to run a supervised room, so warning there would fire on the correct launch (#48).
    if (!launch.isRepoRoot || launch.worktree) return;

    // A refusal is reported by the CLI, not in a telemetry file: writing that file
    // would mean creating room files in the tree we just refused to write into.
    if (mode === "refuse") throw new LaunchGuardError(guardMessage(launch));
    this.telemetry.log("warn", "launch guard: agents will write into a git repository root", {
      dir: launch.dir,
      branch: launch.branch,
    });
    this.stderr.write(`${guardWarning(launch)}\n`);
  }

  private async loadOrCreateState(): Promise<RoomState> {
    const { messages, skipped } = await this.store.readMessages();
    if (skipped > 0) {
      this.telemetry.log("warn", "skipped unparsable room log lines", {
        path: this.store.messagesPath,
        count: skipped,
      });
    }
    return reconcileState(this.config, await this.store.readState(), messages);
  }

  private async handleAgentError(agentId: string, error: Error): Promise<void> {
    await this.appendAgentLog(agentId, "error", error.message);
    this.watchFailure("agent pane write", agentId, this.agentStream.line(agentId, `[error] ${error.message}`));
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
        text: `agent ${agentId}: ${error.message}`,
        mentions: [],
        chainId: chain.chainId,
        hop: chain.hopCount,
      });
      this.roomStatus = "halted";
      await this.persistState();
    }
  }

  /**
   * Fire-and-forget listener body. A rejected promise here would be unhandled,
   * which Bun turns into a process exit, so the failure is reported once per
   * agent and operation instead.
   */
  private watchFailure(op: string, agentId: string, work: Promise<void>): Promise<void> {
    return work.catch((e: unknown) => {
      this.reportFailure(op, agentId, e);
    });
  }

  /**
   * Report one agent's failure once, not once per poll or per delta.
   * `warn`: the inbox is an input channel, so a failed read degrades a feature
   * without losing anything already committed — unlike a failed log write.
   */
  private reportFailure(op: string, agentId: string, e: unknown): boolean {
    const key = `${op}:${agentId}`;
    if (this.reportedFailures.has(key)) return false;
    this.reportedFailures.add(key);
    this.telemetry.log(op === "pane inbox read" ? "warn" : "error", `${op} failed`, {
      agentId,
      error: errorMessage(e),
    });
    return true;
  }

  /** A line typed in an agent's pane is a public message to that agent (D7). */
  private submitFromPane(agentId: string, line: string): void {
    const agent = this.config.agentById.get(agentId);
    if (!agent) return;
    this.telemetry.log("info", "pane.input", { agentId, chars: line.length });
    // Pinned: a handle in the typed line is a word the supervisor wrote, not a
    // dispatch (#40). The text keeps it so the room reads what was typed.
    void this.submit(`${agent.handle} ${line}`, [agentId]).catch((e: unknown) => {
      // The submit path reports its own failures; this only stops an unhandled rejection.
      this.telemetry.log("error", "pane input failed", { agentId, error: errorMessage(e) });
    });
  }

  private async appendAgentLog(agentId: string, event: string, text: string): Promise<void> {
    const path = this.agentLogs.get(agentId);
    if (!path) return;
    await appendFile(path, JSON.stringify({ ts: this.now(), event, text }) + "\n", "utf8");
  }

  /** One line of room preamble: a human watching the pane should know what is running. */
  private printLine(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  /** Before the first dispatch: what this room is, who is in it, and where it writes. */
  private printBanner(): void {
    const { name, room_dir: roomDir, task } = this.config.config;
    const handles = this.paint(this.config.allAgents.map((a) => a.handle).join(" "));
    this.printLine(`── room ${name} · ${this.config.allAgents.length} agents ${handles} · run dir ${roomDir} ──`);
    const ask = task === undefined ? "none — the room waits for your first message" : firstLine(task);
    this.printLine(`ask: ${ask}`);
    if (this.roomLogPath !== undefined) this.printLine(`transcript: ${this.roomLogPath}`);
  }

  /** What the tab gave, measured: a shape nobody can read is then visible, not guessed (#59). */
  private printLayout(): void {
    if (!this.panes) return;
    const report = this.panes.layoutReport?.() ?? null;
    if (report === null) {
      this.printLine("layout: the pane manager reported no geometry");
      return;
    }
    const first = report.panes[0]?.box;
    const panes = first === undefined ? "" : ` · ${report.panes.length} panes ${first.width}x${first.height}`;
    this.printLine(
      `layout: tab ${report.tab.width}x${report.tab.height} ${report.orientation} · ` +
        `chat ${report.chat.width}x${report.chat.height}${panes}`,
    );
    for (const pane of report.panes) {
      this.debug(`pane ${pane.paneId} slot ${pane.slot} ${pane.box.width}x${pane.box.height} @ ${pane.box.x},${pane.box.y}`);
    }
  }

  private printMessage(msg: RoomMessage): void {
    // An agent's text already reached the room as it streamed; printing the settled
    // record again would show every reply twice (#63).
    if (msg.kind === "agent") return;
    // The brief is background: what the room was launched to do, not an instruction issued
    // now by a participant. It prints as a block so nothing appears to be speaking it (#68).
    if (msg.kind === "startup_task") {
      this.printBrief(msg.text);
      return;
    }
    // A notice means something happened outside a turn: close any line left open, so the
    // transcript never ends mid-sentence with no indication why.
    if (msg.kind === "notice" || msg.kind === "hop_limit_reached") {
      this.chat.endAll("interrupted");
      // The room's own note, not a participant's message: a bare `·` marks it as out-of-band,
      // and no agent ever receives it as context (#68).
      this.stdout.write(`· ${this.paint(msg.text)}\n`);
      return;
    }
    const prefix = paintTag(msg.handle, (h) => this.colourFor(h));
    this.stdout.write(`${prefix} ${this.paint(msg.text)}\n`);
  }

  /** The room's brief: a framed block, so it reads as background rather than a command. */
  private printBrief(text: string): void {
    this.printLine("── brief ── background: what this room was launched to do");
    for (const line of text.split("\n")) this.printLine(line === "" ? "" : `  ${this.paint(line)}`);
    this.printLine("── end brief ──");
  }

  /** A settled reply whose turn streamed nothing: print it the way the room always has. */
  private printAgentText(handle: string, text: string | null): void {
    if (text === null || text.trim() === "") return;
    this.stdout.write(`${paintTag(handle, (h) => this.colourFor(h))} ${this.paint(text)}\n`);
  }

  /** The SGR payload for a handle, or null when colour is off or the handle is unknown. */
  private colourFor(handle: string): string | null {
    if (!this.color) return null;
    const agent = this.config.allAgents.find((a) => a.handle === handle);
    if (!agent) return null;
    const slot = this.config.allAgents.indexOf(agent);
    return colorOf(agent.id, slot);
  }

  /** Every `@handle` in a line takes its agent's colour; with colour off this is identity. */
  private paint(text: string): string {
    return this.color ? paintHandles(text, (h) => this.colourFor(h)) : text;
  }
}
