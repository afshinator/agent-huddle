import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LAUNCH_GUARD } from "./config";
import type { AgentSpec, LoadedConfig } from "./config";
import { RoomStore, reconcileState } from "./store";
import { buildRolePrompt, buildSocialContract } from "./prompts";
import { TurnLoop, type SubmitResult } from "./turn-loop";
import { startRoom } from "./startup";
import type { PiAgentClient, SessionStats } from "./seams/pi-agent-client";
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
import { ChatStream, roomLine } from "./chat-stream";
import { colorOf, markMentions, markOf, plainName } from "./colors";
import { stampNow } from "./stamp";

/** The banner shows the ask as a pointer, not a transcript: its first non-blank line. */
function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

/**
 * Every name a failed write can report under.
 *
 * Closed on purpose: the level is looked up by this name, so a typo has to be a compile error rather than a
 * silently different severity and a second de-duplication key (#85). The two names called directly on
 * `reportFailure` — `pane inbox read` and `harness failure` — are in the set too, because they are the ones
 * the old string comparison treated differently.
 */
export type FailureOp =
  | "agent log write"
  | "agent pane write"
  | "agent notice write"
  | "agent error handling"
  | "pane inbox read"
  | "harness failure";

/**
 * How loud each failure is.
 *
 * `pane inbox read` is the only warning: the inbox is an input channel, so a failed read degrades a feature
 * without losing anything already committed — unlike a failed log write. A table and not a comparison, so the
 * rule is visible where the names are.
 */
