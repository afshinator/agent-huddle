import { join } from "node:path";
import type { AgentSpec } from "../config";

export interface SpawnOptions {
  cwd: string;
  systemPrompt?: string;        // --system-prompt (built by T5 buildRolePrompt)
  appendSystemPrompt?: string;  // --append-system-prompt (built by T5 buildSocialContract)
}

export interface PromptRequest {
  message: string;                 // composed room message for this turn
  streamingBehavior?: "followUp" | "steer";
}

export interface SettledResult {
  aborted: boolean;
  lastText: string | null;
}

export interface AgentProcessInfo {
  sessionDir: string;
  sessionFile?: string;
  pid: number;
}

export interface PiAgentClient {
  spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo>;
  prompt(agentId: string, req: PromptRequest): Promise<void>;      // accepted, not settled
  pushContext(agentId: string, text: string): Promise<void>;       // D8/Q3 (§6.6)
  waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult>;
  shutdown(agentId: string): Promise<void>;
  on(event: "settled", agentId: string, fn: (r: SettledResult) => void): void;
  on(event: "stream", agentId: string, fn: (delta: string) => void): void;
  on(event: "error", agentId: string, fn: (err: Error) => void): void;
  on(event: "tool", agentId: string, fn: (t: { name: string; args: unknown }) => void): void;
  /** A new assistant message began inside text already streamed: the last `text` chars are it (#73). */
  on(event: "message_end", agentId: string, fn: (m: { text: string }) => void): void;
  /** A tool call finished. `durationMs` is what the tool's own `execute()` took (#76). */
  on(event: "tool_end", agentId: string, fn: (t: { name: string; durationMs?: number }) => void): void;
  /** Tokens and cost this agent's session has spent so far, when the provider reports them. */
  sessionStats?(agentId: string): Promise<SessionStats>;
}

/** One scripted turn: stream deltas then a settled result (or an error). */
export interface ScriptedTurn {
  tools?: Array<{ name: string; args: unknown }>;
  deltas?: string[];
  lastText?: string | null;
  aborted?: boolean;
  error?: Error;
  hold?: boolean; // leave the turn unsettled, so "shutdown mid-turn" is testable
}

export interface RecordedCall {
  op: "spawn" | "prompt" | "pushContext" | "waitForSettled" | "shutdown";
  agentId: string;
  payload: unknown;
}


/** Payload per event on the `PiAgentClient` listener seam. */
export interface AgentEventMap {
  settled: SettledResult;
  stream: string;
  error: Error;
  /** A tool the agent started running. `args` is whatever the tool received. */
  tool: { name: string; args: unknown };
  /** Where a new assistant message starts, inside text already streamed (see `ChatStream`). */
  message_end: { text: string };
  tool_end: { name: string; durationMs?: number };
}

/**
 * What one agent has spent. `cost` is null when the provider does not report it — a room must be able
 * to say "unknown" rather than invent a number.
 */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number | null;
  toolCalls: number;
}

export type AgentEvent = keyof AgentEventMap;

interface AgentListenerLists {
  settled: Array<(r: SettledResult) => void>;
  stream: Array<(delta: string) => void>;
  error: Array<(err: Error) => void>;
  tool: Array<(t: { name: string; args: unknown }) => void>;
  message_end: Array<(m: { text: string }) => void>;
  tool_end: Array<(t: { name: string; durationMs?: number }) => void>;
}

/** Per-agent event fan-out shared by the fake and the real client. */
export class AgentListeners {
  private readonly byAgent = new Map<string, AgentListenerLists>();

  on<K extends AgentEvent>(event: K, agentId: string, fn: (arg: AgentEventMap[K]) => void): void {
    (this.lists(agentId)[event] as Array<(arg: AgentEventMap[K]) => void>).push(fn);
  }

  emit<K extends AgentEvent>(agentId: string, event: K, arg: AgentEventMap[K]): void {
    for (const fn of this.lists(agentId)[event] as Array<(arg: AgentEventMap[K]) => void>) fn(arg);
  }

  /**
   * Listeners are the room's, not the child's: they survive a spawn. Dropping them here is how
   * D20's "hand on what it wrote" died in a live room while every stub test stayed green (#T13).
   */

