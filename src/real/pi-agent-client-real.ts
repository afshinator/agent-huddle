import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSpec } from "../config";
import type {
  AgentEvent,
  AgentProcessInfo,
  PiAgentClient,
  PromptRequest,
  SessionStats,
  SettledResult,
  SpawnOptions,
} from "../seams/pi-agent-client";
import { AgentListeners, requireAgentEntry } from "../seams/pi-agent-client";
import { errorMessage } from "../errors";
import { shellWord } from "../shell";
import type { Debug } from "../debug";

interface PendingSettle {
  promise: Promise<SettledResult>;
  resolve: (r: SettledResult) => void;
  reject: (e: Error) => void;
}

interface RealAgent {
  id: string;
  child: ChildProcessWithoutNullStreams;
  sessionDir: string;
  pid: number;
  /** The assistant message currently streaming. */
  textBuffer: string;
  /** Messages this dispatch has already finished, in order: one turn can hold several (§T11). */
  turnMessages: string[];
  lastText: string | null;
  /** The provider's verdict from the turn's last `message_end`; the seam keeps it (#81). */
  stopReason?: string;
  /** The provider's own error text, when it sent one. */
  providerError?: string;
  pendingSettle: PendingSettle | null;
  exited: boolean;
  shuttingDown: boolean;
}

/** The fields this client reads off a JSONL record from `pi`. */
interface RpcRecord {
  type?: string;
  id?: string;
  success?: boolean;
  command?: string;
  error?: string;
  aborted?: boolean;
  data?: unknown;
  assistantMessageEvent?: { type?: string; delta?: string; content?: string };
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  /** Absent when the tool did not run; `0` when it ran and took no measurable time. */
  durationMs?: number;
  isError?: boolean;
  result?: unknown;
  message?: { role?: string; stopReason?: string; errorMessage?: string };
}

/** The text a tool's `result` carries: `{ content: [{ type: "text", text }] }`, or a bare string. */
function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) =>
      typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
  return text === "" ? undefined : text;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Drives one `pi --mode rpc` child process per agent (Q1/D7).
 *
 * JSONL framing on stdin/stdout: writes one object + `\n` per command, splits
 * stdout records on `\n` only (never `readline`, which also splits on U+2028/U+2029).
 * Correlates command responses by `id`; treats `agent_settled` (not `agent_end`)
 * as turn completion.
 */
