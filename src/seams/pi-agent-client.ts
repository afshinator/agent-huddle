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
}

/** One scripted turn: stream deltas then a settled result (or an error). */
export interface ScriptedTurn {
  deltas?: string[];
  lastText?: string | null;
  aborted?: boolean;
  error?: Error;
}

export interface RecordedCall {
  op: "spawn" | "prompt" | "pushContext" | "shutdown";
  agentId: string;
  payload: unknown;
}


/** Payload per event on the `PiAgentClient` listener seam. */
export interface AgentEventMap {
  settled: SettledResult;
  stream: string;
  error: Error;
}

export type AgentEvent = keyof AgentEventMap;

interface AgentListenerLists {
  settled: Array<(r: SettledResult) => void>;
  stream: Array<(delta: string) => void>;
  error: Array<(err: Error) => void>;
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

  /** Drop every listener registered for an agent (used when a session restarts). */
  reset(agentId: string): void {
    this.byAgent.delete(agentId);
  }

  private lists(agentId: string): AgentListenerLists {
    let lists = this.byAgent.get(agentId);
    if (!lists) {
      lists = { settled: [], stream: [], error: [] };
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
  settle: { promise: Promise<SettledResult>; resolve: (r: SettledResult) => void } | null;
}

export class FakePiAgentClient implements PiAgentClient {
  readonly calls: RecordedCall[] = [];
  private readonly agents = new Map<string, FakeAgent>();
  private readonly bus = new AgentListeners();
  private nextPid = 1000;

  constructor(private readonly baseDir = "/fake/sessions") {}

  /** Queue scripted turns for an agent (consumed FIFO on each prompt). */
  script(agentId: string, turns: ScriptedTurn[]): void {
    this.ensure(agentId).script.push(...turns);
  }

  async spawn(agent: AgentSpec, opts: SpawnOptions): Promise<AgentProcessInfo> {
    const a = this.ensure(agent.id);
    a.spec = agent;
    a.spawned = true;
    a.shutdown = false;
    this.record("spawn", agent.id, opts);
    return { sessionDir: join(this.baseDir, agent.id, "sessions"), pid: this.nextPid++ };
  }

  async prompt(agentId: string, req: PromptRequest): Promise<void> {
    const a = this.requireAgent(agentId);
    this.record("prompt", agentId, req);
    const turn = a.script.shift() ?? { lastText: null };

    let resolveSettle!: (r: SettledResult) => void;
    let rejectSettle!: (e: Error) => void;
    const promise = new Promise<SettledResult>((res, rej) => {
      resolveSettle = res;
      rejectSettle = rej;
    });
    promise.catch(() => {}); // a rejected turn is observed via waitForSettled
    a.settle = { promise, resolve: resolveSettle };

    queueMicrotask(() => {
      if (turn.error) {
        this.bus.emit(agentId, "error", turn.error);
        a.lastText = null;
        rejectSettle(turn.error);
        return;
      }
      for (const delta of turn.deltas ?? []) {
        this.bus.emit(agentId, "stream", delta);
      }
      const result: SettledResult = {
        aborted: turn.aborted ?? false,
        lastText: turn.lastText ?? null,
      };
      a.lastText = result.lastText;
      resolveSettle(result);
      this.bus.emit(agentId, "settled", result);
    });
  }

  async pushContext(agentId: string, text: string): Promise<void> {
    this.requireAgent(agentId);
    this.record("pushContext", agentId, text);
  }

  async waitForSettled(agentId: string, _timeoutMs: number): Promise<SettledResult> {
    const a = this.requireAgent(agentId);
    return a.settle ? a.settle.promise : { aborted: false, lastText: a.lastText };
  }

  async shutdown(agentId: string): Promise<void> {
    const a = this.requireAgent(agentId);
    a.shutdown = true;
    this.record("shutdown", agentId, undefined);
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