  private lists(agentId: string): AgentListenerLists {
    let lists = this.byAgent.get(agentId);
    if (!lists) {
      lists = { settled: [], stream: [], error: [], tool: [], message_end: [], tool_end: [] };
      this.byAgent.set(agentId, lists);
    }
    return lists;
  }
}

/** Look an agent up, or fail with the client's name in the message. */
export function requireAgentEntry<T>(agents: Map<string, T>, agentId: string, client: string): T {
  const entry = agents.get(agentId);
  if (!entry) throw new Error(`${client}: unknown agent "${agentId}"`);
  return entry;
}

interface FakeAgent {
  spec?: AgentSpec;
  spawned: boolean;
  shutdown: boolean;
  script: ScriptedTurn[];
  lastText: string | null;
  settle: { promise: Promise<SettledResult>; resolve: (r: SettledResult) => void; reject: (e: Error) => void } | null;
}

export type FakePiOp = "spawn" | "prompt" | "pushContext" | "waitForSettled" | "shutdown";

export class FakePiAgentClient implements PiAgentClient {
  readonly calls: RecordedCall[] = [];
  private readonly agents = new Map<string, FakeAgent>();
  private readonly bus = new AgentListeners();
  private readonly failures = new Map<FakePiOp, unknown[]>();
  /** What each agent's session reports it spent, when a test sets it. */
  private readonly stats = new Map<string, SessionStats>();
  private nextPid = 1000;

  constructor(private readonly baseDir = "/fake/sessions") {}

  /**
   * Reject the next `times` calls to `op` after `skip` successful ones.
   * A failed call is not recorded, so `calls` keeps meaning "operations that happened".
   */
  failOn(op: FakePiOp, error: unknown, times = 1, skip = 0): void {
    for (let i = 0; i < skip; i += 1) this.failures.set(op, [...(this.failures.get(op) ?? []), undefined]);
    for (let i = 0; i < times; i += 1) this.failures.set(op, [...(this.failures.get(op) ?? []), error]);
  }

  private takeFailure(op: FakePiOp): { error: unknown } | null {
    const queue = this.failures.get(op);
    if (!queue || queue.length === 0) return null;
    const error = queue.shift();
    return error === undefined ? null : { error };
  }

  /** Queue scripted turns for an agent (consumed FIFO on each prompt). */
  script(agentId: string, turns: ScriptedTurn[]): void {
    this.ensure(agentId).script.push(...turns);
  }

  async spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo> {
    const failure = this.takeFailure("spawn");
    if (failure) throw failure.error;
    const a = this.ensure(agent.id);
    a.spec = agent;
    a.spawned = true;
    a.shutdown = false;
    this.record("spawn", agent.id, opts);
    return { sessionDir: join(this.baseDir, agent.id, "sessions"), pid: this.nextPid++ };
  }

  async prompt(agentId: string, req: PromptRequest): Promise<void> {
    const failure = this.takeFailure("prompt");
    if (failure) throw failure.error;
    const a = this.requireAgent(agentId);
    this.record("prompt", agentId, req);
    // A steer feeds a turn already in flight: it must not replace that turn's settle, which is what a
    // new prompt would do. The real client's turn keeps running and settles once (T16).
    if (req.streamingBehavior === "steer" && a.settle !== null) return;
    const turn = a.script.shift() ?? { lastText: null };

    let resolveSettle!: (r: SettledResult) => void;
    let rejectSettle!: (e: Error) => void;
    const promise = new Promise<SettledResult>((res, rej) => {
      resolveSettle = res;
      rejectSettle = rej;
    });
    promise.catch(() => {}); // a rejected turn is observed via waitForSettled
    a.settle = { promise, resolve: resolveSettle, reject: rejectSettle };

    queueMicrotask(() => {
      if (turn.error) {
        this.bus.emit(agentId, "error", turn.error);
        a.lastText = null;
        rejectSettle(turn.error);
        return;
      }
      for (const tool of turn.tools ?? []) {
        this.bus.emit(agentId, "tool", tool);
      }
      for (const delta of turn.deltas ?? []) {
        this.bus.emit(agentId, "stream", delta);
      }
      // A held turn means the settle never arrives, not that the model said nothing:
      // production streams deltas before it settles, so the fake must too (#63).
      if (turn.hold) return;
      const result: SettledResult = {
        aborted: turn.aborted ?? false,
        lastText: turn.lastText ?? null,
      };
      a.lastText = result.lastText;
      resolveSettle(result);
      this.bus.emit(agentId, "settled", result);
    });
  }