export const FAILURE_LEVEL: Record<FailureOp, "warn" | "error"> = {
  "agent log write": "error",
  "agent pane write": "error",
  "agent notice write": "error",
  "agent error handling": "error",
  "pane inbox read": "warn",
  "harness failure": "error",
};

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
  /** Last spend snapshot per agent, so each turn records its own delta (#T12). */
  private readonly lastStats = new Map<string, { tokens: number; cost: number | null }>();
  private readonly agentStream: AgentStream;
  private readonly inbox: PaneInbox;
  private readonly reportedFailures = new Set<string>();
  /** Turns each agent has settled, so a provider error is reported once per turn, not once per run. */
  private readonly settledTurns = new Map<string, number>();
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
      // Agent prose prints plain: colour marks who speaks, not who is named (#70).
      { write: (s) => this.stdout.write(s) },
      (agentId) => this.config.agentById.get(agentId)?.handle ?? agentId,
      (handle) => this.colourFor(handle),
      (text) => this.style(text),
      stampNow,
      Date.now,
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
      // A turn's timing starts at its dispatch, not at boot (#76).
      onDispatch: (agentId) => {
        // The pane says "working" when the work is handed over, not when the model's first byte
        // arrives: a 43 s wait for the first token is the room working, not the agent idling.
        this.markWorking(agentId);
        this.watchFailure("agent log write", agentId, this.appendAgentLog(agentId, "turn_start", ""));
      },
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

      // One subscription, switched on the event's own tag: the seam hands over everything the harness
      // said, so a field nobody prints today still reaches the room when it decides to print it (#81).
      this.pi.subscribe(agent.id, (event) => {
        switch (event.type) {
          case "message_end": {
            this.chat.messageBoundary(agent.id, event.text);
            this.chat.flush(agent.id);
            return;
          }
          case "stream": {
            this.markWorking(agent.id);
            this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "delta", event.delta));
            // The room sees the prose as it is written, not when the turn ends (#63).
            this.chat.delta(agent.id, event.delta);
            return;
          }
          case "tool_end": {
            // A missing duration is the harness's own word for "the tool did not run"; `0` is a call that
            // took no measurable time. The record keeps them apart (#81), so the line does too (#82).
            const ms = event.durationMs === undefined ? "never ran" : `${event.durationMs}ms`;
            this.watchFailure(
              "agent log write",
              agent.id,
              this.appendAgentLog(agent.id, "tool_end", `${event.name} ${ms}`),
            );
            if (event.isError) {
              // Identity is the call, not the operation: the same agent truncating twice is two facts, and
              // a run-long key would print the first and swallow the second.
              this.reportHarnessFailure(
                agent,
                `tool ${event.name} failed`,
                event.result ?? "the harness gave no reason",
                `tool_failed:${agent.id}:${event.toolCallId ?? event.name}`,
              );
            }
            return;
          }
          case "tool": {
            this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "tool_start", event.name));
            this.markWorking(agent.id);
            // A tool call cannot happen inside a sentence, so the line the provider left unterminated
            // ends here — otherwise "Got it: …" stays hidden until the turn's final report (#75).
            this.chat.flush(agent.id);
            this.watchFailure(
              "agent pane write",
              agent.id,
              this.agentStream.tool(agent.id, { name: event.name, args: event.args }),
            );
            return;
          }
          case "settled": {
            const r = event.result;
            const turn = (this.settledTurns.get(agent.id) ?? 0) + 1;
            this.settledTurns.set(agent.id, turn);
            // The provider's own verdict on the turn, reported once for each turn it spoils. A provider
            // error used to settle like a clean stop with no text, which the room printed as nothing.
            if (r.errorMessage !== undefined) {
              this.reportHarnessFailure(
                agent,
                "turn ended on a provider error",
                r.errorMessage,
                `provider_error:${agent.id}:${turn}`,
              );
            }
            // A turn that streamed nothing still ran: mark it before its text lands.
            this.markWorking(agent.id);
            // Only an agent that actually ran a turn moves its activity stamp.
            if (this.roomState) {
              const runtime = this.roomState.agents[agent.id];
              runtime.status = "idle";
              runtime.lastActivityAt = this.now();
            }
            // Stats first: the readout closes a turn at `settled`, so anything after it belongs to no turn.
            this.watchFailure(
              "agent log write",
              agent.id,
              (async () => {
                await this.appendTurnStats(agent.id);
                await this.appendAgentLog(agent.id, "settled", r.lastText ?? "");
              })(),
            );
            // A provider may settle with text and no deltas; then the room still needs the words.
            if (!this.chat.end(agent.id)) this.printAgentText(agent.handle, r.lastText);
            this.working.delete(agent.id);
            return;
          }
          case "error": {
            this.chat.end(agent.id, "turn failed");
            this.watchFailure("agent error handling", agent.id, this.handleAgentError(agent.id, event.error));
            return;
          }
        }
      });
      this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "spawned", `pid=${info.pid}`));
      if (this.panes) {
        const paneId = await this.panes.openAgentPane({
          id: `agent-${agent.id}`,
          // A title cannot carry an escape — herdr prints it as text — so the agent's colour is a
          // mark in the title instead (#72).
          title: `${markOf(agent.id, agentIndex)} ${plainName(agent.handle)}`,
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
    if (result !== null) await this.printSpend();
    this.roomStatus = result?.status === "halted" ? "halted" : "idle";
    this.inbox.start();
    await this.persistState();
    return result;
  }

  /** `targets` pins the first dispatch (pane input, #40); the chat pane leaves it unset. */
  submit(text: string, targets?: readonly string[]): Promise<SubmitResult> {
    this.inFlight += 1;
    // A submit waits behind whatever chain is running (submitQueue). Saying so is the difference
    // between a typed line that is queued and one that looks ignored — run 002 had a pasted line wait
    // nineteen minutes and then speak as an instruction nobody remembered writing (T18).
    if (this.inFlight > 1) {
      const waiting = this.inFlight - 1;
      const who = targets !== undefined && targets.length > 0 ? ` for ${(targets as string[]).map((id) => this.config.agentById.get(id)?.handle ?? id).join(", ")}` : "";
      const head = text.replace(/\s+/g, " ").slice(0, 60);
      this.stdout.write(roomLine("room", stampNow(), `· queued behind ${waiting} run${waiting === 1 ? "" : "s"}${who}: ${head}${text.length > 60 ? "…" : ""}\n`, (h) => this.colourFor(h)));
    }
    const run = this.submitQueue.then(async () => {
      this.roomStatus = "active";
      for (const agent of Object.values(this.roomState?.agents ?? {})) agent.status = "busy";
      await this.persistState();

      const result = await this.loop.submit(text, "user", targets);
      await this.printSpend();
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
    const mode = this.config.config.launch_guard ?? DEFAULT_LAUNCH_GUARD;
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

  /**
   * A failure the harness reported, through one funnel: one telemetry record, one `[error]` line in the
   * agent's pane, one `error` record in its log, and one room notice.
   *
   * The pane is for the operator watching the room; the notice is for the lead, who until now had to take
   * "the write was truncated" on the agent's word (#82). No halt: the agent is still working, which is
   * exactly what run 008's dev1 did for twenty minutes around two refused writes.
   */
  private reportHarnessFailure(agent: AgentSpec, message: string, reason: string, key: string): void {
    if (!this.reportFailure("harness failure", agent.id, reason, key, message)) return;
    this.watchFailure("agent log write", agent.id, this.appendAgentLog(agent.id, "error", `${message}: ${reason}`));
    this.watchFailure("agent pane write", agent.id, this.agentStream.line(agent.id, `[error] ${message}: ${reason}`));
    this.watchFailure("agent notice write", agent.id, this.noteHarnessFailure(agent.id, `${message}: ${reason}`));
  }

  /** The room's own note, so the lead reads the failure in the transcript it already watches. */
  private async noteHarnessFailure(agentId: string, text: string): Promise<void> {
    const chain = this.roomState?.chain;
    if (chain?.status !== "active" && chain?.status !== "wrap_up") return;
    await this.store.appendMessage({
      id: crypto.randomUUID(),
      ts: this.now(),
      kind: "notice",
      from: "room",
      handle: "room",
      text: `agent ${agentId}: ${text}`,
      mentions: [],
      chainId: chain.chainId,
      hop: chain.hopCount,
    });
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
  private watchFailure(op: FailureOp, agentId: string, work: Promise<void>): Promise<void> {
    return work.catch((e: unknown) => {
      this.reportFailure(op, agentId, e);
    });
  }

  /**
   * Report one agent's failure once, not once per poll or per delta.
   *
   * `key` defaults to the operation, which is what an internal write wants; the harness funnel passes the
   * failure's own identity instead (`tool_failed:<agent>:<callId>`), because an agent that truncates twice is
   * two facts (#82). The level comes from `FAILURE_LEVEL`, never from the spelling at the call site.
   */
  private reportFailure(
    op: FailureOp,
    agentId: string,
    e: unknown,
    key = `${op}:${agentId}`,
    message = `${op} failed`,
  ): boolean {
    if (this.reportedFailures.has(key)) return false;
    this.reportedFailures.add(key);
    this.telemetry.log(FAILURE_LEVEL[op], message, {
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

  /**
   * The pane says "working" the moment the room hands the agent work.
   *
   * The first stream delta arrives whenever the provider gets round to it — 43 s into a live lead
   * turn — and a pane that says "idle" for that long is reporting the provider's queue as the
   * agent's state.
   */
  private markWorking(agentId: string): void {
    if (this.working.has(agentId)) return;
    const handle = this.config.agentById.get(agentId)?.handle ?? agentId;
    this.working.add(agentId);
    // A pane has no recipient: the sigil is mention syntax, so it never appears here.
    this.watchFailure("agent pane write", agentId, this.agentStream.line(agentId, `${plainName(handle)} — working`));
  }

  private async appendAgentLog(agentId: string, event: string, text: string): Promise<void> {
    const path = this.agentLogs.get(agentId);
    if (!path) return;
    await appendFile(path, JSON.stringify({ ts: this.now(), event, text }) + "\n", "utf8");
  }

  /**
   * What the run spent, per agent, when the chain is over (#76).
   *
   * A room that costs money should say what it cost without being asked, and a provider that reports
   * nothing must read as "unknown" rather than "free". The pane is a scrollback, so the same numbers
   * are written to `summary.json`.
   */
  /**
   * What one agent's session says it has spent so far, or null when the provider stays quiet.
   *
   * The command's own timeout is 30s, which is longer than a human will wait to see what a run cost,
   * and longer than a turn can afford to stall on bookkeeping.
   */
  private async readStats(agentId: string): Promise<SessionStats | null> {
    if (this.pi.sessionStats === undefined) return null;
    try {
      return await Promise.race([
        this.pi.sessionStats(agentId),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("no answer in 5000ms")), 5000)),
      ]);
    } catch (e) {
      this.telemetry.log("info", "session stats unavailable", { agentId, error: errorMessage(e) });
      return null;
    }
  }

  /**
   * The delta this turn spent, recorded before `settled` so the timing readout can attribute it (#T12).
   *
   * A cumulative total repeated per turn says nothing about any single turn, which is why a run that
   * burned 1.3M tokens could not say which phase did it.
   */
  private async appendTurnStats(agentId: string): Promise<void> {
    const stats = await this.readStats(agentId);
    if (stats === null) return;
    if (stats.tokens.total === 0 && stats.cost === null) return;
    const prev = this.lastStats.get(agentId) ?? { tokens: 0, cost: 0 };
    // One unknown cost makes the turn's cost unknown, never partly known.
    const cost = stats.cost === null || prev.cost === null ? null : stats.cost - prev.cost;
    this.lastStats.set(agentId, { tokens: stats.tokens.total, cost: stats.cost });
    await this.appendAgentLog(
      agentId,
      "stats",
      JSON.stringify({ tokens: stats.tokens.total - prev.tokens, cost, toolCalls: stats.toolCalls }),
    );
  }

  private async printSpend(): Promise<void> {
    const rows: Array<{ agentId: string; handle: string; tokens: number; cost: number | null; toolCalls: number }> = [];
    for (const agent of this.config.allAgents) {
      if (this.pi.sessionStats === undefined) break;
      try {
        const stats = await this.readStats(agent.id);
        if (stats === null) continue;
        if (stats.tokens.total === 0 && stats.cost === null) continue;
        rows.push({
          agentId: agent.id,
          handle: agent.handle,
          tokens: stats.tokens.total,
          cost: stats.cost,
          toolCalls: stats.toolCalls,
        });
      } catch (e) {
        this.telemetry.log("info", "session stats unavailable", { agentId: agent.id, error: errorMessage(e) });
      }
    }
    if (rows.length === 0) return;

    const tokens = rows.reduce((n, r) => n + r.tokens, 0);
    const costs = rows.map((r) => r.cost);
    const known = costs.filter((c): c is number => c !== null);
    const sum = known.reduce((a, b) => a + b, 0);
    const total = known.length === 0 ? "unknown" : `$${sum < 0.01 ? sum.toFixed(4) : sum.toFixed(2)}`;
    this.printLine("── spend ──");
    for (const r of rows) {
      // A run under a cent is not free: $0.0036 printed as $0.00 reads as "no cost" (#76).
      const cost = r.cost === null ? "cost unknown" : `$${r.cost < 0.01 ? r.cost.toFixed(4) : r.cost.toFixed(2)}`;
      this.printLine(`  ${r.handle.padEnd(10)}${r.tokens} tokens · ${cost} · ${r.toolCalls} tool calls`);
    }
    this.printLine(`  total  ${tokens} tokens · ${total}`);
    try {
      await writeFile(join(this.config.config.room_dir, "summary.json"), JSON.stringify(rows, null, 2) + "\n", "utf8");
    } catch (e) {
      this.telemetry.log("warn", "summary write failed", { error: errorMessage(e) });
    }
  }

  /** One line of room preamble: a human watching the pane should know what is running. */
  private printLine(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  /** Before the first dispatch: what this room is, who is in it, and where it writes. */
  private printBanner(): void {
    const { name, room_dir: roomDir, task } = this.config.config;
    const handles = this.config.allAgents.map((a) => a.handle).join(" ");
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
      // The room's own note, not a participant's message: `[room]` and a `·` mark it as out-of-band,
      // so it cannot be read as somebody speaking (#68, #71).
      this.stdout.write(roomLine("room", stampNow(), `· ${msg.text}\n`, (h) => this.colourFor(h)));
      return;
    }
    // The time the line was said: with three agents talking, order has to be readable, not inferred (T17).
    this.stdout.write(roomLine(msg.handle, stampNow(), this.style(msg.text), (h) => this.colourFor(h)));
  }

  /** The room's brief: a framed block, so it reads as background rather than a command. */
  private printBrief(text: string): void {
    this.printLine("── brief ── background: what this room was launched to do");
    for (const line of text.split("\n")) this.printLine(line === "" ? "" : `  ${line}`);
    this.printLine("── end brief ──");
  }

  /** A settled reply whose turn streamed nothing: print it the way the room always has. */
  private printAgentText(handle: string, text: string | null): void {
    if (text === null || text.trim() === "") return;
    this.stdout.write(roomLine(handle, stampNow(), this.style(text), (h) => this.colourFor(h)));
  }

  /** Mentions are inverted when styling is on; with it off the text is untouched (#77, 1715407). */
  private style(text: string): string {
    if (!this.color) return text;
    return markMentions(text, (handle) => this.colourFor(handle) !== null);
  }

  /** The SGR payload for a handle, or null when colour is off or the handle is unknown. */
  private colourFor(handle: string): string | null {
    if (!this.color) return null;
    const agent = this.config.allAgents.find((a) => a.handle === handle);
    if (!agent) return null;
    const slot = this.config.allAgents.indexOf(agent);
    return colorOf(agent.id, slot);
  }
}
