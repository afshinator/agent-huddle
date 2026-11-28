import { join } from "node:path";
import type { AgentSpec } from "../config";
import { awaitSettle, childExitedMessage, settledResult, steersInFlight } from "./turn";

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
  /** The provider's own verdict on how the turn stopped (`stop`, `length`, `aborted`, `error`). */
  stopReason?: string;
  /** The provider's error text, when it stopped with one. */
  errorMessage?: string;
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
  /**
   * Every event this agent's process produced, in order, as one union.
   *
   * One callback rather than a method per event: a field the harness sends but the room ignores today
   * still crosses the boundary, and a new field is a compile error in every listener and in the fake
   * (#81). What each harness record contributes is in the doc block above `AgentEvent`.
   */
  subscribe(agentId: string, fn: (event: AgentEvent) => void): void;
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
  /** The provider's verdict on how the turn stopped (`stop`, `length`, `error`), when a test scripts one. */
  stopReason?: string;
  /** The provider's error text, the way a run that ends on one reports it (#82). */
  errorMessage?: string;
  hold?: boolean; // leave the turn unsettled, so "shutdown mid-turn" is testable
}

export interface RecordedCall {
  op: "spawn" | "prompt" | "pushContext" | "waitForSettled" | "shutdown";
  agentId: string;
  payload: unknown;
}


/**
 * What the room keeps from the records pi sends. Sources: `docs/json.md` in the installed pi package,
 * sections "Session events" and "Tool execution events".
 *
 * | harness record | kept | dropped on purpose |
 * |---|---|---|
 * | `message_update` (`text_delta`, `text_end`) | `assistantMessageEvent.delta`, `.content` | `partial` snapshots and cumulative `usage` (the session-stats command answers spend) |
 * | `agent_start` | the message boundary it marks | nothing else it carries |
 * | `message_end` | `message.stopReason`, `message.errorMessage` | `message.content` (already streamed), `timestamp` |
 * | `agent_settled` | `aborted` | nothing else it carries |
 * | `tool_execution_start` | `toolName`, `args`, `toolCallId` | nothing else it carries |
 * | `tool_execution_end` | `toolName`, `toolCallId`, `isError`, `durationMs`, `result` text | `result.details` (bulk, never printed) |
 * | `response` | `id`, `success`, `data`, `error` (command correlation, no event) | nothing else it carries |
 *
 * Every other record type `pi` documents (`message_start`, `turn_end`, `agent_end`, the retry and
 * compaction notices) is ignored: no event depends on it today. A field the room needs starts in the table
 * above, so the next one is a deliberate row rather than a silent drop.
 *
 * A missing `durationMs` is kept as a missing field. The harness documents it as "absent when the tool
 * did not run"; `0` means it ran and took no measurable time, and coalescing the two throws away the
 * only signal a refused call carries (#81).
 */
export type AgentEvent =
  | { type: "settled"; result: SettledResult }
  | { type: "stream"; delta: string }
  | { type: "error"; error: Error }
  | { type: "tool"; name: string; args: unknown; toolCallId?: string }
  /** A new assistant message began inside text already streamed: the last `text` chars are it (#73). */
  | { type: "message_end"; text: string }
  | {
      type: "tool_end";
      name: string;
      /** The harness's own verdict. A refused call reports `true` and carries its reason in `result`. */
      isError: boolean;
      toolCallId?: string;
      /** Absent: the tool never ran. `0`: it ran and took no measurable time. */
      durationMs?: number;
      /** The tool's result text, or the harness's refusal message. */
      result?: string;
    };

/**
 * What one agent has spent. `cost` is null when the provider does not report it — a room must be able
 * to say "unknown" rather than invent a number.
 */
export interface SessionStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number | null;
  toolCalls: number;
}

/** Per-agent event fan-out shared by the fake and the real client. */
export class AgentListeners {
  private readonly byAgent = new Map<string, Array<(event: AgentEvent) => void>>();

  subscribe(agentId: string, fn: (event: AgentEvent) => void): void {
    const listeners = this.byAgent.get(agentId);
    if (listeners) listeners.push(fn);
    else this.byAgent.set(agentId, [fn]);
  }

  emit(agentId: string, event: AgentEvent): void {
    for (const fn of this.byAgent.get(agentId) ?? []) fn(event);
  }