  /**
   * Settle a held turn now, the way production does when the model finishes.
   *
   * `hold` exists so a test can look at a room with two turns in flight at once; without a release the
   * only way out of a held turn is a timeout, which is a different test.
   */
  release(agentId: string, lastText: string | null = null): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    const settle = a.settle;
    a.settle = null;
    a.lastText = lastText;
    const result: SettledResult = { aborted: false, lastText };
    settle.resolve(result);
    this.bus.emit(agentId, "settled", result);
  }

  /** Emit a tool start on a turn already in flight (T16). */
  toolStarted(agentId: string, name = "bash"): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, "tool", { name, args: {} });
  }

  /** Emit that tool's end, so a test can show a long call finishing (T16). */
  toolFinished(agentId: string, name = "bash", durationMs = 1): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, "tool_end", { name, durationMs });
  }

  /**
   * Emit a stream delta on a turn already in flight, so a test can watch a live turn.
   *
   * A real agent sends a sentence or a tool call every few seconds; a script that dumps its deltas
   * and then holds cannot show that, which is the difference the idle nudge turns on.
   */
  streamDelta(agentId: string, delta: string): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, "stream", delta);
  }

  async pushContext(agentId: string, text: string): Promise<void> {
    const failure = this.takeFailure("pushContext");
    if (failure) throw failure.error;
    this.requireAgent(agentId);
    this.record("pushContext", agentId, text);
  }

  /** Script what an agent's session reports it spent. */
  setSessionStats(agentId: string, stats: SessionStats): void {
    this.requireAgent(agentId);
    this.stats.set(agentId, stats);
  }

  async sessionStats(agentId: string): Promise<SessionStats> {
    this.requireAgent(agentId);
    return this.stats.get(agentId) ?? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: null, toolCalls: 0 };
  }

  async waitForSettled(agentId: string, timeoutMs: number): Promise<SettledResult> {
    const a = this.requireAgent(agentId);
    this.record("waitForSettled", agentId, timeoutMs);
    const failure = this.takeFailure("waitForSettled");
    if (failure) throw failure.error;
    if (!a.settle) return { aborted: false, lastText: a.lastText };
    // Same budget and same wording as the real client: a fake that waits forever cannot exercise
    // what a turn does when its provider goes quiet (see `client-parity.test.ts`).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<SettledResult>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`settle timeout after ${timeoutMs}ms`)), timeoutMs);
        a.settle!.promise.then(resolve, reject);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(agentId: string): Promise<void> {
    const failure = this.takeFailure("shutdown");
    if (failure) throw failure.error;
    const a = this.requireAgent(agentId);
    a.shutdown = true;
    this.record("shutdown", agentId, undefined);
    // The real client rejects a pending settle when its child exits; without this the
    // fake let a held turn outlive shutdown, hiding what a stop mid-turn really does.
    // Same wording as the real client (`src/real/pi-agent-client-real.ts`), because the
    // message reaches a notice and test/client-parity.test.ts compares the two (#52).
    const settle = a.settle;
    a.settle = null;
    settle?.reject(new Error(`pi process for ${agentId} exited before settling`));
  }

  on<K extends AgentEvent>(event: K, agentId: string, fn: (arg: AgentEventMap[K]) => void): void {
    this.bus.on(event, agentId, fn);
  }

  private requireAgent(agentId: string): FakeAgent {
    return requireAgentEntry(this.agents, agentId, "FakePiAgentClient");
  }

  /** Lazily register an agent so `script()` can queue turns before `spawn()`. */
  private ensure(agentId: string): FakeAgent {
    let a = this.agents.get(agentId);
    if (!a) {
      a = { spawned: false, shutdown: false, script: [], lastText: null, settle: null };
      this.agents.set(agentId, a);
    }
    return a;
  }

  private record(op: RecordedCall["op"], agentId: string, payload: unknown): void {
    this.calls.push({ op, agentId, payload });
  }
}
