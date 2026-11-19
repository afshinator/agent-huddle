import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSpec } from "../config";
import type {
  AgentProcessInfo,
  PiAgentClient,
  PromptRequest,
  SettledResult,
  SpawnOptions,
} from "../seams/pi-agent-client";

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
  textBuffer: string;
  lastText: string | null;
  pendingSettle: PendingSettle | null;
  exited: boolean;
}

type ListenerEvent = "settled" | "stream" | "error";

/** POSIX single-quote escaping: `'` → `'\''`; newlines stay literal inside quotes. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
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
  private readonly listeners = new Map<string, Map<ListenerEvent, Array<(arg: any) => void>>>();
  private readonly pendingCommands = new Map<string, { agentId: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private cmdSeq = 0;

  constructor(private readonly opts: { roomDir: string; piBin?: string }) {}

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
    agent.textBuffer = "";

    let resolveSettle!: (r: SettledResult) => void;
    let rejectSettle!: (e: Error) => void;
    const promise = new Promise<SettledResult>((res, rej) => {
      resolveSettle = res;
      rejectSettle = rej;
    });
    promise.catch(() => {}); // a rejected settle is observed via waitForSettled
    agent.pendingSettle = { promise, resolve: resolveSettle, reject: rejectSettle };

    const cmd: Record<string, unknown> = { type: "prompt", message: req.message };
    if (req.streamingBehavior) cmd.streamingBehavior = req.streamingBehavior;

    try {
      await this.command(agent, cmd);
    } catch (e) {
      agent.pendingSettle = null;
      rejectSettle(e as Error);
      throw e;
    }
  }

  async pushContext(agentId: string, text: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    // bash echo stores a BashExecutionMessage (no run), which becomes a
    // UserMessage on the agent's next prompt — context without a reply (D8/Q3).
    await this.command(agent, {
      type: "bash",
      command: `echo ${shellQuote(text)}`,
      excludeFromContext: false,
    });
  }

  async waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult> {
    const agent = this.requireAgent(agentId);
    const settle = agent.pendingSettle;
    if (!settle) return { aborted: false, lastText: agent.lastText };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<SettledResult>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`agent ${agentId} settle timeout after ${timeoutMs}ms`)), timeoutMs);
        settle.promise.then(resolve, reject);
      });
    } catch (e) {
      agent.pendingSettle = null;
      try {
        await this.command(agent, { type: "abort" });
      } catch {
        // abort already in progress or process gone
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async getLastAssistantText(agentId: string): Promise<string | null> {
    return this.requireAgent(agentId).lastText;
  }

  async shutdown(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.exited) return;

    agent.child.stdin.end(); // orderly shutdown request
    await waitForExit(agent.child, 2000);
    if (agent.exited) return;

    agent.child.kill("SIGTERM");
    await waitForExit(agent.child, 2000);
    if (agent.exited) return;

    agent.child.kill("SIGKILL");
  }

  on(event: ListenerEvent, agentId: string, fn: (arg: any) => void): void {
    this.listeners.get(agentId)!.get(event)!.push(fn);
  }

  private register(agent: AgentSpec, child: ChildProcessWithoutNullStreams, info: AgentProcessInfo): void {
    this.agents.set(agent.id, {
      id: agent.id,
      child,
      sessionDir: info.sessionDir,
      pid: info.pid,
      textBuffer: "",
      lastText: null,
      pendingSettle: null,
      exited: false,
    });
    this.listeners.set(agent.id, new Map<ListenerEvent, Array<(arg: any) => void>>([
      ["settled", []],
      ["stream", []],
      ["error", []],
    ]));

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.trim() === "") continue;
        let rec: Record<string, any>;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // non-protocol garbage on stdout
        }
        this.handleRecord(agent.id, rec);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[pi:${agent.id}] ${chunk.toString("utf8")}`);
    });

    child.on("exit", () => {
      const a = this.agents.get(agent.id);
      if (a) a.exited = true;
      for (const [id, p] of this.pendingCommands) {
        if (p.agentId === agent.id) {
          this.pendingCommands.delete(id);
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

  private handleRecord(agentId: string, rec: Record<string, any>): void {
    if (rec.type === "response") {
      const pending = rec.id ? this.pendingCommands.get(rec.id) : undefined;
      if (pending) {
        this.pendingCommands.delete(rec.id);
        if (rec.success) pending.resolve(rec.data);
        else pending.reject(new Error(rec.error ?? `command ${rec.command} failed`));
      }
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) return;

    if (rec.type === "message_update") {
      const ev = rec.assistantMessageEvent;
      // shortcut: lastText is delta-accumulated; text_end authoritative content
      // is not applied. Works for all pi streamed providers; upgrade if a model
      // ever yields empty replies.
      if (ev && ev.type === "text_delta" && typeof ev.delta === "string") {
        agent.textBuffer += ev.delta;
        this.emit(agentId, "stream", ev.delta);
      }
      return;
    }

    // Reset per low-level run so a retry does not concatenate attempts.
    if (rec.type === "agent_start") {
      agent.textBuffer = "";
      return;
    }

    if (rec.type === "agent_settled") {
      const result: SettledResult = { aborted: !!rec.aborted, lastText: agent.textBuffer };
      agent.lastText = result.lastText;
      const settle = agent.pendingSettle;
      agent.pendingSettle = null;
      this.emit(agentId, "settled", result);
      if (settle) settle.resolve(result);
      return;
    }

    // agent_end, bash_execution_update, queue_update, etc. are ignored.
  }

  private command(agent: RealAgent, cmd: Record<string, unknown>): Promise<unknown> {
    const id = `cmd-${++this.cmdSeq}`;
    const full = { ...cmd, id };
    // shortcut: no command-acceptance timeout; a hung (not exited) pi would
    // hang the caller. Upgrade if a run ever wedges on prompt acceptance.
    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { agentId: agent.id, resolve, reject });
      agent.child.stdin.write(JSON.stringify(full) + "\n", (err) => {
        if (err) {
          this.pendingCommands.delete(id);
          reject(err);
        }
      });
    });
  }

  private emit(agentId: string, event: ListenerEvent, arg: any): void {
    for (const fn of this.listeners.get(agentId)!.get(event)!) fn(arg);
  }

  private requireAgent(agentId: string): RealAgent {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`RealPiAgentClient: unknown agent "${agentId}"`);
    return a;
  }
}