export class RealPiAgentClient implements PiAgentClient {
  private readonly agents = new Map<string, RealAgent>();
  private readonly bus = new AgentListeners();
  private readonly pendingCommands = new Map<string, {
    agentId: string;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly commandTimeoutMs = 30_000;
  private cmdSeq = 0;

  /** One write chain per agent, so two chunks cannot land out of order (#36). */
  private readonly stderrWrites = new Map<string, Promise<void>>();
  private readonly stderrSink: { write(s: string): void };

  private readonly debug: Debug;

  constructor(
    private readonly opts: {
      roomDir: string;
      piBin?: string;
      stderr?: { write(s: string): void };
      /** Lifecycle trace; `AH_DEBUG=1` in the CLI wires it (#55). Silent by default. */
      debug?: Debug;
    },
  ) {
    this.stderrSink = opts.stderr ?? process.stderr;
    this.debug = opts.debug ?? (() => {});
  }

  private get piBin(): string {
    return this.opts.piBin ?? "pi";
  }

  async spawn(agent: AgentSpec, spawnOpts: SpawnOptions): Promise<AgentProcessInfo> {
    const sessionDir = join(this.opts.roomDir, "agents", agent.id, "sessions");
    await mkdir(sessionDir, { recursive: true });

    const args: string[] = [
      "--mode", "rpc",
      "--session-dir", sessionDir,
      "--session-id", agent.id,
    ];
    if (agent.provider) args.push("--provider", agent.provider);
    if (agent.model) args.push("--model", agent.model);
    if (agent.thinking) args.push("--thinking", agent.thinking);
    if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
    if (spawnOpts.systemPrompt) args.push("--system-prompt", spawnOpts.systemPrompt);
    if (spawnOpts.appendSystemPrompt) args.push("--append-system-prompt", spawnOpts.appendSystemPrompt);

    const child = spawn(this.piBin, args, {
      cwd: spawnOpts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // the live adapter tests open real herdr panes; a room's agent must never reach them (#58)
      env: { ...process.env, PI_TEST_INTEGRATION: "0" },
    });

    const info: AgentProcessInfo = { sessionDir, pid: child.pid ?? 0 };

    return new Promise<AgentProcessInfo>((resolve, reject) => {
      let done = false;
      const ok = (): void => {
        if (done) return;
        done = true;
        this.register(agent, child, info);
        resolve(info);
      };
      const fail = (e: Error): void => {
        if (done) return;
        done = true;
        reject(e);
      };
      child.once("spawn", ok);
      child.once("error", fail);
    });
  }

  async prompt(agentId: string, req: PromptRequest): Promise<void> {
    const agent = this.requireAgent(agentId);
    // A steer feeds the turn already in flight: it must neither replace that turn's settle nor clear
    // the buffers it is still filling, or `waitForSettled` waits on a promise nothing resolves (§T16).
    const steersLiveTurn = req.streamingBehavior === "steer" && agent.pendingSettle !== null;
    let rejectSettle: ((e: Error) => void) | null = null;
    if (!steersLiveTurn) {
      // A dispatch starts a turn: clear both buffers here, not on `agent_start`, which arrives
      // once per assistant message and would discard the ones before it (§T11). The provider's verdict
      // is per turn too: a `length` cut must not be read as the next turn's stop reason.
      agent.textBuffer = "";
      agent.turnMessages = [];
      agent.stopReason = undefined;
      agent.providerError = undefined;

      let resolveSettle!: (r: SettledResult) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<SettledResult>((res, rej) => {
        resolveSettle = res;
        reject = rej;
      });
      promise.catch(() => {}); // a rejected settle is observed via waitForSettled
      agent.pendingSettle = { promise, resolve: resolveSettle, reject };
      rejectSettle = reject;
    }

    const cmd: Record<string, unknown> = { type: "prompt", message: req.message };
    if (req.streamingBehavior) cmd.streamingBehavior = req.streamingBehavior;

    try {
      await this.command(agent, cmd);
    } catch (e) {
      // A steer that could not be delivered must not cancel the turn it was feeding.
      if (!steersLiveTurn) {
        agent.pendingSettle = null;
        rejectSettle!(e as Error);
      }
      throw e;
    }
  }

  /**
   * What this agent's session has spent. The provider decides whether it can say: `cost` stays null
   * when the response omits it, and the room prints "unknown" rather than inventing a number (#76).
   */
  async sessionStats(agentId: string): Promise<SessionStats> {
    const agent = this.requireAgent(agentId);
    const raw = (await this.command(agent, { type: "get_session_stats" })) as Record<string, unknown>;
    const tokens = (raw.tokens ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      tokens: {
        input: num(tokens.input),
        output: num(tokens.output),
        cacheRead: num(tokens.cacheRead),
        cacheWrite: num(tokens.cacheWrite),
        total: num(tokens.total),
      },
      cost: typeof raw.cost === "number" && Number.isFinite(raw.cost) ? raw.cost : null,
      toolCalls: num(raw.toolCalls),
    };
  }

  async pushContext(agentId: string, text: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    // bash echo stores a BashExecutionMessage (no run), which becomes a
    // UserMessage on the agent's next prompt — context without a reply (D8/Q3).
    await this.command(agent, {
      type: "bash",
      command: `echo ${shellWord(text)}`,
      excludeFromContext: false,
    });
  }

  async waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult> {
    const agent = this.requireAgent(agentId);
    const settle = agent.pendingSettle;
    // A turn that settled before anyone asked still carries its verdict: the provider's stop reason is
    // part of what the turn was, not part of the promise (#81).
    if (!settle) return { aborted: false, lastText: agent.lastText, ...this.verdict(agent) };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<SettledResult>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`settle timeout after ${timeoutMs}ms`)), timeoutMs);
        settle.promise.then(resolve, reject);
      });
    } catch (e) {
      agent.pendingSettle = null;
      try {
        await this.command(agent, { type: "abort" }, 5_000);
      } catch {
        // abort already in progress or process gone
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.exited) return;
    agent.shuttingDown = true;

    agent.child.stdin.end(); // orderly shutdown request
    await waitForExit(agent.child, 2000);
    if (agent.exited) return;

    agent.child.kill("SIGTERM");
    await waitForExit(agent.child, 2000);
    if (agent.exited) return;

    agent.child.kill("SIGKILL");
  }

  subscribe(agentId: string, fn: (event: AgentEvent) => void): void {
    this.bus.subscribe(agentId, fn);
  }

  /** Append the child's stderr to `agents/<id>/stderr.log`, in order. */
  private logStderr(agentId: string, text: string): void {
    const previous = this.stderrWrites.get(agentId) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        const dir = join(this.opts.roomDir, "agents", agentId);
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, "stderr.log"), text, "utf8");
      })
      .catch(() => undefined);
    this.stderrWrites.set(agentId, next);
  }

  private register(agent: AgentSpec, child: ChildProcessWithoutNullStreams, info: AgentProcessInfo): void {
    this.debug(`child spawn ${agent.id} pid=${info.pid}`);
    this.agents.set(agent.id, {
      id: agent.id,
      child,
      sessionDir: info.sessionDir,
      pid: info.pid,
      textBuffer: "",
      turnMessages: [],
      lastText: null,
      pendingSettle: null,
      exited: false,
      shuttingDown: false,
    });

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.trim() === "") continue;
        let rec: RpcRecord;
        try {
          rec = JSON.parse(line);
        } catch (error: unknown) {
          this.reportProtocolError(agent.id, `invalid JSON record: ${String(error)}`);
          continue;
        }
        this.handleRecord(agent.id, rec);
      }
    });

    // A child's stderr is the agent's, not the room's: the terminal is the conversation,
    // and pi's runtime warnings used to appear between room messages (#50). Keep them in
    // the agent's own file; pass them through only when the operator asks (PI_STDERR=1).
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.logStderr(agent.id, text);
      if (process.env.PI_STDERR === "1") this.stderrSink.write(`[pi:${agent.id}] ${text}`);
    });

    child.on("exit", (code, signal) => {
      this.debug(`child exit ${agent.id} code=${code} signal=${signal}`);
      const a = this.agents.get(agent.id);
      if (a) a.exited = true;
      if (a && !a.shuttingDown) {
        this.bus.emit(agent.id, { type: "error", error: new Error(`pi process for ${agent.id} exited unexpectedly`) });
      }
      for (const [id, p] of this.pendingCommands) {
        if (p.agentId === agent.id) {
          this.pendingCommands.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error(`pi process for ${agent.id} exited`));
        }
      }
      const settle = a?.pendingSettle;
      if (settle) {
        a!.pendingSettle = null;
        settle.reject(new Error(`pi process for ${agent.id} exited before settling`));
      }
    });
  }

  private handleRecord(agentId: string, rec: RpcRecord): void {
    if (rec.type === "response") {
      const responseId = rec.id;
      const pending = responseId ? this.pendingCommands.get(responseId) : undefined;
      if (pending && responseId) {
        this.pendingCommands.delete(responseId);
        clearTimeout(pending.timer);
        if (rec.success) pending.resolve(rec.data);
        else pending.reject(new Error(rec.error ?? `command ${rec.command} failed`));
      } else if (rec.success === false) {
        this.reportProtocolError(agentId, `unmatched failed response: ${rec.error ?? "unknown error"}`);
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (rec.type === "message_update") {
      const ev = rec.assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        agent.textBuffer += ev.delta;
        this.bus.emit(agentId, { type: "stream", delta: ev.delta });
      } else if (ev?.type === "text_end" && typeof ev.content === "string") {
        // A provider may emit text_end with no text_delta before it (nothing streamed): take the
        // content. Or it may restate only the last message of a turn whose earlier messages already
        // streamed: appending keeps them, and the buffer is what the ack check and DONE read (§T11).
        if (agent.textBuffer === "") {
          agent.textBuffer = ev.content;
        } else if (agent.textBuffer.endsWith(ev.content)) {
          // Already streamed: the boundary between the earlier messages and this one is the
          // only thing missing, and the record must show it.
          const prefix = agent.textBuffer.slice(0, agent.textBuffer.length - ev.content.length);
          if (prefix !== "") {
            if (!prefix.endsWith("\n")) agent.textBuffer = `${prefix}\n${ev.content}`;
            // The room has printed both messages glued; it needs the same boundary to split the
            // line it is still holding (#73).
            this.bus.emit(agentId, { type: "message_end", text: ev.content });
          }
        } else if (!agent.textBuffer.includes(ev.content)) {
          agent.textBuffer += `${agent.textBuffer.endsWith("\n") ? "" : "\n"}${ev.content}`;
        }
      }
      return;
    }

    // `agent_start` opens a message, so whatever streamed before it is a finished one.
    if (rec.type === "agent_start") {
      // shortcut: a retry inside one dispatch re-sends the same message, which would repeat
      // here; dedupe once a provider is seen doing it (T11 asked the question, no evidence yet).
      if (agent.textBuffer.trim() !== "") {
        agent.turnMessages.push(agent.textBuffer);
        // A new message starts on a new line in the room too; without this the live run showed
        // `…their files.go` when the model wrote "go" as a second message (§T11).
        if (!agent.textBuffer.endsWith("\n")) this.bus.emit(agentId, { type: "stream", delta: "\n" });
      }
      agent.textBuffer = "";
      return;
    }

    // The completed assistant message is the only record carrying the provider's own verdict on how the
    // turn stopped, and its error text. The room keeps both: a `length` cut and a clean `stop` are not the
    // same event to anyone reading the record (#81).
    if (rec.type === "message_end") {
      const message = rec.message;
      if (message?.role === "assistant") {
        if (typeof message.stopReason === "string") agent.stopReason = message.stopReason;
        if (typeof message.errorMessage === "string") agent.providerError = message.errorMessage;
      }
      return;
    }

    if (rec.type === "agent_settled") {
      const settle = agent.pendingSettle;
      if (!settle) return;

      void this.settleText(agent).then(
        (lastText) => {
          const result: SettledResult = {
            aborted: !!rec.aborted,
            lastText,
            ...this.verdict(agent),
          };
          agent.lastText = lastText;
          agent.pendingSettle = null;
          this.bus.emit(agentId, { type: "settled", result });
          settle.resolve(result);
        },
        (error: unknown) => {
          const err = asError(error);
          agent.pendingSettle = null;
          this.bus.emit(agentId, { type: "error", error: err });
          settle.reject(err);
        },
      );
      return;
    }

    if (rec.type === "tool_execution_start") {
      this.bus.emit(agentId, {
        type: "tool",
        name: typeof rec.toolName === "string" ? rec.toolName : "unknown",
        args: rec.args,
        ...(typeof rec.toolCallId === "string" ? { toolCallId: rec.toolCallId } : {}),
      });
      return;
    }

    // The end record is what makes a pause legible: without a duration, "the agent is thinking" and
    // "the tool is still running" look identical in the record (#76). It is also the only place the
    // harness says a call failed: a refused call arrives here with `isError` true, the reason in
    // `result`, and no `durationMs` because the tool never ran (#81).
    if (rec.type === "tool_execution_end") {
      const durationMs = typeof rec.durationMs === "number" ? rec.durationMs : undefined;
      const result = resultText(rec.result);
      this.bus.emit(agentId, {
        type: "tool_end",
        name: typeof rec.toolName === "string" ? rec.toolName : "unknown",
        isError: rec.isError === true,
        ...(typeof rec.toolCallId === "string" ? { toolCallId: rec.toolCallId } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(result === undefined ? {} : { result }),
      });
      return;
    }

    // agent_end, bash_execution_update, queue_update, etc. are ignored.
  }

  /** The provider's verdict on this turn, as the seam carries it (#81). */
  private verdict(agent: RealAgent): { stopReason?: string; errorMessage?: string } {
    return {
      ...(agent.stopReason === undefined ? {} : { stopReason: agent.stopReason }),
      ...(agent.providerError === undefined ? {} : { errorMessage: agent.providerError }),
    };
  }

  /**
   * The text this turn produced.
   *
   * The turn's own accumulation comes first: the room printed exactly these deltas, so recording
   * anything else makes the transcript and the record disagree — a live run showed `Got it: …` in
   * the chat while the settled record began at the turn's last message (#64). The provider's
   * "last assistant text" is the fallback for a turn that streamed nothing (a resumed session).
   */
  private async settleText(agent: RealAgent): Promise<string | null> {
    const turn = [...agent.turnMessages, agent.textBuffer].filter((m) => m.trim() !== "");
    if (turn.length > 0) {
      agent.turnMessages = [];
      return turn.join("\n");
    }
    const data = await this.command(agent, { type: "get_last_assistant_text" });
    const text = (data as { text?: unknown } | undefined)?.text;
    return typeof text === "string" ? text : null;
  }

  private reportProtocolError(agentId: string, message: string): void {
    this.bus.emit(agentId, { type: "error", error: new Error(`pi RPC protocol error: ${message}`) });
  }

  private command(
    agent: RealAgent,
    cmd: Record<string, unknown>,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<unknown> {
    const id = `cmd-${++this.cmdSeq}`;
    const full = { ...cmd, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(id);
        reject(new Error(`pi command ${String(cmd.type)} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingCommands.set(id, { agentId: agent.id, resolve, reject, timer });
      agent.child.stdin.write(JSON.stringify(full) + "\n", (err) => {
        if (err) {
          this.pendingCommands.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private requireAgent(agentId: string): RealAgent {
    return requireAgentEntry(this.agents, agentId, "RealPiAgentClient");
  }
}