  /**
   * Listeners are the room's, not the child's: they survive a spawn. Dropping them here is how
   * D20's "hand on what it wrote" died in a live room while every stub test stayed green (#T13).
   */
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
  /** How the turn that settled last stopped, so a caller asking again gets the same record. */
  lastAborted: boolean;
  stopReason?: string;
  errorMessage?: string;
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
    // new prompt would do. `steersInFlight` is the rule the real client applies too.
    if (steersInFlight(req.streamingBehavior, a.settle !== null)) return;
    const turn = a.script.shift() ?? { lastText: null };
    // A new turn clears what the last one said about how it stopped, exactly as the real client's
    // `prompt` clears its per-turn verdict (§T11).
    a.lastAborted = false;
    a.stopReason = undefined;
    a.errorMessage = undefined;

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
        this.bus.emit(agentId, { type: "error", error: turn.error });
        a.lastText = null;
        rejectSettle(turn.error);
        return;
      }
      for (const tool of turn.tools ?? []) {
        this.bus.emit(agentId, { type: "tool", name: tool.name, args: tool.args });
      }
      for (const delta of turn.deltas ?? []) {
        this.bus.emit(agentId, { type: "stream", delta });
      }
      // A held turn means the settle never arrives, not that the model said nothing:
      // production streams deltas before it settles, so the fake must too (#63).
      if (turn.hold) return;
      const result = settledResult({
        aborted: turn.aborted ?? false,
        lastText: turn.lastText ?? null,
        stopReason: turn.stopReason,
        errorMessage: turn.errorMessage,
      });
      a.lastText = result.lastText;
      a.lastAborted = result.aborted;
      a.stopReason = result.stopReason;
      a.errorMessage = result.errorMessage;
      // A settled turn is no longer pending, the way the real client clears `pendingSettle` when the
      // harness settles it: anything asked afterwards answers from the record, not from a promise.
      a.settle = null;
      resolveSettle(result);
      this.bus.emit(agentId, { type: "settled", result });
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
    // A released turn carries no verdict: the script never said how it stopped.
    a.lastAborted = false;
    a.stopReason = undefined;
    a.errorMessage = undefined;
    const result = settledResult({ aborted: false, lastText });
    settle.resolve(result);
    this.bus.emit(agentId, { type: "settled", result });
  }

  /** Emit a tool start on a turn already in flight (T16). */
  toolStarted(agentId: string, name = "bash"): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, { type: "tool", name, args: {} });
  }

  /** Emit that tool's end, so a test can show a long call finishing (T16). */
  toolFinished(agentId: string, name = "bash", durationMs = 1): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, { type: "tool_end", name, isError: false, durationMs });
  }

  /**
   * Emit a tool end the harness refused, the way a truncated call arrives: an error verdict, the
   * reason in `result`, and no `durationMs` because the tool never ran (#81).
   */
  toolFailed(
    agentId: string,
    name = "bash",
    result = "the tool call was not executed",
    opts: { toolCallId?: string; durationMs?: number } = {},
  ): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, {
      type: "tool_end",
      name,
      isError: true,
      result,
      ...(opts.toolCallId === undefined ? {} : { toolCallId: opts.toolCallId }),
      ...(opts.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
    });
  }

  /** Emit a tool end that never ran and did not fail: no `durationMs`, which is what says "did not run". */
  toolNeverRan(agentId: string, name = "bash"): void {
    const a = this.requireAgent(agentId);
    if (!a.settle) return;
    this.bus.emit(agentId, { type: "tool_end", name, isError: false });
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
    this.bus.emit(agentId, { type: "stream", delta });
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
    if (!a.settle) {
      // The turn already settled: the caller still gets the record it left, not a bare text.
      return settledResult({
        aborted: a.lastAborted,
        lastText: a.lastText,
        stopReason: a.stopReason,
        errorMessage: a.errorMessage,
      });
    }
    return await awaitSettle(a.settle.promise, timeoutMs);
  }

  async shutdown(agentId: string): Promise<void> {
    const failure = this.takeFailure("shutdown");
    if (failure) throw failure.error;
    const a = this.requireAgent(agentId);
    a.shutdown = true;
    this.record("shutdown", agentId, undefined);
    // The real client rejects a pending settle when its child exits; without this the
    // fake let a held turn outlive shutdown, hiding what a stop mid-turn really does.
    // The wording comes from the shared module, because it reaches a notice (#52, #88).
    const settle = a.settle;
    a.settle = null;
    settle?.reject(new Error(childExitedMessage(agentId)));
  }

  subscribe(agentId: string, fn: (event: AgentEvent) => void): void {
    this.bus.subscribe(agentId, fn);
  }

  private requireAgent(agentId: string): FakeAgent {
    return requireAgentEntry(this.agents, agentId, "FakePiAgentClient");
  }

  /** Lazily register an agent so `script()` can queue turns before `spawn()`. */
  private ensure(agentId: string): FakeAgent {
    let a = this.agents.get(agentId);
    if (!a) {
      a = { spawned: false, shutdown: false, script: [], lastText: null, lastAborted: false, settle: null };
      this.agents.set(agentId, a);
    }
    return a;
  }

  private record(op: RecordedCall["op"], agentId: string, payload: unknown): void {
    this.calls.push({ op, agentId, payload });
  }
}
